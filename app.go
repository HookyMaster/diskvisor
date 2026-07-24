package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"diskvisor/internal/ai"
	"diskvisor/internal/config"
	"diskvisor/internal/scanner"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct holds application state.
type App struct {
	ctx       context.Context
	scanner   *scanner.Scanner
	ai        *ai.Engine
	cfg       *config.Config
	fullRoot  *scanner.FileNode            // full scan tree, kept for lazy child loading
	pathIndex map[string]*scanner.FileNode // dir path → node, for O(1) child lookups
}

// NewApp creates a new App application struct.
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.scanner = scanner.New()

	engine, err := ai.New()
	if err != nil {
		runtime.LogErrorf(ctx, "Failed to init AI engine: %v", err)
	} else {
		a.ai = engine
	}

	// Load user config
	cfg, err := config.Load()
	if err != nil {
		runtime.LogWarningf(ctx, "Failed to load config: %v", err)
		cfg = config.DefaultConfig()
	}
	a.cfg = cfg
}

// --- Config API ---

// GetConfig returns the current user configuration.
func (a *App) GetConfig() *config.Config {
	return a.cfg
}

// SaveConfig saves user configuration to disk.
func (a *App) SaveConfig(cfg *config.Config) error {
	a.cfg = cfg
	return config.Save(cfg)
}

// ValidateLicense checks the license key against the website API.
func (a *App) ValidateLicense() (*ai.LicenseValidateResult, error) {
	if a.cfg.LicenseKey == "" {
		return nil, fmt.Errorf("License Key 为空")
	}
	client := ai.NewRemoteClient(a.cfg)
	result, err := client.ValidateLicense()
	if err != nil {
		return nil, err
	}
	// Update cached license state
	a.cfg.LicenseValid = result.Valid
	a.cfg.LicenseExpiry = result.ExpiresAt
	a.cfg.LicensePlan = result.Plan
	config.Save(a.cfg)
	return result, nil
}

// --- Browse ---

// BrowseDirectory opens a system directory picker and returns the selected path.
// Returns empty string if the user cancels.
func (a *App) BrowseDirectory() (string, error) {
	dialogOptions := runtime.OpenDialogOptions{
		Title: "选择要扫描的目录",
	}
	return runtime.OpenDirectoryDialog(a.ctx, dialogOptions)
}

// --- Scan API ---

// ScanResult is returned from Scan, containing the tree and summary stats.
type ScanResult struct {
	Root       *scanner.FileNode `json:"root"`
	TotalSize  int64             `json:"total_size"`
	FileCount  int64             `json:"file_count"`
	DirCount   int64             `json:"dir_count"`
	ScanMethod string            `json:"scan_method"` // "mft" (fast) or "walk" (fallback)
}

// ScanProgress is emitted via Wails events during scanning.
type ScanProgress struct {
	Stage       string  `json:"stage"`        // "counting", "scanning", "done", "error"
	Current     string  `json:"current"`      // current path being scanned
	FileCount   int64   `json:"file_count"`   // running file count
	DirCount    int64   `json:"dir_count"`   // running dir count
	Size        int64   `json:"size"`         // running total size
	TotalFiles  int64   `json:"total_files"`  // estimated total files (from pass 1)
	Percent     float64 `json:"percent"`      // 0-100 progress
}

// Scan scans a directory and returns a size-annotated tree.
// Two-pass: pass 1 counts files (fast), pass 2 reads sizes (progress bar).
// It emits "scan:progress" events during scanning for live UI updates.
func (a *App) Scan(path string) (*ScanResult, error) {
	if path == "" {
		return nil, fmt.Errorf("path is empty")
	}

	// Set up progress callback to emit Wails events
	a.scanner.SetProgressFunc(func(stage string, files, dirs, size, totalFiles int64, percent float64, currentPath string) {
		runtime.EventsEmit(a.ctx, "scan:progress", ScanProgress{
			Stage:      stage,
			Current:    currentPath,
			FileCount:  files,
			DirCount:   dirs,
			Size:       size,
			TotalFiles: totalFiles,
			Percent:    percent,
		})
	})

	root, err := a.scanner.Scan(path)
	if err != nil {
		runtime.EventsEmit(a.ctx, "scan:progress", ScanProgress{
			Stage:   "error",
			Current: fmt.Sprintf("%v", err),
		})
		return nil, fmt.Errorf("scan %s: %w", path, err)
	}

	// Keep the full tree for lazy child loading (GetChildren). The frontend
	// only receives a shallow copy (2 levels) so JSON serialization stays
	// small even for scans with millions of files.
	a.fullRoot = root
	a.pathIndex = scanner.BuildPathIndex(root)

	var dirCount int64
	countDirs(root, &dirCount)

	pruned := scanner.ClonePruned(root, 2)

	result := &ScanResult{
		Root:       pruned,
		TotalSize:  root.Size,
		FileCount:  root.FileCount,
		DirCount:   dirCount,
		ScanMethod: a.scanner.LastMethod(),
	}

	runtime.EventsEmit(a.ctx, "scan:progress", ScanProgress{
		Stage:     "done",
		FileCount: result.FileCount,
		DirCount:  result.DirCount,
		Size:      result.TotalSize,
		Percent:   100,
	})

	return result, nil
}

