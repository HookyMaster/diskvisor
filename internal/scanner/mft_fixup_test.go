package scanner

import (
	"encoding/binary"
	"testing"
)

func TestRestoreRecordSectors(t *testing.T) {
	b := make([]byte, 1024)
	le := binary.LittleEndian
	le.PutUint16(b[4:], 48)
	le.PutUint16(b[6:], 3)
	le.PutUint16(b[48:], 0xabcd)
	le.PutUint16(b[50:], 0x1234)
	le.PutUint16(b[52:], 0x5678)
	le.PutUint16(b[510:], 0xabcd)
	le.PutUint16(b[1022:], 0xabcd)
	if !restoreRecordSectors(b) || le.Uint16(b[510:]) != 0x1234 || le.Uint16(b[1022:]) != 0x5678 {
		t.Fatal("sector restoration failed")
	}
	if restoreRecordSectors(b) {
		t.Fatal("accepted mismatched sequence")
	}
	if restoreRecordSectors(b[:7]) {
		t.Fatal("accepted truncated record")
	}
}
