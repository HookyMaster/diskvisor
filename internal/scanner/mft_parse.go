package scanner

import (
	"encoding/binary"
	"sort"
	"strings"
	"unicode/utf16"
)

// mftEntry holds the data we extract from a single MFT $FILE_NAME attribute.
type mftEntry struct {
	frn       uint64 // file reference number (record index | seq<<48)
	parentFRN uint64 // parent directory's file reference number
	name      string
	size      int64 // actual file size from $FILE_NAME
	isDir     bool
	inUse     bool
}

// parseRecord parses one MFT file record (the on-disk FILE structure) and
// extracts the $FILE_NAME attribute, which carries the parent reference, the
// file name, and the file's actual size.
//
// This is a best-effort parser: it only reads the $FILE_NAME attribute from the
// base MFT record. Files whose $FILE_NAME lives in an attribute-list extension
// record are skipped (rare). On any parse problem the record is ignored, and the
// caller's standard directory walk is used as a fallback.
//
// Record layout references (NTFS on-disk, little-endian):
//
//	FILE record header:
//	  +0x00  u32  Magic ("FILE" = 0x454C4946)
//	  +0x10  u16  SequenceNumber
//	  +0x14  u16  FirstAttributeOffset
//	  +0x16  u16  Flags (0x0001 = in use, 0x0002 = directory)
//	Attribute header (common):
//	  +0x00  u32  AttributeType (0x30 = $FILE_NAME)
//	  +0x04  u32  Length
//	  +0x08  u8   NonResidentFlag
//	  +0x16  u16  ResidentContentOffset (offset to content from attr start)
//	$FILE_NAME content:
//	  +0x00  u64  ParentDirectory (file reference)
//	  +0x30  u64  FileSize
//	  +0x38  u32  FileAttributes (0x10 = directory)
//	  +0x40  u8   FilenameLength (chars)
//	  +0x41  u8   FilenameNamespace (0 = POSIX)
//	  +0x42  u16[] Filename (UTF-16)
func parseRecord(buf []byte, recordIdx uint64) *mftEntry {
	if len(buf) < 0x42 {
		return nil
	}
	// Magic "FILE"
	if binary.LittleEndian.Uint32(buf[0:4]) != 0x454C4946 {
		return nil
	}
	seq := binary.LittleEndian.Uint16(buf[0x10:0x12])
	flags := binary.LittleEndian.Uint16(buf[0x16:0x18])
	if flags&0x0001 == 0 {
		// Record not in use
		return &mftEntry{inUse: false}
	}
	isDir := flags&0x0002 != 0
	firstAttr := int(binary.LittleEndian.Uint16(buf[0x14:0x16]))
	frn := recordIdx | (uint64(seq) << 48)

	e := &mftEntry{frn: frn, isDir: isDir, inUse: true}

	off := firstAttr
	for off+8 <= len(buf) {
		attrType := binary.LittleEndian.Uint32(buf[off : off+4])
		if attrType == 0xFFFFFFFF {
			break
		}
		attrLen := binary.LittleEndian.Uint32(buf[off+4 : off+8])
		if attrLen == 0 {
			break
		}
		if attrType == 0x30 { // $FILE_NAME
			if buf[off+8] != 0 { // non-resident: not expected for $FILE_NAME
				off += int(attrLen)
				continue
			}
			contentOff := int(binary.LittleEndian.Uint16(buf[off+0x16 : off+0x18]))
			c := off + contentOff
			if c+0x42 > len(buf) {
				off += int(attrLen)
				continue
			}
			parentFRN := binary.LittleEndian.Uint64(buf[c : c+8])
			fileSize := int64(binary.LittleEndian.Uint64(buf[c+0x30 : c+0x38]))
			fileAttr := binary.LittleEndian.Uint32(buf[c+0x38 : c+0x3C])
			nameLen := int(buf[c+0x40])
			nameNS := buf[c+0x41]
			if nameLen > 0 && c+0x42+nameLen*2 <= len(buf) {
				u16 := make([]uint16, nameLen)
				for i := 0; i < nameLen; i++ {
					u16[i] = binary.LittleEndian.Uint16(buf[c+0x42+i*2 : c+0x42+i*2+2])
				}
				name := string(utf16.Decode(u16))
				// Prefer a Win32/long name (namespace != 0 POSIX). Keep the
				// first name found, but upgrade if we encounter a non-POSIX one.
				if e.name == "" || nameNS != 0 {
					e.name = name
					e.parentFRN = parentFRN
					e.size = fileSize
					e.isDir = fileAttr&0x10 != 0
				}
			}
		}
		off += int(attrLen)
	}

	if e.name == "" {
		return &mftEntry{frn: frn, isDir: isDir, inUse: true}
	}
	return e
}

