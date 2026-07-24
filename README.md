# DiskVisor

> AI 驱动的 Windows 磁盘空间分析 & 清理助手

DiskVisor 通过极速扫描磁盘目录结构，以 Treemap 矩形树图直观呈现空间占用，并结合本地规则引擎 + AI 大模型，对每个文件/文件夹给出安全等级评估和清理建议。你可以一眼看出空间被什么吃掉了，然后在 AI 的指导下安全清理。

---

## 功能特性

- **极速扫描**：NTFS 分区直接读取 MFT（主文件表），百万文件秒级完成；非 NTFS 自动回退到递归遍历。
- **Treemap 可视化**：WizTree 风格的矩形树图，霓虹渐变 + 浮雕圆角方块，按大小加权分色，点击即可下钻目录。
- **双向联动**：目录树与 Treemap 选中项实时同步——点击树节点，Treemap 自动定位高亮；点击 Treemap 方块，目录树自动展开滚动。
- **AI 智能分析**：对选中的文件/文件夹进行安全等级评估（可清理 / 谨慎 / 危险），给出中文说明和清理建议。
  - 内置 50+ 条本地规则（缓存、临时文件、系统目录、开发工具缓存等），无需联网即可使用。
  - 可选接入任意 OpenAI 兼容 API（直连），或通过 License 代理转发。
- **懒加载**：扫描结果按需加载子层，百万文件不卡顿。
- **一键操作**：移到回收站（原生 SHFileOperation，可恢复）、打开文件位置、运行卸载程序。
- **默认管理员提权**：MFT 扫描需要磁盘级访问权限，启动时自动请求。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | [Wails v2](https://wails.io/)（Go 后端 + Web 前端，单 exe 分发） |
| 后端 | Go 1.25 · `golang.org/x/sys`（MFT 直读、SHFileOperation 回收站） |
| 前端 | 原生 JavaScript（无框架）· Vite 构建 |
| Treemap | Canvas 2D · squarify 布局算法 · 幂变换加权（`size^0.55`） |
| AI | OpenAI 兼容 Chat Completions API · 本地 JSON 规则引擎兜底 |

---

## 项目结构

```
diskvisor/
├── main.go                     # Wails 入口，嵌入前端资源
├── app.go                      # 前端可调用的 Go 方法（扫描/分析/回收站等）
├── recycle_windows.go          # SHFileOperationW 原生回收站实现
├── recycle_stub.go             # 非 Windows 平台桩
├── wails.json                  # Wails 项目配置
├── go.mod / go.sum
│
├── internal/
│   ├── scanner/
│   │   ├── scanner.go          # 目录扫描器（MFT 优先 → WalkDir 回退）
│   │   ├── mft_windows.go      # NTFS MFT 直读（CreateFile + DeviceIoControl）
│   │   ├── mft_parse.go        # MFT 记录解析 + 文件树重建
│   │   ├── mft_stub.go         # 非 Windows 桩
│   │   └── *_test.go           # 单元测试
│   ├── ai/
│   │   ├── engine.go           # 本地规则引擎 + 卸载器检测
│   │   ├── client.go           # 远程 AI 客户端（直连 / License 代理）
│   │   ├── rules.json          # 50+ 条内置清理规则
│   │   └── types.go            # 分析结果数据结构
│   └── config/
│       └── config.go           # 用户配置读写（%APPDATA%\DiskVisor\config.json）
│
├── frontend/
│   ├── index.html              # 页面骨架
│   ├── src/
│   │   ├── main.js             # 全部交互逻辑（树/Treemap/AI 面板/联动）
│   │   ├── style.css           # 暗色主题样式
│   │   └── assets/             # 字体、图标
│   ├── wailsjs/                # Wails 自动生成的 JS 绑定
│   └── package.json
│
├── build/
│   ├── appicon.png             # 应用图标
│   └── windows/
│       ├── icon.ico
│       ├── wails.exe.manifest  # 管理员提权 manifest
│       └── installer/          # NSIS 安装包脚本
│
└── docs/
    └── WEBSITE_API.md          # 网站 API 接口文档（License 代理方案）
```

---

## 环境要求

- **操作系统**：Windows 10/11（MFT 极速扫描仅支持 NTFS 分区）
- **Go**：1.25+
- **Node.js**：22+（前端构建）
- **Wails CLI**：v2.13+（`go install github.com/wailsapp/wails/v2/cmd/wails@latest`）

---

## 构建 & 运行

### 开发模式

```bash
cd frontend && npm install
cd .. && wails dev
```

### 生产构建

```bash
wails build -clean
```

产物位于 `build/bin/diskvisor.exe`，单文件即可运行，无需安装任何运行时。

---

## AI 配置

DiskVisor 支持两条 AI 路径，**都不配置也能用**（仅使用本地规则引擎）：

### 方式一：自带 AI API Key（直连）

在设置中填写：

| 字段 | 示例 |
|---|---|
| API Base URL | `https://api.openai.com/v1` |
| API Key | `sk-...` |
| 模型名称 | `gpt-4o-mini` |

软件直接调用你的 AI 端点，不经过任何中间服务器。

### 方式二：License 代理（网站转发）

没有自己的 AI Key 时，从网站申请 License Key。软件把提示词发到网站后端，网站用自己的 AI Key 转发。

网站 API 接口规范见 [`docs/WEBSITE_API.md`](docs/WEBSITE_API.md)。

### 路径选择优先级

| 条件 | 使用路径 |
|---|---|
| 填了 AI API Key | 直连 |
| 没填 Key，有 License | 代理转发 |
| 都没有 | 仅本地规则（无需联网） |

---

## 内置清理规则

`internal/ai/rules.json` 包含 50+ 条规则，覆盖：

- **系统缓存**：Temp、CrashDumps、WER 报告、IconCache、Prefetch、缩略图缓存
- **GPU 缓存**：D3DSCache、NVIDIA DXCache/GLCache/ComputeCache
- **浏览器**：Temporary Internet Files
- **开发工具**：npm/pnpm/pip/Go build/node-gyp/NuGet/Gradle/Maven/Cargo/Electron/VS Code/JetBrains 缓存
- **系统关键**（标记为危险）：pagefile.sys、NTUSER.DAT、Windows 目录、Program Files、ProgramData、UWP Packages
- **文件类型**：.dmp / .log / .tmp / .bak / .old 等

每条规则包含安全等级（safe / caution / danger）、分类、中文说明和清理建议。

---

## 安全说明

- **回收站删除**：使用 Windows 原生 `SHFileOperationW` API（`FOF_ALLOWUNDO`），文件可从回收站恢复，非永久删除。
- **卸载程序**：仅检测并启动软件自带的卸载器（`uninstall.exe` / `Uninstall *.exe`），不会强制删除。
- **危险操作锁定**：AI 评估为 `danger` 的项目，回收站按钮自动禁用。
- **AI Key 安全**：API Key 仅存储在本地 `%APPDATA%\DiskVisor\config.json`，不会发送到任何第三方（直连模式只发给用户自己配置的 AI 端点）。

---

## License

MIT
