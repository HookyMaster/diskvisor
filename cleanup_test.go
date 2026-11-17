package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCleanupProtection(t *testing.T) {
	dir := t.TempDir()
	protected := filepath.Join(dir, "Windows")
	if err := os.Mkdir(protected, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SystemRoot", protected)
	for _, path := range []string{"", ".", filepath.VolumeName(dir) + `\`, protected, filepath.Join(protected, "Temp")} {
		if _, err := validateCleanupTarget(path); err == nil {
			t.Errorf("accepted protected path %q", path)
		}
	}
	file := filepath.Join(dir, "ordinary.txt")
	if err := os.WriteFile(file, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := validateCleanupTarget(file); err != nil {
		t.Fatal(err)
	}
	if withinPath(protected+"Backup", protected) {
		t.Fatal("prefix collision")
	}
}
