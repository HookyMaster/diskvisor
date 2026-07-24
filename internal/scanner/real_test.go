package scanner

import (
	"os"
	"testing"
)

func countDirs(n *FileNode) int {
	c := 1
	for i := range n.Children {
		c += countDirs(&n.Children[i])
	}
	return c
}

// TestRealScan scans the actual scanner package directory tree
// to verify countFiles + Scan produce non-zero, consistent results.
func TestRealScan(t *testing.T) {
	cwd, _ := os.Getwd()
	t.Logf("scanning real path: %s", cwd)

	s := New()
	n := s.countFiles(cwd)
	t.Logf("countFiles returned: %d", n)

	root, err := s.Scan(cwd)
	if err != nil {
		t.Fatalf("Scan() error: %v", err)
	}

	t.Logf("root.FileCount = %d, root.Size = %d, total dirs = %d", root.FileCount, root.Size, countDirs(root))

	if n == 0 {
		t.Errorf("countFiles returned 0 on a non-empty directory")
	}
	if root.FileCount == 0 {
		t.Errorf("Scan root.FileCount is 0 on a non-empty directory")
	}
	if n != root.FileCount {
		t.Errorf("countFiles (%d) != root.FileCount (%d)", n, root.FileCount)
	}
}
