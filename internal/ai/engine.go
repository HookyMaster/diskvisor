package ai

import (
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed rules.json
var rulesFS embed.FS

// Engine holds the loaded rules and provides analysis methods.
type Engine struct {
	rules []Rule
}

// Protects uses deterministic local policy only; remote advice cannot override it.
func (e *Engine) Protects(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return true
	}
	rule := e.matchRule(path, filepath.Base(path), info.IsDir())
	return rule != nil && rule.Safety == "danger"
}

// New creates a new AI engine with embedded rules loaded.
func New() (*Engine, error) {
	data, err := rulesFS.ReadFile("rules.json")
	if err != nil {
		return nil, fmt.Errorf("read embedded rules: %w", err)
	}
	var rf RulesFile
	if err := json.Unmarshal(data, &rf); err != nil {
		return nil, fmt.Errorf("parse rules json: %w", err)
	}
	return &Engine{rules: rf.Rules}, nil
}

// Analyze inspects a path and returns structured cleanup advice.
func (e *Engine) Analyze(path string) (*AnalysisResult, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat %s: %w", path, err)
	}

	name := filepath.Base(path)
	result := &AnalysisResult{
		Path:     path,
		Name:     name,
		IsDir:    info.IsDir(),
		Safety:   "unknown",
		Category: "Unknown",
		Action:   "unknown",
		Matched:  false,
		Source:   "local",
	}

	// Try to match a rule
	rule := e.matchRule(path, name, info.IsDir())
	if rule != nil {
		result.Matched = true
		result.Safety = rule.Safety
		result.Category = rule.Category
		result.Description = rule.Description
		result.Recommendation = rule.Recommendation
		result.Action = rule.Action
	}

	// For directories: detect uninstaller and scan for cleanable children
	if info.IsDir() {
		e.detectUninstaller(path, result)
		e.scanCleanable(path, result)
	}

	return result, nil
}

// matchRule finds the best matching rule for a given path.
// Priority: rules with path_hint > rules without path_hint.
func (e *Engine) matchRule(fullPath, name string, isDir bool) *Rule {
	lowerPath := strings.ToLower(fullPath)
	lowerName := strings.ToLower(name)

	var bestMatch *Rule
	bestScore := 0

	for i := range e.rules {
		r := &e.rules[i]
		score := 0
		matched := false

		switch r.MatchType {
		case "name_equals":
			if lowerName == strings.ToLower(r.Pattern) {
				matched = true
				score = 10
			}
		case "ext_equals":
			if !isDir {
				ext := strings.ToLower(filepath.Ext(name))
				if ext == strings.ToLower(r.Pattern) {
					matched = true
					score = 5
				}
			}
		case "path_contains":
			if strings.Contains(lowerPath, strings.ToLower(r.Pattern)) {
				matched = true
				score = 8
			}
		}

		if !matched {
			continue
		}

		// If rule has a path_hint, it must also match
		if r.PathHint != "" {
			if !strings.Contains(lowerPath, strings.ToLower(r.PathHint)) {
				continue
			}
			score += 20 // path_hint makes the match more specific
		}

		if score > bestScore {
			bestScore = score
			bestMatch = r
		}
	}

	return bestMatch
}

// detectUninstaller checks if the directory contains a common uninstaller executable.
func (e *Engine) detectUninstaller(dirPath string, result *AnalysisResult) {
	if full, ok := findUninstaller(dirPath); ok {
		result.HasUninstaller = true
		result.UninstallerPath = full
	}
}

// findUninstaller locates an uninstaller executable in dirPath.
// It first checks a set of well-known exact names (fast path via os.Stat),
// then falls back to a prefix scan so names like "Uninstall draw.io.exe" or
// "Uninstall Firefox.exe" are also recognized. Returns the full path and true
// if found.
func findUninstaller(dirPath string) (string, bool) {
	// Fast path: exact well-known names.
	exactNames := []string{
		"uninstall.exe", "uninst.exe", "uninstaller.exe",
		"uninst000.exe", "unsetup.exe", "uninstall.bat",
	}
	for _, u := range exactNames {
		full := filepath.Join(dirPath, u)
		if _, err := os.Stat(full); err == nil {
			return full, true
		}
	}

	// Fallback: prefix scan for "Uninstall <app>.exe" style names.
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return "", false
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := strings.ToLower(entry.Name())
		if ext := filepath.Ext(name); ext != ".exe" && ext != ".bat" {
			continue
		}
		// "uninst" covers uninstall/uninstaller/uninst/uninst000; "unsetup"
		// covers the remaining convention. Windows FS is case-insensitive so
		// lowercasing the name is enough.
		if strings.HasPrefix(name, "uninst") || strings.HasPrefix(name, "unsetup") {
			return filepath.Join(dirPath, entry.Name()), true
		}
	}
	return "", false
}

// scanCleanable scans immediate children of a directory and lists
// those that match "safe" rules, giving the user actionable cleanup targets.
func (e *Engine) scanCleanable(dirPath string, result *AnalysisResult) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return
	}

	for _, entry := range entries {
		childName := entry.Name()
		childPath := filepath.Join(dirPath, childName)

		rule := e.matchRule(childPath, childName, entry.IsDir())
		if rule == nil || rule.Safety != "safe" {
			continue
		}

		var size int64
		if entry.IsDir() {
			size = dirSize(childPath)
		} else {
			if info, err := entry.Info(); err == nil {
				size = info.Size()
			}
		}

		// Skip tiny files (< 1KB) to reduce noise
		if size < 1024 {
			continue
		}

		result.CleanableItems = append(result.CleanableItems, CleanableItem{
			Name:        childName,
			Path:        childPath,
			Size:        size,
			Safety:      rule.Safety,
			Category:    rule.Category,
			Description: rule.Description,
		})
	}
}

// dirSize recursively calculates the total size of a directory.
// It uses a time limit to avoid blocking on huge directories.
func dirSize(path string) int64 {
	var size int64
	done := make(chan struct{})
	go func() {
		filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if !info.IsDir() {
				size += info.Size()
			}
			return nil
		})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		// Timeout: return what we have so far
	}
	return size
}
