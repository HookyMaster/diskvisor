# DiskVisor 网站 API 接口文档

## 架构概述

DiskVisor 的 AI 分析有两条路径，用户二选一：

### 路径 A：自带 AI Key（直连）

```
DiskVisor → 直接调用用户的 AI 端点 → AI 返回结果
```

用户填写自己的 API Key / Base URL / Model，软件构建提示词后直接调 `{base_url}/chat/completions`。不经过任何中间服务器，网站不参与。

### 路径 B：License 代理（网站转发）

```
DiskVisor → 你的网站 API（验证 License + 转发）→ AI 服务商 → 原路返回
```

用户没有自己的 AI Key，从你的网站申请 License。软件把提示词发到你的网站后端，你的后端用自己的 AI API Key 调用 AI 服务商，结果返回给软件。

### 路径选择规则

| 条件 | 路径 |
|---|---|
| 用户填了 AI API Key | 路径 A（直连） |
| 没填 AI Key，但有 License | 路径 B（代理） |
| 都没有 | 不调用 AI，只返回本地规则结果 |

---

## 路径 A：直连（不涉及网站）

软件直接发 OpenAI 兼容的 Chat Completion 请求：

```
POST {ai_base_url}/chat/completions
Authorization: Bearer {ai_api_key}
Content-Type: application/json

{
  "model": "{ai_model}",
  "messages": [
    {"role": "system", "content": "You are a Windows disk cleanup advisor..."},
    {"role": "user", "content": "路径: C:\\...\\SomeApp\n名称: SomeApp\n..."}
  ],
  "temperature": 0.3
}
```

响应格式（标准 OpenAI 格式）：

```json
{
  "choices": [
    {
      "message": {
        "content": "{\"safety\":\"caution\",\"category\":\"Software Data\",...}"
      }
    }
  ]
}
```

这条路径**你的网站不需要做任何事**，软件直接和 AI 服务商通信。

---

## 路径 B：License 代理（涉及网站）

### 接口 1：License 验证

```
POST {website_api_url}/license/validate
Content-Type: application/json
```

请求：
```json
{
  "license_key": "用户输入的 License Key"
}
```

响应（成功）：
```json
{
  "valid": true,
  "expires_at": "2026-12-31",
  "plan": "pro"
}
```

响应（失败）：
```json
{
  "valid": false,
  "error": "License 已过期"
}
```

### 接口 2：AI 提示词转发

```
POST {website_api_url}/ai
Content-Type: application/json
```

请求：
```json
{
  "license_key": "用户的 License Key",
  "messages": [
    {
      "role": "system",
      "content": "You are a Windows disk cleanup advisor..."
    },
    {
      "role": "user",
      "content": "路径: C:\\Users\\...\\SomeApp\n名称: SomeApp\n大小: 2.3 GB\n类型: 文件夹\n子项数量: 42\n  - cache (目录)\n  - logs (目录)\n  ..."
    }
  ]
}
```

注意：**请求中不包含 AI API Key**——网站使用自己的 AI Key 来转发。

### 网站后端处理流程

1. **验证 License**：检查 `license_key` 是否有效且未过期
2. **转发请求**：用**你自己的** AI API Key 构造 OpenAI 兼容请求：
   ```
   POST {你的AI_BASE_URL}/chat/completions
   Authorization: Bearer {你的AI_API_KEY}
   Content-Type: application/json

   {
     "model": "{你指定的模型}",
     "messages": [...用户传来的 messages...],
     "temperature": 0.3
   }
   ```
3. **返回结果**：从 AI 响应中提取 `content`，返回给客户端

响应（成功）：
```json
{
  "success": true,
  "content": "{\"safety\":\"caution\",\"category\":\"Software Data\",\"description\":\"某软件的本地数据目录\",\"recommendation\":\"可以清理 cache 和 logs\",\"action\":\"keep\"}"
}
```

响应（失败）：
```json
{
  "success": false,
  "error": "License 无效或已过期"
}
```

### 错误场景

| 场景 | error 内容 |
|---|---|
| License 无效或过期 | "License 无效或已过期" |
| License 未提供 | "缺少 License Key" |
| AI 调用失败 | "AI 请求失败: {具体错误}" |
| 频率限制 | "请求过于频繁，请稍后再试" |

---

## AI 返回内容格式

无论路径 A 还是 B，AI 收到的 system prompt 都要求返回如下 JSON：

```json
{
  "safety": "safe | caution | danger",
  "category": "短分类名",
  "description": "1-2 句话说明这是什么（中文）",
  "recommendation": "具体的清理建议（中文）",
  "action": "delete | keep | uninstall | command"
}
```

安全等级：
- `safe`：可安全删除（缓存、临时文件、日志、崩溃转储）
- `caution`：删除可能丢失设置/数据，需谨慎
- `danger`：系统关键文件，不能删

---

## Go 后端参考实现（路径 B）

```go
func handleDiskVisorAI(w http.ResponseWriter, r *http.Request) {
    var req struct {
        LicenseKey string `json:"license_key"`
        Messages   []struct {
            Role    string `json:"role"`
            Content string `json:"content"`
        } `json:"messages"`
    }
    json.NewDecoder(r.Body).Decode(&req)

    // 1. Validate license
    if !validateLicense(req.LicenseKey) {
        json.NewEncoder(w).Encode(map[string]interface{}{
            "success": false,
            "error":   "License 无效或已过期",
        })
        return
    }

    // 2. Forward to YOUR AI endpoint using YOUR API key
    aiReq := map[string]interface{}{
        "model":       "gpt-4o-mini",  // your model
        "messages":    req.Messages,
        "temperature": 0.3,
    }
    aiBody, _ := json.Marshal(aiReq)

    aiHTTPReq, _ := http.NewRequest("POST", "https://api.openai.com/v1/chat/completions", bytes.NewReader(aiBody))
    aiHTTPReq.Header.Set("Authorization", "Bearer "+os.Getenv("OPENAI_API_KEY")) // YOUR key
    aiHTTPReq.Header.Set("Content-Type", "application/json")

    client := &http.Client{Timeout: 30 * time.Second}
    aiResp, err := client.Do(aiHTTPReq)
    if err != nil {
        json.NewEncoder(w).Encode(map[string]interface{}{
            "success": false,
            "error":   "AI 请求失败: " + err.Error(),
        })
        return
    }
    defer aiResp.Body.Close()

    // 3. Extract content from OpenAI response
    var aiResult struct {
        Choices []struct {
            Message struct {
                Content string `json:"content"`
            } `json:"message"`
        } `json:"choices"`
    }
    json.NewDecoder(aiResp.Body).Decode(&aiResult)

    content := ""
    if len(aiResult.Choices) > 0 {
        content = aiResult.Choices[0].Message.Content
    }

    // 4. Return to client
    json.NewEncoder(w).Encode(map[string]interface{}{
        "success": true,
        "content": content,
    })
}
```

关键区别：路径 B 中网站使用**自己的** AI Key，不接触用户的 Key（用户根本没填）。

---

## 安全注意事项

1. **路径 A**：用户 AI Key 只存在本地 `config.json`，不发给你的网站。软件直连 AI 服务商。
2. **路径 B**：你的 AI Key 只存在服务器端环境变量中，不暴露给客户端。
3. **License 验证加频率限制**：防止暴力枚举。
4. **AI 转发加超时**：30 秒足够。
5. **HTTPS 必须**：License Key 是敏感信息。
6. **可选：按 License 统计 AI 调用次数**：用于计费或配额限制。
