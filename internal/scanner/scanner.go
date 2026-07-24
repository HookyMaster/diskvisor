package scanner

import (
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// ProgressFunc is called periodically during scanning.
// files/dirs/size are running totals; totalFiles is the estimate from pass 1.
// percent is 0-100 (0 during pass 1, calculated during pass 2).
type ProgressFunc func(stage string, files, dirs, size, totalFiles int64, percent float64, currentPath string)

// FileNode represents a file or directory in the scanned tree.
type FileNode struct {
	Name      string     `json:"name"`
	Path      string     `json:"path"`
	Size      int64      `json:"size"`
	IsDir     bool       `json:"is_dir"`
	FileCount int64      `json:"file_count"`
	Modified  int64      `json:"modified"` // Unix timestamp
	Children  []FileNode `json:"children,omitempty"`
}

// Scanner scans directories and builds a size-annotated tree.
type Scanner struct {
	workers  int
	progress ProgressFunc

	// Atomic counters for progress reporting
	files    atomic.Int64
	dirs     atomic.Int64
	size     atomic.Int64
	lastEmit atomic.Int64 // nanoseconds of last progress emit

	// lastMethod records which scan path produced the last result:
	// "mft" (fast NTFS MFT read) or "walk" (standard directory walk).
	lastMethod string
}

// LastMethod returns the scan method used by the most recent Scan call.
func (s *Scanner) LastMethod() string {
	return s.lastMethod
}

// New creates a scanner with a default worker count.
func New() *Scanner {
	return &Scanner{
		workers: runtime.NumCPU(),
	}
}

// SetProgressFunc sets a callback that is called periodically during scanning.
func (s *Scanner) SetProgressFunc(fn ProgressFunc) {
	s.progress = fn
}

// maybeEmitProgress calls the progress callback at most once per 50ms.
func (s *Scanner) maybeEmitProgress(stage string, totalFiles int64, percent float64, currentPath string) {
	if s.progress == nil {
		return
	}
	now := time.Now().UnixNano()
	last := s.lastEmit.Load()
	if now-last < int64(50*time.Millisecond) {
		return
	}
	s.lastEmit.Store(now)
	s.progress(stage, s.files.Load(), s.dirs.Load(), s.size.Load(), totalFiles, percent, currentPath)
}

// Scan scans the given directory path and returns a FileNode tree.
//
// For directories it first attempts the fast NTFS MFT scan (tryScanMFT): a
// single sequential read of the volume's Master File Table, which is orders of
// magnitude faster than walking the directory tree. That path requires an
// NTFS volume and administrator privileges. On any failure (non-NTFS, no
// admin, parser miss) it transparently falls back to the standard two-pass
// directory walk.
func (s *Scanner) Scan(rootPath string) (*FileNode, error) {
	// Reset counters
	s.files.Store(0)
	s.dirs.Store(0)
	s.size.Store(0)
	s.lastEmit.Store(0)
	s.lastMethod = "walk"

	info, err := os.Stat(rootPath)
	if err != nil {
		return nil, err
	}

	node := &FileNode{
		Name:     winBase(rootPath),
		Path:     rootPath,
		IsDir:    info.IsDir(),
		Modified: info.ModTime().Unix(),
	}

	if !info.IsDir() {
		node.Size = info.Size()
		node.FileCount = 1
		s.files.Store(1)
		s.size.Store(info.Size())
		s.maybeEmitProgress("scanning", 1, 100, rootPath)
		return node, nil
	}

	// --- Fast path: read the MFT directly (Windows/NTFS, needs admin) ---
	if mftNode, mftErr := s.tryScanMFT(rootPath); mftErr == nil && mftNode != nil {
		s.lastMethod = "mft"
		s.lastEmit.Store(0)
		s.maybeEmitProgress("scanning", s.files.Load(), 100, rootPath)
		return mftNode, nil
	}

	// --- Fallback: two-pass directory walk ---
	// Pass 1: Count total files (fast, no stat)
	s.maybeEmitProgress("counting", 0, 0, rootPath)
	totalFiles := s.countFiles(rootPath)

	// Reset counters for pass 2
	s.files.Store(0)
	s.dirs.Store(0)
	s.size.Store(0)
	s.lastEmit.Store(0)
	s.dirs.Add(1) // root dir

	// Pass 2: Full scan with sizes
	s.maybeEmitProgress("scanning", totalFiles, 0, rootPath)
	s.scanDir(node, totalFiles)

	// Final progress emit
	if s.progress != nil {
		s.progress("scanning", s.files.Load(), s.dirs.Load(), s.size.Load(), totalFiles, 100.0, rootPath)
	}

	return node, nil
}

// countFiles does a fast recursive walk using filepath.WalkDir.
// No stat calls — just counts file entries (not directories).
// Single-threaded but reliable; ReadDir is I/O-bound and fast enough
// for counting. The previous worker-pool version could deadlock when
// workers sent subdirs back into the same buffered channel they read
// from, causing the count to never complete.
func (s *Scanner) countFiles(rootPath string) int64 {
	var total int64
	filepath.WalkDir(rootPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip inaccessible entries
		}
		if !d.IsDir() {
			total++
		}
		// Emit progress every 2000 files; maybeEmitProgress throttles to 50ms
		if total%2000 == 0 {
			s.maybeEmitProgress("counting", total, 0, path)
		}
		return nil
	})
	// Final emit with the complete count
	s.maybeEmitProgress("counting", total, 0, rootPath)
	return total
}

