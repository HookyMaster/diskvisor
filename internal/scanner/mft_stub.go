//go:build !windows

package scanner

import "errors"

// tryScanMFT is only available on Windows/NTFS. On other platforms it returns
// an error so Scanner.Scan falls back to the standard directory walk.
func (s *Scanner) tryScanMFT(rootPath string) (*FileNode, error) {
	return nil, errors.New("MFT scan is only supported on Windows")
}
