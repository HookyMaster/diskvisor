package scanner

import "encoding/binary"

// NTFS replaces sector tails with an update sequence number on disk.
// Restore them before interpreting attribute bytes crossing a sector boundary.
func restoreRecordSectors(record []byte) bool {
	if len(record) < 8 {
		return false
	}
	le := binary.LittleEndian
	offset := int(le.Uint16(record[4:6]))
	count := int(le.Uint16(record[6:8]))
	if count < 2 || offset < 8 || offset+count*2 > len(record) || len(record)%(count-1) != 0 {
		return false
	}
	sector := len(record) / (count - 1)
	if sector < 512 || sector&(sector-1) != 0 || offset+count*2 > sector-2 {
		return false
	}
	sequence := le.Uint16(record[offset : offset+2])
	for i := 1; i < count; i++ {
		tail := i*sector - 2
		if le.Uint16(record[tail:tail+2]) != sequence {
			return false
		}
	}
	for i := 1; i < count; i++ {
		copy(record[i*sector-2:i*sector], record[offset+i*2:offset+i*2+2])
	}
	return true
}
