package scanner

import (
	"encoding/binary"
	"fmt"
)

func decodeNTFSVolumeData(buf []byte) (ntfsVolumeData, error) {
	if len(buf) < 96 {
		return ntfsVolumeData{}, fmt.Errorf("short NTFS volume data")
	}
	le := binary.LittleEndian
	vd := ntfsVolumeData{
		bytesPerCluster: int64(le.Uint32(buf[0x2c:0x30])),
		recordSize:      int(le.Uint32(buf[0x30:0x34])),
		mftValidLen:     int64(le.Uint64(buf[0x38:0x40])),
		mftStartLCN:     int64(le.Uint64(buf[0x40:0x48])),
	}
	if vd.bytesPerCluster < 512 || vd.bytesPerCluster > 2*1024*1024 || vd.bytesPerCluster&(vd.bytesPerCluster-1) != 0 ||
		vd.recordSize < 512 || vd.recordSize > 64*1024 || vd.recordSize&(vd.recordSize-1) != 0 ||
		vd.mftValidLen <= 0 || vd.mftValidLen%int64(vd.recordSize) != 0 || vd.mftStartLCN <= 0 {
		return ntfsVolumeData{}, fmt.Errorf("invalid NTFS volume geometry")
	}
	return vd, nil
}
