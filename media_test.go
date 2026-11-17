package main

import (
	"diskvisor/internal/scanner"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestMediaPreviewAuthorizationAndRanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(path, []byte("0123456789"), 0600); err != nil {
		t.Fatal(err)
	}
	root := &scanner.FileNode{Path: dir, IsDir: true, Children: []scanner.FileNode{{Path: path, Name: "clip.mp4"}}}
	a := NewApp()
	a.fullRoot = root
	a.pathIndex = scanner.BuildPathIndex(root)
	if _, err := a.GetMediaPreview(filepath.Join(dir, "unscanned.mp4")); err == nil {
		t.Fatal("unscanned path accepted")
	}
	if _, err := a.GetMediaPreview(filepath.Join(dir, "script.svg")); err == nil {
		t.Fatal("active image format accepted")
	}
	p, err := a.GetMediaPreview(path)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, p.URL, nil)
	req.Header.Set("Range", "bytes=2-5")
	w := httptest.NewRecorder()
	a.serveMedia(w, req)
	if w.Code != http.StatusPartialContent || w.Body.String() != "2345" || w.Header().Get("Content-Range") != "bytes 2-5/10" {
		t.Fatalf("range failed: %d %s %s", w.Code, w.Body.String(), w.Header().Get("Content-Range"))
	}
	if w.Header().Get("Content-Type") != "video/mp4" {
		t.Fatal("missing media MIME type")
	}
	w = httptest.NewRecorder()
	a.serveMedia(w, httptest.NewRequest(http.MethodGet, "/media/../../clip.mp4", nil))
	if w.Code != http.StatusNotFound {
		t.Fatal("path traversal accepted")
	}
	w = httptest.NewRecorder()
	a.serveMedia(w, httptest.NewRequest(http.MethodPost, p.URL, nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatal("mutation method accepted")
	}
}