// buildSubtree reconstructs the directory tree rooted at rootFRN using the
// parent→child links collected from the MFT. Only descendants of rootFRN are
// included; full OS paths are reconstructed so the AI analyzer can use them.
//
// It is built bottom-up: a stack produces nodes in parent-before-child order,
// then a reverse pass materializes each node's value AFTER its children are
// complete. This avoids the value-copy staleness you get from appending a copy
// of a child into a parent's slice and later mutating the child's own children.
// Directory sizes and file counts are computed in that same reverse pass.
func buildSubtree(rootFRN uint64, rootPath string, entries map[uint64]*mftEntry) *FileNode {
	if _, ok := entries[rootFRN]; !ok {
		return nil
	}

	// parent FRN -> child FRNs
	children := make(map[uint64][]uint64, len(entries))
	for frn, e := range entries {
		children[e.parentFRN] = append(children[e.parentFRN], frn)
	}

	// Pass 1: create value nodes in discovery order (parent before child),
	// setting paths as we go.
	created := make(map[uint64]*FileNode, len(entries))
	orderNodes := make([]*FileNode, 0, len(entries))
	orderFRN := make([]uint64, 0, len(entries))
	visited := map[uint64]bool{rootFRN: true}

	rootNode := &FileNode{
		Name:  entries[rootFRN].name,
		Path:  rootPath,
		IsDir: entries[rootFRN].isDir,
		Size:  entries[rootFRN].size,
	}
	created[rootFRN] = rootNode
	orderNodes = append(orderNodes, rootNode)
	orderFRN = append(orderFRN, rootFRN)

	stack := []uint64{rootFRN}
	for len(stack) > 0 {
		frn := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		parent := created[frn]
		for _, c := range children[frn] {
			if c == frn || visited[c] { // skip self-references / cycles
				continue
			}
			visited[c] = true
			e := entries[c]
			child := &FileNode{
				Name:  e.name,
				Path:  parent.Path + "\\" + e.name,
				IsDir: e.isDir,
				Size:  e.size,
			}
			created[c] = child
			orderNodes = append(orderNodes, child)
			orderFRN = append(orderFRN, c)
			stack = append(stack, c)
		}
	}

	// Pass 2: materialize value nodes bottom-up (children before parents),
	// copying already-complete children into each parent.
	built := make(map[uint64]*FileNode, len(orderNodes))
	for i := len(orderNodes) - 1; i >= 0; i-- {
		frn := orderFRN[i]
		src := created[frn]
		vn := &FileNode{
			Name:  src.Name,
			Path:  src.Path,
			IsDir: src.IsDir,
			Size:  src.Size,
		}
		for _, c := range children[frn] {
			if c == frn {
				continue
			}
			if cv, ok := built[c]; ok {
				vn.Children = append(vn.Children, *cv)
			}
		}
		if vn.IsDir {
			var sum, fc int64
			for j := range vn.Children {
				sum += vn.Children[j].Size
				fc += vn.Children[j].FileCount
			}
			vn.Size = sum
			vn.FileCount = fc
		} else {
			vn.FileCount = 1
		}
		built[frn] = vn
	}

	root := built[rootFRN]
	root.Name = winBase(rootPath)
	root.Path = rootPath
	sortChildrenBySize(root)
	return root
}

// winBase returns the last path component for a Windows-style path.
func winBase(p string) string {
	if i := strings.LastIndexAny(p, "\\/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// sortChildrenBySize recursively sorts children by size descending.
func sortChildrenBySize(n *FileNode) {
	sort.SliceStable(n.Children, func(i, j int) bool {
		return n.Children[i].Size > n.Children[j].Size
	})
	for i := range n.Children {
		c := &n.Children[i]
		sortChildrenBySize(c)
	}
}

// countDirsInTree counts the number of directory nodes (includes the root).
func countDirsInTree(n *FileNode) int64 {
	var c int64
	if n.IsDir {
		c = 1
	}
	for i := range n.Children {
		c += countDirsInTree(&n.Children[i])
	}
	return c
}
