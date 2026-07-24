//go:build !windows

package main

import "fmt"

// moveToRecycleBinNative is a no-op stub for non-Windows platforms where the
// Windows Recycle Bin API is unavailable.
func moveToRecycleBinNative(absPath string) error {
	return fmt.Errorf("recycle bin is only supported on Windows")
}
