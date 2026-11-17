//go:build windows

package scanner

import (
	"encoding/binary"
	"errors"
	"strings"

	"golang.org/x/sys/windows"
)

// fsctlGetNtfsVolumeData = FSCTL_GET_NTFS_VOLUME_DATA
// CTL_CODE(FILE_DEVICE_FILE_SYSTEM, 25, METHOD_BUFFERED, FILE_ANY_ACCESS) = 0x00090064
const fsctlGetNtfsVolumeData = 0x00090064

// ntfsVolumeData holds the MFT geometry we need from NTFS_VOLUME_DATA_BUFFER.
type ntfsVolumeData struct {
	bytesPerCluster int64
	recordSize      int
	mftValidLen     int64 // valid data length of the MFT, in bytes
	mftStartLCN     int64 // logical cluster number of the MFT start
}

// tryScanMFT reads the NTFS Master File Table for the volume containing
// rootPath and builds the file tree for the subtree under rootPath.
//
// This is the fast path (what WizTree does): instead of walking the directory
// tree with millions of random I/Os, we read the MFT sequentially from disk —
// one pass, in file order — and reconstruct the tree from each record's
// $FILE_NAME attribute (parent reference + name + size).
//
// It requires administrator privileges (opening the raw volume handle) and an
// NTFS volume. On any failure it returns an error so the caller can fall back
// to the standard directory walk.
func (s *Scanner) tryScanMFT(rootPath string) (*FileNode, error) {
	if !isNTFS(rootPath) {
		return nil, errors.New("not an NTFS volume")
	}

	rootFRN, err := getFileReferenceNumber(rootPath)
	if err != nil {
		return nil, err
	}

	vol := volumeFromPath(rootPath)
	hVol, err := windows.CreateFile(
		windows.StringToUTF16Ptr(vol),
		windows.FILE_READ_DATA,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		0,
		0,
	)
	if err != nil {
		return nil, err
	}
	defer windows.Close(hVol)

	vd, err := getNTFSVolumeData(hVol)
	if err != nil {
		return nil, err
	}
	// Sequential raw reads are safe only after verifying the MFT occupies one
	// extent. Unsupported or fragmented volumes use the directory walker.
	if err := verifyContiguousMFT(rootPath, vd); err != nil {
		return nil, err
	}

	entries, err := s.readMFT(hVol, vd)
	if err != nil {
		return nil, err
	}

	root := buildSubtree(rootFRN, rootPath, entries)
	if root == nil {
		return nil, errors.New("root not found in MFT")
	}

	// Populate atomic counters for the final progress report.
	s.files.Store(root.FileCount)
	s.size.Store(root.Size)
	s.dirs.Store(countDirsInTree(root))

	return root, nil
}

// volumeFromPath returns the raw volume device path, e.g. "\\.\C:" for "C:\foo".
func volumeFromPath(path string) string {
	if len(path) >= 2 && path[1] == ':' {
		return "\\\\.\\" + string(path[0]) + ":"
	}
	return path
}

// isNTFS reports whether the volume holding path is formatted as NTFS.
func isNTFS(path string) bool {
	if len(path) < 2 || path[1] != ':' {
		return false
	}
	drive := string(path[0]) + ":\\"
	var fsBuf [256]uint16
	err := windows.GetVolumeInformation(
		windows.StringToUTF16Ptr(drive),
		nil, 0,
		nil, nil, nil,
		&fsBuf[0], uint32(len(fsBuf)),
	)
	if err != nil {
		return false
	}
	return strings.EqualFold(windows.UTF16ToString(fsBuf[:]), "NTFS")
}

// getNTFSVolumeData fetches MFT location/sizing via FSCTL_GET_NTFS_VOLUME_DATA.
func getNTFSVolumeData(hVol windows.Handle) (ntfsVolumeData, error) {
	out := make([]byte, 144)
	var bytesReturned uint32
	err := windows.DeviceIoControl(hVol, fsctlGetNtfsVolumeData, nil, 0, &out[0], uint32(len(out)), &bytesReturned, nil)
	if err != nil {
		return ntfsVolumeData{}, err
	}
	return decodeNTFSVolumeData(out[:bytesReturned])
}

