package scanner

import (
	"encoding/binary"
	"testing"
)

func TestDecodeNTFSVolumeData(t *testing.T) {
	b := make([]byte, 96)
	le := binary.LittleEndian
	le.PutUint32(b[0x28:], 512)
	le.PutUint32(b[0x2c:], 4096)
	le.PutUint32(b[0x30:], 1024)
	le.PutUint32(b[0x34:], 1)
	le.PutUint64(b[0x38:], 1024*100)
	le.PutUint64(b[0x40:], 786432)
	v, err := decodeNTFSVolumeData(b)
	if err != nil || v.bytesPerCluster != 4096 || v.recordSize != 1024 || v.mftValidLen != 102400 || v.mftStartLCN != 786432 {
		t.Fatalf("geometry = %+v, %v", v, err)
	}
	if _, err := decodeNTFSVolumeData(b[:80]); err == nil {
		t.Fatal("accepted short response")
	}
	le.PutUint32(b[0x30:], 0)
	if _, err := decodeNTFSVolumeData(b); err == nil {
		t.Fatal("accepted zero record size")
	}
}
