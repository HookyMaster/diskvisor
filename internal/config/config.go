package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Config stores user settings for AI and license.
type Config struct {
	// AI provider settings (OpenAI-compatible, filled by user)
	AIAPIKey  string `json:"ai_api_key"`
	AIBaseURL string `json:"ai_base_url"` // e.g. https://api.openai.com/v1
	AIModel   string `json:"ai_model"`    // e.g. gpt-4o-mini

	// License (obtained from user's website)
	LicenseKey string `json:"license_key"`

	// Website API gateway (validates license + forwards prompt to AI)
	WebsiteAPIURL string `json:"website_api_url"` // e.g. https://your-server.example.com/api/diskvisor

	// Runtime state (not user-editable)
	LicenseValid  bool   `json:"license_valid"`
	LicenseExpiry string `json:"license_expiry,omitempty"`
	LicensePlan   string `json:"license_plan,omitempty"`
}

// DefaultConfig returns sensible defaults.
func DefaultConfig() *Config {
	return &Config{
		AIAPIKey:      "",
		AIBaseURL:     "https://api.openai.com/v1",
		AIModel:       "gpt-4o-mini",
		LicenseKey:    "",
		WebsiteAPIURL: "https://your-server.example.com/api/diskvisor",
		LicenseValid:  false,
	}
}

// configDir returns the path to the config directory.
func configDir() (string, error) {
	home := os.Getenv("USERPROFILE")
	if home == "" {
		home = os.Getenv("APPDATA")
	}
	dir := filepath.Join(home, "AppData", "Roaming", "DiskVisor")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return dir, nil
}

// configPath returns the full path to config.json.
func configPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

// Load reads config from disk. Returns defaults if file doesn't exist.
func Load() (*Config, error) {
	path, err := configPath()
	if err != nil {
		return DefaultConfig(), err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg := DefaultConfig()
			return cfg, nil
		}
		return DefaultConfig(), err
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return DefaultConfig(), err
	}

	// Fill defaults for empty fields
	if cfg.AIBaseURL == "" {
		cfg.AIBaseURL = "https://api.openai.com/v1"
	}
	if cfg.AIModel == "" {
		cfg.AIModel = "gpt-4o-mini"
	}
	if cfg.WebsiteAPIURL == "" {
		cfg.WebsiteAPIURL = "https://your-server.example.com/api/diskvisor"
	}

	return &cfg, nil
}

// Save writes config to disk.
func Save(cfg *Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0644)
}
