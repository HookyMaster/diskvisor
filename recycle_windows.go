//go:build windows

package main

import (
	"fmt"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	foDelete     = 0x0003
	fofAllowUndo = 0x0040 // send to Recycle Bin instead of permanent delete
	fofSilent    = 0x0004
	fofNoConfirm = 0x0010
	fofNoErrorUI = 0x0400
)

var modShell32 = windows.NewLazySystemDLL("shell32.dll")
var procSHFileOperationW = modShell32.NewProc("SHFileOperationW")

type shFileOpStructW struct {
	hwnd                  windows.HWND
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         windows.Handle
	lpszProgressTitle     *uint16
}

// moveToRecycleBinNative sends a file or directory to the Windows Recycle Bin
// using the native SHFileOperationW API. No external process is spawned, so no
// console window (e.g. PowerShell) ever pops up.
func moveToRecycleBinNative(absPath string) error {
	// SHFileOperationW requires a double-NUL-terminated list of paths.
	// Build the UTF-16 slice manually — appending a Go string "\x00" trips
	// syscall.UTF16FromString's embedded-NUL check and fails with EINVAL.
	u16 := utf16.Encode([]rune(absPath))
	u16 = append(u16, 0, 0)
	pFrom := &u16[0]

	op := shFileOpStructW{
		hwnd:   0,
		wFunc:  foDelete,
		pFrom:  pFrom,
		fFlags: fofAllowUndo | fofSilent | fofNoConfirm | fofNoErrorUI,
	}

	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 {
		return fmt.Errorf("SHFileOperation failed (code %d)", r)
	}
	if op.fAnyOperationsAborted != 0 {
		return fmt.Errorf("recycle operation was aborted")
	}
	return nil
}