// getFileReferenceNumber returns the NTFS file reference number (FRN) of path,
// which matches the value stored in $FILE_NAME parent references inside the MFT.
func getFileReferenceNumber(path string) (uint64, error) {
	h, err := windows.CreateFile(
		windows.StringToUTF16Ptr(path),
		windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return 0, err
	}
	defer windows.Close(h)

	var fi windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &fi); err != nil {
		return 0, err
	}
	return uint64(fi.FileIndexHigh)<<32 | uint64(fi.FileIndexLow), nil
}

// readMFT reads the MFT sequentially in large blocks, parses each record, and
// returns a map of file reference number → parsed entry for the whole volume.
// The caller filters down to the requested subtree.
func (s *Scanner) readMFT(hVol windows.Handle, vd ntfsVolumeData) (map[uint64]*mftEntry, error) {
	if vd.recordSize <= 0 || vd.bytesPerCluster <= 0 {
		return nil, errors.New("invalid MFT geometry")
	}
	mftStartByte := vd.mftStartLCN * vd.bytesPerCluster
	totalRecords := vd.mftValidLen / int64(vd.recordSize)
	if totalRecords <= 0 {
		return nil, errors.New("MFT has no records")
	}

	entries := make(map[uint64]*mftEntry)
	const blockSize = 8 * 1024 * 1024
	buf := make([]byte, blockSize)
	recordsPerBlock := blockSize / vd.recordSize
	if recordsPerBlock == 0 {
		return nil, errors.New("MFT record exceeds block size")
	}

	for recIdx := int64(0); recIdx < totalRecords; recIdx += int64(recordsPerBlock) {
		readOffset := mftStartByte + recIdx*int64(vd.recordSize)
		want := len(buf)
		if remaining := vd.mftValidLen - recIdx*int64(vd.recordSize); remaining < int64(want) {
			want = int(remaining)
		}
		n, err := readAt(hVol, readOffset, buf[:want])
		if err != nil || n != want {
			// Stop on a read error or a short read — the rest would be garbage.
			return nil, errors.New("incomplete MFT read")
		}
		count := n / vd.recordSize
		for i := 0; i < count && recIdx+int64(i) < totalRecords; i++ {
			base := i * vd.recordSize
			record := buf[base:base+vd.recordSize]
			if binary.LittleEndian.Uint32(record[:4]) != 0x454c4946 { continue }
			if !restoreRecordSectors(record) { return nil, errors.New("MFT sector fixup failed") }
			e := parseRecord(record, uint64(recIdx)+uint64(i))
			if e != nil && e.inUse && e.name != "" {
				entries[e.frn] = e
			}
		}
		if recIdx%(int64(recordsPerBlock)*10) < int64(recordsPerBlock) {
			s.maybeEmitProgress("scanning", totalRecords, float64(recIdx)/float64(totalRecords)*100, "")
		}
	}
	return entries, nil
}

func verifyContiguousMFT(path string, vd ntfsVolumeData) error {
	h, err := windows.CreateFile(windows.StringToUTF16Ptr(path[:2]+`\$MFT`), windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return err
	}
	defer windows.Close(h)
	input := make([]byte, 8)
	out := make([]byte, 4096)
	var n uint32
	const fsctlGetRetrievalPointers = 0x00090073
	if err := windows.DeviceIoControl(h, fsctlGetRetrievalPointers, &input[0], 8, &out[0], uint32(len(out)), &n, nil); err != nil {
		return err
	}
	le := binary.LittleEndian
	if n < 32 || le.Uint32(out[:4]) != 1 || le.Uint64(out[8:16]) != 0 ||
		int64(le.Uint64(out[24:32])) != vd.mftStartLCN ||
		le.Uint64(out[16:24]) < uint64((vd.mftValidLen+vd.bytesPerCluster-1)/vd.bytesPerCluster) {
		return errors.New("fragmented or unverifiable MFT; use directory scan")
	}
	return nil
}

// readAt seeks to offset on the volume handle and fills buf (handling partial
// reads), returning the total bytes read.
func readAt(h windows.Handle, offset int64, buf []byte) (int, error) {
	if _, err := windows.Seek(h, offset, 0); err != nil {
		return 0, err
	}
	var total int
	for total < len(buf) {
		var n uint32
		if err := windows.ReadFile(h, buf[total:], &n, nil); err != nil {
			if total == 0 {
				return 0, err
			}
			break
		}
		if n == 0 {
			break
		}
		total += int(n)
	}
	return total, nil
}
