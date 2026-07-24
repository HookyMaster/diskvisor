package ai

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"diskvisor/internal/config"
)

// RemoteClient handles AI analysis via two paths:
//
// Path A (Direct): User has their own AI API Key → software calls
// the AI provider directly, no website involved.
//
// Path B (License proxy): User has no AI Key but has a License →
// software sends prompt to the website backend, which uses ITS OWN
// AI API Key to call the AI provider and returns the result.
type RemoteClient struct {
	cfg *config.Config
	http.Client
}

// NewRemoteClient creates a client from the user's config.
func NewRemoteClient(cfg *config.Config) *RemoteClient {
	return &RemoteClient{
		cfg:    cfg,
		Client: http.Client{Timeout: 30 * time.Second},
	}
}

// LicenseValidateResult is the response from the website's license check.
type LicenseValidateResult struct {
	Valid     bool   `json:"valid"`
	ExpiresAt string `json:"expires_at"`
	Plan      string `json:"plan"`
	Error     string `json:"error,omitempty"`
}

// ValidateLicense calls the website API to check if the license key is valid.
func (c *RemoteClient) ValidateLicense() (*LicenseValidateResult, error) {
	url := strings.TrimRight(c.cfg.WebsiteAPIURL, "/") + "/license/validate"

	body := map[string]string{
		"license_key": c.cfg.LicenseKey,
	}
	jsonBody, _ := json.Marshal(body)

	resp, err := c.Post(url, "application/json", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("license validate request: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read license response: %w", err)
	}

	var result LicenseValidateResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("parse license response: %w (raw: %s)", err, string(raw))
	}

	if resp.StatusCode != 200 {
		return &result, fmt.Errorf("license invalid: %s", result.Error)
	}

	return &result, nil
}

// --- shared types ---

type aiMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// aiResponseGeneric is the common response shape from both paths.
type aiResponseGeneric struct {
	Success bool   `json:"success"`
	Content string `json:"content"`
	Error   string `json:"error,omitempty"`
}

// openaiChatResponse is the response from an OpenAI-compatible endpoint.
type openaiChatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// --- Path A: Direct call (user's own AI key) ---

// AnalyzeDirect calls the user's AI provider directly. The software builds
// the prompt and sends it to {ai_base_url}/chat/completions with the user's
// API key. No website involvement.
func (c *RemoteClient) AnalyzeDirect(path string) (*AnalysisResult, error) {
	if c.cfg.AIAPIKey == "" {
		return nil, fmt.Errorf("未配置 AI API Key")
	}

	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat %s: %w", path, err)
	}

	name := filepath.Base(path)
	result := newAIResult(path, name, info, "ai-direct")

	// Build messages
	userPrompt := buildUserPrompt(path, name, info)
	messages := []aiMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: userPrompt},
	}

	// Build OpenAI-compatible request
	reqBody := map[string]interface{}{
		"model":       c.cfg.AIModel,
		"messages":    messages,
		"temperature": 0.3,
	}
	jsonBody, _ := json.Marshal(reqBody)

	// Call the AI endpoint directly
	url := strings.TrimRight(c.cfg.AIBaseURL, "/") + "/chat/completions"
	req, err := http.NewRequest("POST", url, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.AIAPIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("AI request failed: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read AI response: %w", err)
	}

	if resp.StatusCode != 200 {
		var errResp openaiChatResponse
		json.Unmarshal(raw, &errResp)
		errMsg := "unknown error"
		if errResp.Error != nil {
			errMsg = errResp.Error.Message
		}
		return nil, fmt.Errorf("AI error (HTTP %d): %s", resp.StatusCode, errMsg)
	}

	var chatResp openaiChatResponse
	if err := json.Unmarshal(raw, &chatResp); err != nil {
		return nil, fmt.Errorf("parse AI response: %w (raw: %s)", err, string(raw))
	}

	if len(chatResp.Choices) == 0 {
		return nil, fmt.Errorf("AI returned no choices")
	}

	content := chatResp.Choices[0].Message.Content
	parseAIContent(content, result)

	if info.IsDir() {
		detectUninstallerLocal(path, result)
	}

	return result, nil
}

// --- Path B: License proxy (website uses its own AI key) ---

// licenseAIRequest is sent to the website's proxy endpoint.
// The website validates the license, then uses ITS OWN AI API key to
// forward the prompt. The user's AI key is NOT sent.
type licenseAIRequest struct {
	LicenseKey string      `json:"license_key"`
	Messages   []aiMessage `json:"messages"`
}

// AnalyzeViaLicense sends the prompt to the website backend, which
// validates the license and uses its own AI API key to call the AI
// provider. Used when the user has a license but no personal AI key.
func (c *RemoteClient) AnalyzeViaLicense(path string) (*AnalysisResult, error) {
	if c.cfg.LicenseKey == "" {
		return nil, fmt.Errorf("未配置 License Key")
	}

	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat %s: %w", path, err)
	}

	name := filepath.Base(path)
	result := newAIResult(path, name, info, "ai-license")

	// Build messages
	userPrompt := buildUserPrompt(path, name, info)
	messages := []aiMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: userPrompt},
	}

	// Send to website proxy
	reqBody := licenseAIRequest{
		LicenseKey: c.cfg.LicenseKey,
		Messages:   messages,
	}
	jsonBody, _ := json.Marshal(reqBody)

	url := strings.TrimRight(c.cfg.WebsiteAPIURL, "/") + "/ai"
	resp, err := c.Post(url, "application/json", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("website proxy request failed: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read proxy response: %w", err)
	}

	if resp.StatusCode != 200 {
		var errResp aiResponseGeneric
		json.Unmarshal(raw, &errResp)
		return nil, fmt.Errorf("proxy error: %s", errResp.Error)
	}

	var proxyResp aiResponseGeneric
	if err := json.Unmarshal(raw, &proxyResp); err != nil {
		return nil, fmt.Errorf("parse proxy response: %w (raw: %s)", err, string(raw))
	}

	if !proxyResp.Success {
		return nil, fmt.Errorf("proxy error: %s", proxyResp.Error)
	}

	parseAIContent(proxyResp.Content, result)

	if info.IsDir() {
		detectUninstallerLocal(path, result)
	}

	return result, nil
}

