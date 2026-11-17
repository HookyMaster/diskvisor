# DiskVisor

Windows 磁盘空间分析与清理助手，使用 Go / Wails 和原生 JavaScript 构建。

## 当前功能

- **空间分析**：目录树与 Canvas 矩形树图双向定位、高亮；目录按需加载并合并重复请求。单击选择，双击文件夹下钻。
- **导航**：可点击路径面包屑、逐级返回、回到根目录；方向键浏览目录，Enter 下钻。
- **一致配色**：文件夹为金色；图片、视频、音频、文档、代码/配置、压缩包、程序/库使用固定类别颜色。目录图标、占用条与矩形树图共用图例。
- **本地预览**：图片显示内容及分辨率；视频提供播放、进度拖动和全屏。解码能力取决于 WebView2 和系统支持。
- **文本预览**：常见文本、代码、日志与配置格式，支持行号、自动换行、UTF-8、带 BOM 的 UTF-16 LE/BE、GBK/GB18030；最多读取 256 KB、显示 3000 行，超限明确提示。HTML、脚本与 Markdown 按纯文本显示。
- **右键操作**：目录树和矩形树图右键菜单提供打开位置、移到回收站、卸载程序。底部不再保留操作栏。Shift+F10 可打开目录树的操作菜单。
- **AI 建议**：内置本地规则，可选用户自带 OpenAI 兼容 API Key 或 License 代理。视图联动与媒体预览不等待 AI；连续选择会合并尚未发出的分析请求。
- **清理保护**：后端限制系统路径、驱动器根目录、用户配置根目录、链接及特殊文件；本地危险判定不能被 AI 放宽；回收站操作检查取消状态。

## 扫描与图表说明

程序默认以当前用户权限运行。只有 NTFS 权限与结构检查通过时才使用原始 MFT 读取；无法确认 MFT 连续性、记录完整性或权限不足时回退目录遍历。当前 MFT 解析仍有高级 NTFS 限制，例如完整硬链接和属性列表支持。

矩形树图继续使用 `size^0.55` 权重及最小视觉权重，**矩形面积不与真实字节数严格成比例**；每层最多显示 200 项，其余合并为“其他”。选择隐藏的小文件时会将它单独展示。此次界面更新没有改动这一平铺策略。

颜色表示文件类别，不表示清理安全等级。风险以详情中的文字判定为准。

## 环境与构建

- Windows 10/11 与 Microsoft Edge WebView2 Runtime。
- Go：遵循 `go.mod`。
- Node.js：满足 `frontend/package-lock.json` 中 Vite 的版本要求。
- Wails CLI：项目使用 v2.13.0。

```powershell
go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
npm --prefix frontend ci
wails dev
```

生产构建：

```powershell
wails build
```

输出为 `build/bin/diskvisor.exe`。请通过 Wails 构建以生成 Windows 资源和 manifest，而不是只运行普通的 `go build`。

## 测试

先生成被 Go 嵌入的前端资源，再运行测试：

```powershell
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix frontend test
go test ./...
go vet ./...
```

测试覆盖目录请求合并、过期请求隔离、绘制帧合并、AI 与视图解耦、媒体范围请求、文本编码/截断、清理路径保护及部分 MFT 解析。

图片与生成的 WebM 短视频已做桌面预览检查。后续导航和右键菜单的构建与回归测试通过；完整桌面交互、实际清理及不同磁盘布局仍需进一步验证。

## AI 与本地配置

在设置中填写 API Base URL、API Key、模型，或填写 License 和自有网站 API 地址。优先使用自带 Key，其次 License；都未配置时使用本地规则。

程序启动时自动读取本地配置，保存设置时写回：

`%USERPROFILE%\AppData\Roaming\DiskVisor\config.json`

字段 `ai_api_key`、`license_key` 等目前以**明文 JSON**保存，尚未使用 Windows 凭据保护；不要将该文件提交到仓库。仓库中的网站代理地址为示例，需要自行配置。网站 API 说明见 [docs/WEBSITE_API.md](docs/WEBSITE_API.md)。

媒体和文本预览本身不上传文件。启用远程 AI 时，分析会发送路径、大小、修改时间及目录中最多 20 个子项名称等元数据；API Key 发送给用户配置的服务端，License 模式通过配置的网站代理处理。

## 源码入口

| 文件 | 用途 |
|---|---|
| `app.go` / `main.go` | Wails API、应用状态与启动 |
| `cleanup.go` | 后端清理路径保护 |
| `media.go` / `text_preview.go` | 扫描内文件授权、媒体范围读取与文本预览 |
| `internal/scanner` | 目录扫描、MFT 读取与解析 |
| `internal/ai` | 本地规则、远程 AI 与结果解析 |
| `internal/config` | 本地配置读写 |
| `frontend/src/main.js` | 目录树、图表和右键菜单 |
| `frontend/src/tree-store.mjs` / `interaction-jobs.mjs` | 共享目录数据与异步联动调度 |
| `frontend/src/media-preview.js` | 图片、视频和文本预览 |
| `frontend/src/file-colors.mjs` / `ui.css` | 文件类别配色及浅色界面 |

## License

[MIT](LICENSE)
