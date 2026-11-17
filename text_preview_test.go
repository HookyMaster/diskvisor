package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"diskvisor/internal/scanner"
)

func TestTextPreviewEncodings(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
		want string
	}{
		{"utf8", []byte("中文\r\nhello"), "中文\nhello"},
		{"utf8-bom", append([]byte{0xef, 0xbb, 0xbf}, []byte("中文")...), "中文"},
		{"utf16-le", []byte{0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65}, "中文"},
		{"utf16-be", []byte{0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87}, "中文"},
		{"gbk", []byte{0xd6, 0xd0, 0xce, 0xc4}, "中文"},
		{"empty", nil, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := readTextPreview(bytes.NewReader(tc.data), int64(len(tc.data)))
			if err != nil || p.Content != tc.want || p.Truncated {
				t.Fatalf("preview=%+v err=%v", p, err)
			}
		})
	}
}

func TestTextPreviewLimitsAndBinary(t *testing.T) {
	data := bytes.Repeat([]byte("中"), textPreviewLimit/3+2)
	p, err := readTextPreview(bytes.NewReader(data), int64(len(data)))
	if err != nil || !p.Truncated || strings.ContainsRune(p.Content, '\ufffd') || p.Encoding != "UTF-8" || len(p.Content) > textPreviewLimit {
		t.Fatalf("UTF8 boundary: %+v %v", p, err)
	}
	text := strings.Repeat("line\n", textPreviewLines+10)
	p, err = readTextPreview(strings.NewReader(text), int64(len(text)))
	if err != nil || !p.Truncated || len(strings.Split(p.Content, "\n")) != textPreviewLines {
		t.Fatal("line limit failed")
	}
	if _, err := readTextPreview(bytes.NewReader([]byte{'a', 0, 'b'}), 3); err == nil {
		t.Fatal("binary accepted as text")
	}
}

func TestTextPreviewHTTP(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "example.html")
	input := "<script>alert('preview')</script>\n中文"
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	root := &scanner.FileNode{Path: dir, IsDir: true, Children: []scanner.FileNode{{Path: path}}}
	a := NewApp()
	a.fullRoot = root
	a.pathIndex = scanner.BuildPathIndex(root)
	p, err := a.GetMediaPreview(path)
	if err != nil || p.Kind != "text" {
		t.Fatalf("preview=%+v err=%v", p, err)
	}
	w := httptest.NewRecorder()
	a.serveMedia(w, httptest.NewRequest(http.MethodGet, p.URL, nil))
	var result TextPreview
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") || result.Content != input {
		t.Fatalf("unsafe or incorrect response: %d %s", w.Code, w.Body.String())
	}
}