// scanDir recursively scans a directory, computing sizes and file counts.
// It uses a worker pool for parallel directory traversal.
// totalFiles is the estimate from pass 1 for progress calculation.
func (s *Scanner) scanDir(node *FileNode, totalFiles int64) {
	entries, err := os.ReadDir(node.Path)
	if err != nil {
		return
	}

	type job struct {
		index int
		entry os.DirEntry
	}

	jobs := make(chan job, len(entries))
	results := make(chan struct {
		index int
		node  FileNode
	}, len(entries))

	var wg sync.WaitGroup

	// Launch workers
	for w := 0; w < s.workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				childNode := s.processEntry(j.entry, node.Path, totalFiles)
				results <- struct {
					index int
					node  FileNode
				}{j.index, childNode}
			}
		}()
	}

	// Send jobs
	for i, entry := range entries {
		jobs <- job{index: i, entry: entry}
	}
	close(jobs)

	// Wait for all workers to finish
	go func() {
		wg.Wait()
		close(results)
	}()

	// Collect results
	childNodes := make([]FileNode, len(entries))
	for r := range results {
		childNodes[r.index] = r.node
	}

	// Sum up sizes and build children list
	var totalSize int64
	var totalFileCount int64
	var children []FileNode
	for _, child := range childNodes {
		totalSize += child.Size
		totalFileCount += child.FileCount
		// Only include non-empty children
		if child.Size > 0 || child.IsDir {
			children = append(children, child)
		}
	}

	node.Size = totalSize
	node.FileCount = totalFileCount
	node.Children = children
}

// processEntry processes a single directory entry and returns a FileNode.
func (s *Scanner) processEntry(entry os.DirEntry, parentPath string, totalFiles int64) FileNode {
	fullPath := filepath.Join(parentPath, entry.Name())
	info, err := entry.Info()
	if err != nil {
		return FileNode{
			Name:  entry.Name(),
			Path:  fullPath,
			IsDir: entry.IsDir(),
		}
	}

	node := FileNode{
		Name:     entry.Name(),
		Path:     fullPath,
		IsDir:    entry.IsDir(),
		Modified: info.ModTime().Unix(),
	}

	if !entry.IsDir() {
		node.Size = info.Size()
		node.FileCount = 1
		// Update atomic counters
		s.files.Add(1)
		s.size.Add(info.Size())
		// Calculate percent
		pct := 0.0
		if totalFiles > 0 {
			pct = float64(s.files.Load()) / float64(totalFiles) * 100
		}
		s.maybeEmitProgress("scanning", totalFiles, pct, fullPath)
		return node
	}

	// Directory: increment dir counter and recurse
	s.dirs.Add(1)
	pct := 0.0
	if totalFiles > 0 {
		pct = float64(s.files.Load()) / float64(totalFiles) * 100
	}
	s.maybeEmitProgress("scanning", totalFiles, pct, fullPath)

	// Recursively scan subdirectory
	s.scanDir(&node, totalFiles)
	return node
}

// FlatEntry is a flattened representation of a file node for quick lookup.
type FlatEntry struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	IsDir     bool   `json:"is_dir"`
	FileCount int64  `json:"file_count"`
	Modified  int64  `json:"modified"`
	Depth     int    `json:"depth"`
}

// Flatten converts a FileNode tree into a flat slice, useful for treemap rendering.
func Flatten(node *FileNode, depth int) []FlatEntry {
	var result []FlatEntry
	result = append(result, FlatEntry{
		Path:      node.Path,
		Name:      node.Name,
		Size:      node.Size,
		IsDir:     node.IsDir,
		FileCount: node.FileCount,
		Modified:  node.Modified,
		Depth:     depth,
	})
	for _, child := range node.Children {
		result = append(result, Flatten(&child, depth+1)...)
	}
	return result
}

// ClonePruned returns a copy of the tree truncated to maxDepth levels.
// Nodes at maxDepth keep their metadata (size, file_count) but have Children
// set to nil, so the pruned tree can be serialized to the frontend without
// transmitting the full scan result. maxDepth=0 returns a leaf node;
// maxDepth=1 returns root + direct children (as leaves), etc.
func ClonePruned(node *FileNode, maxDepth int) *FileNode {
	clone := &FileNode{
		Name:      node.Name,
		Path:      node.Path,
		Size:      node.Size,
		IsDir:     node.IsDir,
		FileCount: node.FileCount,
		Modified:  node.Modified,
	}
	if maxDepth > 0 {
		clone.Children = make([]FileNode, len(node.Children))
		for i := range node.Children {
			c := ClonePruned(&node.Children[i], maxDepth-1)
			clone.Children[i] = *c
		}
	}
	return clone
}

// FindByPath searches the tree for a node with the given path.
// Returns nil if not found. For large trees prefer a path index (BuildPathIndex).
func FindByPath(root *FileNode, path string) *FileNode {
	if root.Path == path {
		return root
	}
	for i := range root.Children {
		if found := FindByPath(&root.Children[i], path); found != nil {
			return found
		}
	}
	return nil
}

// BuildPathIndex creates a path → node map over the tree. Only directories are
// indexed (files are never expanded lazily), keeping the index compact even for
// scans with millions of files.
func BuildPathIndex(root *FileNode) map[string]*FileNode {
	idx := make(map[string]*FileNode, 4096)
	var walk func(n *FileNode)
	walk = func(n *FileNode) {
		if n.IsDir {
			idx[n.Path] = n
		}
		for i := range n.Children {
			walk(&n.Children[i])
		}
	}
	walk(root)
	return idx
}
