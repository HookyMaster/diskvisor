package scanner

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCountFiles verifies that countFiles correctly counts all files
// (not directories) in a directory tree.
func TestCountFiles(t *testing.T) {
	// Create a temp directory structure:
	// root/
	//   file1.txt
	//   file2.txt
	//   subdir1/
	//     file3.txt
	//     file4.txt
	//     deep/
	//       file5.txt
	//   subdir2/
	//     file6.txt
	tmp := t.TempDir()

	dirs := []string{
		tmp,
		filepath.Join(tmp, "subdir1"),
		filepath.Join(tmp, "subdir1", "deep"),
		filepath.Join(tmp, "subdir2"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}

	files := []string{
		filepath.Join(tmp, "file1.txt"),
		filepath.Join(tmp, "file2.txt"),
		filepath.Join(tmp, "subdir1", "file3.txt"),
		filepath.Join(tmp, "subdir1", "file4.txt"),
		filepath.Join(tmp, "subdir1", "deep", "file5.txt"),
		filepath.Join(tmp, "subdir2", "file6.txt"),
	}
	for _, f := range files {
		if err := os.WriteFile(f, []byte("test"), 0644); err != nil {
			t.Fatal(err)
		}
	}

	s := New()
	got := s.countFiles(tmp)
	want := int64(len(files))
	if got != want {
		t.Errorf("countFiles() = %d, want %d", got, want)
	}
}

// TestCountFilesEmpty verifies empty directory returns 0.
func TestCountFilesEmpty(t *testing.T) {
	tmp := t.TempDir()
	s := New()
	got := s.countFiles(tmp)
	if got != 0 {
		t.Errorf("countFiles(empty dir) = %d, want 0", got)
	}
}

// TestScanWithCountFiles verifies the full two-pass scan produces
// correct file counts (the "统计为0" regression test).
func TestScanWithCountFiles(t *testing.T) {
	tmp := t.TempDir()

	// Create structure
	dirs := []string{
		filepath.Join(tmp, "a", "b", "c"),
		filepath.Join(tmp, "x", "y"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}

	files := []string{
		filepath.Join(tmp, "root.txt"),
		filepath.Join(tmp, "a", "a1.txt"),
		filepath.Join(tmp, "a", "b", "b1.txt"),
		filepath.Join(tmp, "a", "b", "c", "deep.txt"),
		filepath.Join(tmp, "x", "y", "deep2.txt"),
	}
	for _, f := range files {
		if err := os.WriteFile(f, []byte("hello"), 0644); err != nil {
			t.Fatal(err)
		}
	}

	s := New()
	root, err := s.Scan(tmp)
	if err != nil {
		t.Fatalf("Scan() error: %v", err)
	}

	if root.FileCount != int64(len(files)) {
		t.Errorf("Scan() FileCount = %d, want %d", root.FileCount, int64(len(files)))
	}
}
