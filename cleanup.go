package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// validateCleanupTarget is independent of remote AI advice. Reject ambiguous
// paths and links so frontend state cannot grant access to protected locations.
func validateCleanupTarget(path string) (string, error) {
	if !filepath.IsAbs(path) || strings.HasPrefix(path, `\\`) || strings.ContainsAny(path, "\x00*?") {
		return "", fmt.Errorf("cleanup requires an absolute local path")
	}
	target := filepath.Clean(path)
	if strings.Contains(strings.TrimPrefix(target, filepath.VolumeName(target)), ":") {
		return "", fmt.Errorf("alternate data streams are not cleanup targets")
	}
	if filepath.Dir(target) == target {
		return "", fmt.Errorf("drive roots cannot be cleaned")
	}
	volumeRoot := filepath.VolumeName(target) + string(filepath.Separator)
	for _, name := range []string{"Windows", "Program Files", "Program Files (x86)", "ProgramData", "Boot", "Recovery", "System Volume Information", "$Recycle.Bin", "$Extend"} {
		if withinPath(target, filepath.Join(volumeRoot, name)) {
			return "", fmt.Errorf("protected volume location")
		}
	}
	for _, name := range []string{"pagefile.sys", "hiberfil.sys", "swapfile.sys", "bootmgr", "bootnxt", "ntldr", "ntdetect.com"} {
		if strings.EqualFold(target, filepath.Join(volumeRoot, name)) {
			return "", fmt.Errorf("protected system file")
		}
	}
	for _, key := range []string{"SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"} {
		base := os.Getenv(key)
		if base != "" && withinPath(target, base) {
			return "", fmt.Errorf("protected system or application location: %s", target)
		}
	}
	for _, base := range []string{os.Getenv("USERPROFILE"), os.Getenv("APPDATA"), os.Getenv("LOCALAPPDATA")} {
		if base != "" && withinPath(base, target) {
			return "", fmt.Errorf("user profile containers cannot be cleaned")
		}
	}
	for current := target; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			return "", fmt.Errorf("linked or special cleanup targets are unsupported")
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	return target, nil
}

func withinPath(path, base string) bool {
	p := strings.ToLower(filepath.Clean(path))
	b := strings.ToLower(filepath.Clean(base))
	return p == b || strings.HasPrefix(p, b+string(filepath.Separator))
}