// GetChildren returns the direct children of a directory path, for lazy
// loading in the frontend tree/treemap. Each child is pruned to 1 level
// (its own children included, grandchildren as leaves) so a single call
// gives the frontend two levels of content to render.
func (a *App) GetChildren(path string) ([]scanner.FileNode, error) {
	if a.fullRoot == nil {
		return nil, fmt.Errorf("no scan data — run a scan first")
	}
	node, ok := a.pathIndex[path]
	if !ok {
		// Fall back to recursive search (handles non-dir paths).
		node = scanner.FindByPath(a.fullRoot, path)
		if node == nil {
			return nil, fmt.Errorf("path not found in scan tree: %s", path)
		}
	}
	children := make([]scanner.FileNode, len(node.Children))
	for i := range node.Children {
		c := scanner.ClonePruned(&node.Children[i], 1)
		children[i] = *c
	}
	return children, nil
}

// AnalyzePath returns AI-powered analysis for a file or directory.
//
// ALL files get AI analysis. The local rules engine runs in parallel to
// enrich the result (add cleanable sub-items, detect uninstallers), but
// does not gate the AI call.
//
// AI path selection:
//   - User has own AI API Key → call AI directly (Path A)
//   - User has License but no AI Key → call via website proxy (Path B)
//   - Neither → return local rules result with a hint to configure
func (a *App) AnalyzePath(path string) (*ai.AnalysisResult, error) {
	if a.ai == nil {
		return nil, fmt.Errorf("AI engine not initialized")
	}

	// Step 1: Run local rules engine (instant, adds cleanable items + uninstaller)
	localResult, err := a.ai.Analyze(path)
	if err != nil {
		localResult = &ai.AnalysisResult{
			Path:    path,
			Safety:  "unknown",
			Source:  "local",
			Matched: false,
		}
	}

	// Step 2: Determine AI path
	var aiResult *ai.AnalysisResult
	var aiErr error

	if a.cfg != nil && a.cfg.AIAPIKey != "" {
		// Path A: Direct call with user's own AI key
		client := ai.NewRemoteClient(a.cfg)
		aiResult, aiErr = client.AnalyzeDirect(path)
	} else if a.cfg != nil && a.cfg.LicenseKey != "" {
		// Path B: Via website proxy (website uses its own AI key)
		client := ai.NewRemoteClient(a.cfg)
		aiResult, aiErr = client.AnalyzeViaLicense(path)
	} else {
		// No AI configured — return local result with a hint
		if localResult.Description == "" {
			localResult.Description = "未配置 AI 分析功能"
		}
		localResult.Recommendation = "在设置中配置自己的 AI API Key，或申请 License 使用网站代理分析"
		return localResult, nil
	}

	// Step 3: Merge AI result with local enrichment
	if aiErr != nil {
		// AI failed — return local result with error note
		localResult.Description = fmt.Sprintf("AI 分析失败: %v", aiErr)
		localResult.Recommendation = "请检查设置中的 AI 配置或网络连接"
		return localResult, nil
	}

	// Enrich AI result with local data (cleanable items, uninstaller)
	if localResult.Matched {
		// If local rule matched, copy cleanable items and uninstaller info
		aiResult.CleanableItems = localResult.CleanableItems
		if localResult.HasUninstaller {
			aiResult.HasUninstaller = true
			aiResult.UninstallerPath = localResult.UninstallerPath
		}
	}

	return aiResult, nil
}

// --- File operations ---

// MoveToRecycleBin sends a file or directory to the Windows Recycle Bin.
func (a *App) MoveToRecycleBin(path string) error {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve path: %w", err)
	}

	// Confirm the target exists.
	if _, err := os.Stat(absPath); err != nil {
		return fmt.Errorf("path does not exist: %s", absPath)
	}

	// Use the native Windows API (no PowerShell, no console window).
	if err := moveToRecycleBinNative(absPath); err != nil {
		return fmt.Errorf("recycle bin failed: %w", err)
	}
	return nil
}

// OpenInExplorer opens the file's location in Windows Explorer.
func (a *App) OpenInExplorer(path string) error {
	cmd := exec.Command("explorer", "/select,", path)
	return cmd.Start()
}

// RunUninstaller launches the uninstaller executable if found.
func (a *App) RunUninstaller(path string) error {
	cmd := exec.Command("cmd", "/c", "start", "", path)
	return cmd.Start()
}

// --- Path helpers ---

// GetCommonPaths returns suggested scan targets.
func (a *App) GetCommonPaths() map[string]string {
	home := getEnv("USERPROFILE")
	return map[string]string{
		"home":            home,
		"appdata":         filepath.Join(home, "AppData"),
		"appdata_local":   filepath.Join(home, "AppData", "Local"),
		"appdata_roaming": filepath.Join(home, "AppData", "Roaming"),
		"documents":       filepath.Join(home, "Documents"),
		"downloads":       filepath.Join(home, "Downloads"),
		"desktop":         filepath.Join(home, "Desktop"),
		"c_drive":         "C:\\",
	}
}

// --- helpers ---

func countDirs(node *scanner.FileNode, count *int64) {
	if node.IsDir {
		*count++
	}
	for i := range node.Children {
		countDirs(&node.Children[i], count)
	}
}

func getEnv(key string) string {
	return os.Getenv(key)
}
