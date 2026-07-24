package ai

// Rule defines a single cleanup rule for matching files/directories.
type Rule struct {
	ID             string `json:"id"`
	MatchType      string `json:"match_type"`       // name_equals, ext_equals, path_contains
	Pattern        string `json:"pattern"`           // pattern to match
	PathHint       string `json:"path_hint,omitempty"` // optional: must also appear in the full path
	Safety         string `json:"safety"`            // safe, caution, danger
	Category       string `json:"category"`          // System Cache, Dev Cache, GPU Cache, etc.
	Description    string `json:"description"`       // human-readable explanation
	Recommendation string `json:"recommendation"`    // what to do
	Action         string `json:"action"`            // delete, keep, uninstall, command
	Command        string `json:"command,omitempty"` // optional command to execute
}

// RulesFile is the top-level JSON structure.
type RulesFile struct {
	Rules []Rule `json:"rules"`
}

// AnalysisResult is returned when analyzing a file or directory.
type AnalysisResult struct {
	Path            string           `json:"path"`
	Name            string           `json:"name"`
	Size            int64            `json:"size"`
	IsDir           bool             `json:"is_dir"`
	Safety          string           `json:"safety"`            // safe, caution, danger, unknown
	Category        string           `json:"category"`          // rule category or "Unknown"
	Description     string           `json:"description"`       // AI explanation
	Recommendation  string           `json:"recommendation"`    // cleanup advice
	Action          string           `json:"action"`            // delete, keep, uninstall, command, unknown
	HasUninstaller  bool             `json:"has_uninstaller"`   // detected uninstaller in dir
	UninstallerPath string           `json:"uninstaller_path"`  // path to uninstaller exe
	Matched         bool             `json:"matched"`           // whether a rule was matched
	CleanableItems  []CleanableItem  `json:"cleanable_items"`   // for dirs: safe sub-items
	Source          string           `json:"source"`            // "local" (rule engine), "ai-direct" (user's own key), "ai-license" (website proxy)
}

// CleanableItem represents a child file/folder that can be safely cleaned.
type CleanableItem struct {
	Name          string `json:"name"`
	Path          string `json:"path"`
	Size          int64  `json:"size"`
	Safety        string `json:"safety"`
	Category      string `json:"category"`
	Description   string `json:"description"`
}