// --- shared helpers ---

func newAIResult(path, name string, info os.FileInfo, source string) *AnalysisResult {
	return &AnalysisResult{
		Path:    path,
		Name:    name,
		IsDir:   info.IsDir(),
		Safety:  "unknown",
		Category: "Unknown",
		Action:  "unknown",
		Matched: false,
		Source:  source,
	}
}

const systemPrompt = `You are a Windows disk cleanup advisor. The user will give you a file or directory path with metadata.

Respond ONLY with a JSON object (no markdown, no code fences) with these fields:
{
  "safety": "safe" | "caution" | "danger",
  "category": "short category name (e.g. System Cache, Dev Cache, Browser Data, Software Data, Log, Temp, System)",
  "description": "1-2 sentence explanation of what this file/folder is",
  "recommendation": "specific advice on whether/how to clean it",
  "action": "delete" | "keep" | "uninstall" | "command"
}

Rules:
- "safe": can be deleted without consequence (caches, temp, logs, crash dumps)
- "caution": deleting may lose settings/data, proceed with care
- "danger": system-critical, must NOT be deleted (pagefile, registry, Windows dir)
- Respond in Chinese (Simplified) for description and recommendation fields
- Keep description concise, focus on what it IS
- Keep recommendation actionable, tell the user exactly what to do`

func buildUserPrompt(path, name string, info os.FileInfo) string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("路径: %s\n", path))
	sb.WriteString(fmt.Sprintf("名称: %s\n", name))
	sb.WriteString(fmt.Sprintf("大小: %s (%d bytes)\n", formatBytes(info.Size()), info.Size()))
	sb.WriteString(fmt.Sprintf("类型: %s\n", func() string {
		if info.IsDir() {
			return "文件夹"
		}
		return "文件"
	}()))
	sb.WriteString(fmt.Sprintf("修改时间: %s\n", info.ModTime().Format("2006-01-02 15:04")))

	if !info.IsDir() {
		ext := filepath.Ext(name)
		if ext != "" {
			sb.WriteString(fmt.Sprintf("扩展名: %s\n", ext))
		}
	}

	if info.IsDir() {
		entries, err := os.ReadDir(path)
		if err == nil {
			sb.WriteString(fmt.Sprintf("子项数量: %d\n", len(entries)))
			sampleCount := 0
			for _, entry := range entries {
				if sampleCount >= 20 {
					sb.WriteString("...\n")
					break
				}
				entryType := "文件"
				if entry.IsDir() {
					entryType = "目录"
				}
				sb.WriteString(fmt.Sprintf("  - %s (%s)\n", entry.Name(), entryType))
				sampleCount++
			}
		}
	}

	return sb.String()
}

func parseAIContent(content string, result *AnalysisResult) {
	content = strings.TrimSpace(content)
	if strings.HasPrefix(content, "```") {
		lines := strings.Split(content, "\n")
		var jsonLines []string
		inBlock := false
		for _, line := range lines {
			if strings.HasPrefix(line, "```") {
				inBlock = !inBlock
				continue
			}
			if inBlock {
				jsonLines = append(jsonLines, line)
			}
		}
		if len(jsonLines) > 0 {
			content = strings.Join(jsonLines, "\n")
		}
	}

	var parsed struct {
		Safety         string `json:"safety"`
		Category       string `json:"category"`
		Description    string `json:"description"`
		Recommendation string `json:"recommendation"`
		Action         string `json:"action"`
	}

	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		result.Description = content
		result.Safety = "unknown"
		result.Category = "AI Analysis"
		result.Recommendation = "无法解析 AI 响应格式"
		result.Action = "unknown"
		return
	}

	result.Safety = parsed.Safety
	result.Category = parsed.Category
	result.Description = parsed.Description
	result.Recommendation = parsed.Recommendation
	result.Action = parsed.Action
}

func detectUninstallerLocal(dirPath string, result *AnalysisResult) {
	if full, ok := findUninstaller(dirPath); ok {
		result.HasUninstaller = true
		result.UninstallerPath = full
	}
}

func formatBytes(b int64) string {
	const (
		KB = 1024
		MB = KB * 1024
		GB = MB * 1024
		TB = GB * 1024
	)
	switch {
	case b >= TB:
		return fmt.Sprintf("%.2f TB", float64(b)/float64(TB))
	case b >= GB:
		return fmt.Sprintf("%.2f GB", float64(b)/float64(GB))
	case b >= MB:
		return fmt.Sprintf("%.1f MB", float64(b)/float64(MB))
	case b >= KB:
		return fmt.Sprintf("%.1f KB", float64(b)/float64(KB))
	default:
		return fmt.Sprintf("%d B", b)
	}
}
