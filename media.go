package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type MediaPreview struct {
	URL  string `json:"url"`
	Kind string `json:"kind"`
	Name string `json:"name"`
}

func mediaType(path string) (kind, mime string) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image", "image/png"
	case ".jpg", ".jpeg":
		return "image", "image/jpeg"
	case ".gif":
		return "image", "image/gif"
	case ".webp":
		return "image", "image/webp"
	case ".bmp":
		return "image", "image/bmp"
	case ".avif":
		return "image", "image/avif"
	case ".mp4", ".m4v":
		return "video", "video/mp4"
	case ".webm":
		return "video", "video/webm"
	case ".ogv":
		return "video", "video/ogg"
	case ".mov":
		return "video", "video/quicktime"
	case ".txt", ".md", ".markdown", ".log", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".csv", ".tsv", ".ini", ".cfg", ".conf", ".toml", ".go", ".js", ".ts", ".jsx", ".tsx", ".css", ".scss", ".html", ".htm", ".py", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh", ".bat", ".ps1", ".sql", ".vue", ".svelte", ".env":
		return "text", "text/plain; charset=utf-8"
	}
	switch strings.ToLower(filepath.Base(path)) {
	case "readme", "license", "dockerfile", "makefile", ".gitignore", ".editorconfig":
		return "text", "text/plain; charset=utf-8"
	}
	return "", ""
}

// GetMediaPreview grants an opaque URL for a file from the current scan only.
// It never returns raw file URLs or copies entire videos across the JS bridge.
func (a *App) GetMediaPreview(path string) (*MediaPreview, error) {
	kind, _ := mediaType(path)
	if kind == "" {
		return nil, fmt.Errorf("此格式暂不支持预览，可通过「打开位置」查看")
	}
	a.treeMu.RLock()
	parent := a.pathIndex[filepath.Dir(path)]
	found := a.fullRoot != nil && !a.fullRoot.IsDir && strings.EqualFold(a.fullRoot.Path, path)
	if parent != nil {
		for i := range parent.Children {
			if !parent.Children[i].IsDir && strings.EqualFold(parent.Children[i].Path, path) {
				found = true
				break
			}
		}
	}
	a.treeMu.RUnlock()
	if !found {
		return nil, fmt.Errorf("preview target is not in the current scan")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("preview requires a regular file")
	}
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(nonce[:])
	a.previewMu.Lock()
	if a.previews == nil || len(a.previews) >= 64 {
		a.previews = make(map[string]string)
	}
	a.previews[token] = path
	a.previewMu.Unlock()
	return &MediaPreview{URL: "/media/" + token, Kind: kind, Name: filepath.Base(path)}, nil
}

func (a *App) serveMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/media/")
	a.previewMu.RLock()
	path, ok := a.previews[token]
	a.previewMu.RUnlock()
	if !strings.HasPrefix(r.URL.Path, "/media/") || !ok {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	kind, mime := mediaType(path)
	if kind == "text" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, no-store")
		preview, err := readTextPreview(f, info.Size())
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnsupportedMediaType)
			return
		}
		if r.Method != http.MethodHead {
			json.NewEncoder(w).Encode(preview)
		}
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	// ServeContent implements byte ranges, allowing video seeking without
	// reading a large video into application memory.
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}
