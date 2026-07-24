package scanner

import (
	"encoding/binary"
	"testing"
	"unicode/utf16"
)

// buildFileNameRecord constructs a synthetic MFT FILE record containing a
// single resident $FILE_NAME attribute, so we can unit-test the offset math
// in parseRecord without a real Windows volume.
func buildFileNameRecord(recordIdx uint64, seq uint16, isDir bool, parentFRN uint64, name string, size int64) []byte {
	const recordSize = 1024
	buf := make([]byte, recordSize)
	le := binary.LittleEndian

	// FILE header
	le.PutUint32(buf[0:4], 0x454C4946) // "FILE"
	le.PutUint16(buf[0x10:0x12], seq)
	flags := uint16(0x0001) // in use
	if isDir {
		flags |= 0x0002
	}
	le.PutUint16(buf[0x16:0x18], flags)
	firstAttr := uint16(0x38)
	le.PutUint16(buf[0x14:0x16], firstAttr)

	// $FILE_NAME attribute (resident) starting at 0x38
	attrStart := 0x38
	le.PutUint32(buf[attrStart:attrStart+4], 0x30) // type $FILE_NAME
	buf[attrStart+0x08] = 0 // non-resident = 0 (resident)
	contentOffset := uint16(0x18)
	nameU16 := utf16.Encode([]rune(name))
	nameLen := len(nameU16)
	contentStart := attrStart + int(contentOffset)
	// $FILE_NAME content
	le.PutUint64(buf[contentStart:contentStart+8], parentFRN)
	le.PutUint64(buf[contentStart+0x30:contentStart+0x38], uint64(size))
	fileAttr := uint32(0)
	if isDir {
		fileAttr = 0x10
	}
	le.PutUint32(buf[contentStart+0x38:contentStart+0x3C], fileAttr)
	buf[contentStart+0x40] = byte(nameLen)
	buf[contentStart+0x41] = 1 // Win32 namespace
	copy(buf[contentStart+0x42:contentStart+0x42+nameLen*2], le16(nameU16))

	attrLen := uint32(0x18 + 0x42 + nameLen*2)
	le.PutUint32(buf[attrStart+4:attrStart+8], attrLen)
	le.PutUint16(buf[attrStart+0x16:attrStart+0x18], contentOffset)

	// End-of-attributes marker
	end := attrStart + int(attrLen)
	le.PutUint32(buf[end:end+4], 0xFFFFFFFF)
	return buf
}

func le16(s []uint16) []byte {
	out := make([]byte, len(s)*2)
	for i, v := range s {
		binary.LittleEndian.PutUint16(out[i*2:i*2+2], v)
	}
	return out
}

func TestParseRecord(t *testing.T) {
	buf := buildFileNameRecord(10, 1, false, 5, "hello.txt", 12345)
	e := parseRecord(buf, 10)
	if e == nil {
		t.Fatal("parseRecord returned nil")
	}
	if !e.inUse {
		t.Error("expected inUse true")
	}
	if e.name != "hello.txt" {
		t.Errorf("name = %q, want hello.txt", e.name)
	}
	if e.size != 12345 {
		t.Errorf("size = %d, want 12345", e.size)
	}
	if e.isDir {
		t.Error("expected isDir false")
	}
	if e.parentFRN != 5 {
		t.Errorf("parentFRN = %d, want 5", e.parentFRN)
	}
	if e.frn != 10|uint64(1)<<48 {
		t.Errorf("frn = %d, want %d", e.frn, 10|uint64(1)<<48)
	}
}

func TestParseRecordDirectory(t *testing.T) {
	buf := buildFileNameRecord(5, 3, true, 5, "root", 0)
	e := parseRecord(buf, 5)
	if !e.isDir {
		t.Error("expected isDir true for directory record")
	}
}

func TestParseRecordUnused(t *testing.T) {
	buf := buildFileNameRecord(99, 0, false, 1, "x", 0)
	// mark not in use
	binary.LittleEndian.PutUint16(buf[0x16:0x18], 0x0000)
	e := parseRecord(buf, 99)
	if e == nil || e.inUse {
		t.Error("expected inUse false for unused record")
	}
}

func TestBuildSubtree(t *testing.T) {
	entries := map[uint64]*mftEntry{
		5:  {frn: 5, parentFRN: 5, name: "root", size: 0, isDir: true, inUse: true},
		10: {frn: 10, parentFRN: 5, name: "a.txt", size: 100, isDir: false, inUse: true},
		11: {frn: 11, parentFRN: 5, name: "sub", size: 0, isDir: true, inUse: true},
		12: {frn: 12, parentFRN: 11, name: "b.txt", size: 50, isDir: false, inUse: true},
	}
	root := buildSubtree(5, `C:\root`, entries)
	t.Logf("root.Children = %d", len(root.Children))
	for _, c := range root.Children {
		t.Logf("  child: name=%q isDir=%v size=%d fc=%d subchildren=%d", c.Name, c.IsDir, c.Size, c.FileCount, len(c.Children))
	}
	if root == nil {
		t.Fatal("buildSubtree returned nil")
	}
	if root.Name != "root" {
		t.Errorf("root name = %q, want root", root.Name)
	}
	if root.Path != `C:\root` {
		t.Errorf("root path = %q, want C:\\root", root.Path)
	}
	if root.FileCount != 2 {
		t.Errorf("root.FileCount = %d, want 2", root.FileCount)
	}
	if root.Size != 150 {
		t.Errorf("root.Size = %d, want 150 (100 + 50)", root.Size)
	}
	if got := countDirsInTree(root); got != 2 {
		t.Errorf("dir count = %d, want 2 (root + sub)", got)
	}

	// Find "sub" and verify its size/child.
	var sub *FileNode
	for i := range root.Children {
		if root.Children[i].Name == "sub" {
			sub = &root.Children[i]
		}
	}
	if sub == nil {
		t.Fatal("sub directory not found")
	}
	if sub.Size != 50 {
		t.Errorf("sub.Size = %d, want 50", sub.Size)
	}
	if len(sub.Children) != 1 || sub.Children[0].Name != "b.txt" {
		t.Errorf("sub children = %+v, want [b.txt]", sub.Children)
	}
	if sub.Children[0].Path != `C:\root\sub\b.txt` {
		t.Errorf("child path = %q, want C:\\root\\sub\\b.txt", sub.Children[0].Path)
	}
}

func TestBuildSubtreeMissingRoot(t *testing.T) {
	entries := map[uint64]*mftEntry{
		10: {frn: 10, parentFRN: 5, name: "a", size: 1, isDir: false, inUse: true},
	}
	if root := buildSubtree(999, `C:\x`, entries); root != nil {
		t.Error("expected nil when root FRN missing")
	}
}
