import "./style.css";
import "./ui.css";
import { FILE_KINDS, getFileKind, createFileIcon } from "./file-colors.mjs";
import { createTreeStore } from "./tree-store.mjs";
import { createFrameBatcher, createSelectionJobs } from "./interaction-jobs.mjs";
import { showMediaPreview, resetMediaPreview } from "./media-preview.js";
import {
  Scan,
  AnalyzePath,
  MoveToRecycleBin,
  OpenInExplorer,
  RunUninstaller,
  BrowseDirectory,
  GetChildren,
  GetConfig,
  SaveConfig,
  ValidateLicense,
} from "../wailsjs/go/main/App";
import { EventsOn, EventsOff } from "../wailsjs/runtime/runtime";

let scanData = null;
let selectedPath = null;
let treemapFocus = null;
let treemapRects = [];

// Registry of live tree-row states, keyed by path. Used by revealTreePath()
// to expand ancestor rows when the Treemap drives the selection.
const treeRowStates = new Map();
let selectedTreeRow = null;
let contextTarget = null;
let contextReturnFocus = null;
let scanGeneration = 0;
const treeStore = createTreeStore(async (path) => {
  const children = await GetChildren(path);
  tmLayoutDirty = true;
  return children;
}, pathKey);

// --- Path helpers (Windows-aware, case-insensitive) ---

function normPath(p) {
  return (p || "").replace(/[\\/]+$/, "");
}

function pathKey(p) {
  return (p || "").toLowerCase().replace(/[\\/]+/g, "\\").replace(/[\\/]+$/, "");
}

function isDescendant(path, rootPath) {
  if (!path || !rootPath || path === rootPath) return false;
  const base = normPath(rootPath).toLowerCase();
  const p = path.toLowerCase();
  return p.startsWith(base + "\\") || p.startsWith(base + "/");
}

function joinPath(base, seg) {
  const sep = base.includes("\\") ? "\\" : "/";
  return normPath(base) + sep + seg;
}

function pathSegments(path, rootPath) {
  let rel = path.slice(normPath(rootPath).length).replace(/^[\\/]+/, "");
  return rel.split(/[\\/]+/).filter(Boolean);
}

async function init() {
  const legend = document.getElementById("file-color-legend");
  for (const kind of FILE_KINDS) {
    const item = document.createElement("span");
    item.className = "file-color-key";
    item.setAttribute("role", "listitem");
    const dot = document.createElement("i");
    dot.style.backgroundColor = kind.color;
    dot.setAttribute("aria-hidden", "true");
    item.append(dot, document.createTextNode(kind.label));
    legend.append(item);
  }
  const explanation = document.createElement("span");
  explanation.className = "file-color-explanation";
  explanation.textContent = "颜色表示文件类型，不代表清理安全等级";
  legend.append(explanation);
  document.getElementById("browse-btn").addEventListener("click", doBrowse);
  document.getElementById("scan-btn").addEventListener("click", doScan);

  document.getElementById("recycle-btn").addEventListener("click", doRecycle);
  document.getElementById("explorer-btn").addEventListener("click", doExplorer);
  document.getElementById("uninstall-btn").addEventListener("click", doUninstall);

  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("settings-close").addEventListener("click", closeSettings);
  document.getElementById("settings-cancel").addEventListener("click", closeSettings);
  document.getElementById("settings-save").addEventListener("click", saveSettings);
  document.getElementById("license-validate-btn").addEventListener("click", doValidateLicense);

  document.getElementById("settings-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  const canvas = document.getElementById("treemap-canvas");
  canvas.addEventListener("click", onTreemapClick);
  canvas.addEventListener("dblclick", onTreemapDoubleClick);
  canvas.tabIndex = 0;
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const hit = treemapHit(event);
    if (hit?.node.path) openContextMenu(event, hit.node, "treemap");
    else hideContextMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!document.getElementById("file-context-menu").contains(event.target)) hideContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideContextMenu(true);
  });
  document.addEventListener("scroll", (event) => {
    if (!document.getElementById("file-context-menu").contains(event.target)) hideContextMenu();
  }, true);
  window.addEventListener("resize", () => hideContextMenu());
  document.getElementById("file-context-menu").addEventListener("keydown", onContextMenuKeyDown);
  new ResizeObserver(() => renderTreemap()).observe(canvas);
  document.getElementById("tree-body").addEventListener("keydown", onTreeKeyDown);
  document.getElementById("treemap-root").addEventListener("click", treemapHome);
  document.getElementById("treemap-up").addEventListener("click", treemapUp);

  // Listen for scan progress events
  EventsOn("scan:progress", onScanProgress);

  // Show initial placeholder
  document.getElementById("tree-body").innerHTML =
    '<div class="ai-placeholder">点击「浏览...」选择目录后扫描</div>';
  document.getElementById("scan-status").textContent = "就绪";
}

async function doBrowse() {
  try {
    const path = await BrowseDirectory();
    if (!path) return; // user cancelled
    document.getElementById("path-display").textContent = path;
    document.getElementById("path-display").dataset.path = path;
    document.getElementById("scan-btn").disabled = false;
  } catch (err) {
    document.getElementById("scan-status").textContent = "错误: " + err;
  }
}

function onScanProgress(data) {
  const status = document.getElementById("scan-status");
  const summary = document.getElementById("scan-summary");
  const progressBar = document.getElementById("scan-progress");
  const progressText = document.getElementById("scan-progress-text");
  const progressStats = document.getElementById("scan-progress-stats");
  const progressFill = progressBar.querySelector(".scan-progress-bar-fill");

  if (data.stage === "counting") {
    // Pass 1: counting files — total_files holds the growing count
    status.textContent = "统计文件数...";
    progressBar.style.display = "block";
    progressText.textContent = "统计文件中...";
    progressStats.textContent = `${formatCount(data.total_files || 0)} 项`;
    progressFill.classList.add("shimmer");
    progressFill.style.width = "";
  } else if (data.stage === "scanning") {
    // Pass 2: reading sizes
    status.textContent = "扫描中...";
    progressBar.style.display = "block";
    const cur = data.current || "";
    const displayPath = cur.length > 60 ? "..." + cur.substring(cur.length - 57) : cur;
    progressText.textContent = "扫描中: " + displayPath;
    progressStats.textContent =
      `${formatCount(data.file_count || 0)}/${formatCount(data.total_files || 0)} 文件 · ${formatSize(data.size || 0)}`;
    progressFill.classList.remove("shimmer");
    const pct = Math.min(100, Math.max(0, data.percent || 0));
    progressFill.style.width = pct.toFixed(1) + "%";
  } else if (data.stage === "done") {
    status.textContent = "扫描完成";
    progressBar.style.display = "none";
    summary.textContent =
      `${formatSize(data.size)} · ${formatCount(data.file_count)} 文件 · ${formatCount(data.dir_count)} 文件夹`;
  } else if (data.stage === "error") {
    status.textContent = "错误: " + (data.current || "未知");
    progressBar.style.display = "none";
  }
}

// --- Settings ---

async function openSettings() {
  try {
    const cfg = await GetConfig();
    document.getElementById("cfg-license-key").value = cfg.license_key || "";
    document.getElementById("cfg-ai-api-key").value = cfg.ai_api_key || "";
    document.getElementById("cfg-ai-base-url").value = cfg.ai_base_url || "https://api.openai.com/v1";
    document.getElementById("cfg-ai-model").value = cfg.ai_model || "gpt-4o-mini";
    document.getElementById("cfg-website-url").value = cfg.website_api_url || "https://your-server.example.com/api/diskvisor";

    const status = document.getElementById("license-status");
    if (cfg.license_valid) {
      status.textContent = `已验证 (${cfg.license_plan || "pro"})` + (cfg.license_expiry ? ` · 到期: ${cfg.license_expiry}` : "");
      status.className = "license-status valid";
    } else if (cfg.license_key) {
      status.textContent = "未验证";
      status.className = "license-status invalid";
    } else {
      status.textContent = "";
      status.className = "license-status";
    }
  } catch (err) {
    console.error("Failed to load config:", err);
  }
  document.getElementById("settings-modal").style.display = "flex";
}

function closeSettings() {
  document.getElementById("settings-modal").style.display = "none";
}

async function saveSettings() {
  const cfg = {
    license_key: document.getElementById("cfg-license-key").value.trim(),
    ai_api_key: document.getElementById("cfg-ai-api-key").value.trim(),
    ai_base_url: document.getElementById("cfg-ai-base-url").value.trim(),
    ai_model: document.getElementById("cfg-ai-model").value.trim(),
    website_api_url: document.getElementById("cfg-website-url").value.trim(),
    license_valid: false,
    license_expiry: "",
    license_plan: "",
  };
  try {
    const oldCfg = await GetConfig();
    if (oldCfg.license_key === cfg.license_key) {
      cfg.license_valid = oldCfg.license_valid;
      cfg.license_expiry = oldCfg.license_expiry || "";
      cfg.license_plan = oldCfg.license_plan || "";
    }
  } catch (e) {}
  try {
    await SaveConfig(cfg);
    closeSettings();
    // If there's already scan data, re-scan to refresh with new AI config
    if (scanData) {
      doScan();
    }
    // If a node was selected, re-analyze it with the new config
    if (selectedPath && scanData) {
      const node = findNodeByPath(scanData.root, selectedPath);
      if (node) {
        // Slight delay to let doScan start first
        setTimeout(() => selectNode(node), 200);
      }
    }
  } catch (err) {
    alert("保存失败: " + err);
  }
}

async function doValidateLicense() {
  const status = document.getElementById("license-status");
  const btn = document.getElementById("license-validate-btn");
  const cfg = {
    license_key: document.getElementById("cfg-license-key").value.trim(),
    ai_api_key: document.getElementById("cfg-ai-api-key").value.trim(),
    ai_base_url: document.getElementById("cfg-ai-base-url").value.trim(),
    ai_model: document.getElementById("cfg-ai-model").value.trim(),
    website_api_url: document.getElementById("cfg-website-url").value.trim(),
    license_valid: false,
    license_expiry: "",
    license_plan: "",
  };
  try { await SaveConfig(cfg); } catch (e) {}

  btn.disabled = true;
  status.textContent = "验证中...";
  status.className = "license-status checking";
  try {
    const result = await ValidateLicense();
    if (result.valid) {
      status.textContent = `验证成功 (${result.plan || "pro"})` + (result.expires_at ? ` · 到期: ${result.expires_at}` : "");
      status.className = "license-status valid";
    } else {
      status.textContent = result.error || "License 无效";
      status.className = "license-status invalid";
    }
  } catch (err) {
    status.textContent = "验证失败: " + err;
    status.className = "license-status invalid";
  } finally {
    btn.disabled = false;
  }
}

// --- Scan ---

async function doScan() {
  const path = document.getElementById("path-display").dataset.path;
  if (!path) return;
  const status = document.getElementById("scan-status");
  const btn = document.getElementById("scan-btn");
  const progressBar = document.getElementById("scan-progress");
  btn.disabled = true;
  status.textContent = "扫描中...";
  progressBar.style.display = "block";

  hideContextMenu();
  selectionJobs.reset();
  const generation = ++scanGeneration;
  scanData = null;
  treeStore.reset(null);
  selectedTreeRow = null;
  tmLayoutDirty = true;
  selectedPath = null;
  resetMediaPreview();
  treeRowStates.clear();
  document.getElementById("ai-selected").textContent = "";
  document.getElementById("ai-body").innerHTML = '<div class="ai-placeholder">扫描完成后，选择文件查看详情</div>';
  document.getElementById("action-info").textContent = "";
  for (const id of ["recycle-btn", "explorer-btn", "uninstall-btn"]) document.getElementById(id).disabled = true;
  // Clear old data immediately
  document.getElementById("tree-body").innerHTML = '<div class="ai-placeholder">扫描中...</div>';
  document.getElementById("scan-summary").textContent = "";
  treemapRects = [];
  treemapFocus = null;
  renderTreemap();

  try {
    // Scan runs in Go; progress events fire via EventsOn
    const result = await Scan(path);
    if (generation !== scanGeneration) return;
    result.root = treeStore.reset(result.root);
    scanData = result;

    treemapFocus = result.root;
    renderTree(result.root);
    // Treemap layout is expensive on large directories; schedule it on the
    // next animation frame so the directory tree paints first.
    renderTreemap();

    const methodTag = result.scan_method === "mft"
      ? ' · <span class="mft-badge">MFT 极速扫描</span>'
      : "";
    document.getElementById("scan-summary").innerHTML =
      `${formatSize(result.total_size)} · ${formatCount(result.file_count)} 文件 · ${formatCount(result.dir_count)} 文件夹${methodTag}`;
    status.textContent = "扫描完成";
    progressBar.style.display = "none";
  } catch (err) {
    status.textContent = "错误: " + err;
    progressBar.style.display = "none";
    document.getElementById("tree-body").innerHTML =
      `<div class="ai-placeholder">扫描失败: ${escapeHtml(String(err))}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// --- Tree rendering (lazy expand/collapse) ---

function renderTree(root) {
  const body = document.getElementById("tree-body");
  body.innerHTML = "";
  // Root only — keep collapsed so the first row does not show subdirs.
  // User clicks the toggle (▸) to expand.
  const rootRow = createTreeNode(root, 0, root.size);
  body.appendChild(rootRow.container);
  rootRow.container.tabIndex = 0;
  if (root.is_dir) toggleExpand(rootRow);
}

function createTreeNode(node, depth, parentSize) {
  const row = document.createElement("div");
  row.className = "tree-row";
  row.dataset.path = node.path;
  row.title = node.path;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(depth + 1));
  row.tabIndex = -1;
  row.dataset.depth = depth;   // used by collapse to know where to stop

  const indent = document.createElement("span");
  indent.style.width = depth * 16 + "px";
  indent.style.flexShrink = "0";

  const toggle = document.createElement("span");
  toggle.className = "tree-toggle";
  // Show toggle for any directory that either has loaded children OR is
  // lazy-loadable (file_count > 0 but children pruned by backend).
  const canExpand = node.is_dir;
  if (canExpand) {
    toggle.textContent = "▸"; // collapsed
    toggle.style.cursor = "pointer";
  }

  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = node.name;
  name.style.paddingLeft = "4px";

  const barContainer = document.createElement("span");
  barContainer.className = "tree-bar-container";
  const bar = document.createElement("span");
  bar.className = "tree-bar";
  const pct = parentSize > 0 ? (node.size / parentSize) * 100 : 0;
  bar.style.width = pct + "%";
  bar.style.background = getBarColor(node);
  barContainer.appendChild(bar);

  const size = document.createElement("span");
  size.className = "tree-size";
  size.textContent = formatSize(node.size);

  const percent = document.createElement("span");
  percent.className = "tree-percent";
  percent.textContent = pct.toFixed(1) + "%";

  row.appendChild(indent);
  row.appendChild(toggle);
  const kind = getFileKind(node);
  row.dataset.kind = kind.id;
  row.title = node.path + " · " + kind.label;
  row.appendChild(createFileIcon(node));
  row.appendChild(name);
  row.appendChild(barContainer);
  row.appendChild(size);
  row.appendChild(percent);

  // State for expand/collapse
  const state = { container: row, expanded: false, toggle, node, depth };
  if (node.path) treeRowStates.set(pathKey(node.path), state);
  if (node.is_dir) row.setAttribute("aria-expanded", "false");

  // Click on row: select this node (tree is the source, so it drives the Treemap)
  row.addEventListener("contextmenu", event => openContextMenu(event, node, "tree"));
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    row.focus({ preventScroll: true });
    selectNode(node, { source: "tree" });
  });

  // Click on toggle: expand/collapse children (lazy-loads from backend)
  if (canExpand) {
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleExpand(state);
    });
    // Also allow clicking the row to toggle
    row.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      drillInto(node);
    });
  }

  return state;
}

function collapseTreeRow(state) {
  let next = state.container.nextElementSibling;
  while (next && Number(next.dataset.depth) > state.depth) {
    const remove = next; next = next.nextElementSibling;
    treeRowStates.delete(pathKey(remove.dataset.path));
    remove.remove();
  }
  state.expanded = false;
  state.toggle.textContent = "▸";
  state.container.setAttribute("aria-expanded", "false");
}

async function toggleExpand(state) {
  if (!state.container.isConnected) return;
  if (state.loading) { state.cancelExpand = true; collapseTreeRow(state); return state.loading; }
  if (state.expanded) { collapseTreeRow(state); return; }
  state.cancelExpand = false;
  const generation = scanGeneration;
  state.loading = (async () => {
    state.toggle.textContent = "…";
    try {
      const children = await treeStore.load(state.node);
      if (generation !== scanGeneration || !state.container.isConnected || state.cancelExpand) return;
      const sorted = [...children].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
      state.expanded = true;
      state.container.setAttribute("aria-expanded", "true");
      state.toggle.textContent = children.length ? "▾" : "";
      let after = state.container;
      // Yield between batches so wide directories do not block clicks/paint.
      for (let offset = 0; offset < sorted.length; offset += 200) {
        if (generation !== scanGeneration || !state.container.isConnected || !state.expanded || state.cancelExpand) return;
        const fragment = document.createDocumentFragment();
        for (const child of sorted.slice(offset, offset + 200)) {
          const row = createTreeNode(child, state.depth + 1, state.node.size).container;
          fragment.appendChild(row);
        }
        const last = fragment.lastElementChild;
        // Preserve descendants if a visible child was expanded between batches.
        while (after.nextElementSibling && Number(after.nextElementSibling.dataset.depth) > state.depth + 1) {
          after = after.nextElementSibling;
        }
        after.after(fragment);
        if (last) after = last;
        if (offset + 200 < sorted.length) await new Promise(requestAnimationFrame);
      }
      setTreeSelection(selectedPath);
    } catch (err) {
      state.toggle.textContent = "▸";
      state.container.title = "目录加载失败，点击重试：" + String(err);
    }
  })().finally(() => { state.loading = null; });
  return state.loading;
}

function getBarColor(node) { return getFileKind(node).color; }

// --- Selection + AI analysis (async, non-blocking) ---

function setTreeSelection(path) {
  selectedTreeRow?.classList.remove("selected");
  if (selectedTreeRow) { selectedTreeRow.tabIndex = -1; selectedTreeRow.setAttribute("aria-selected", "false"); }
  const row = treeRowStates.get(pathKey(path))?.container;
  selectedTreeRow = row?.isConnected ? row : null;
  if (selectedTreeRow) { selectedTreeRow.classList.add("selected"); selectedTreeRow.tabIndex = 0; selectedTreeRow.setAttribute("aria-selected", "true"); }
}

const selectionJobs = createSelectionJobs({
  analyze: AnalyzePath,
  show: (node, result) => { renderAIPanel(node, result); updateActions(node, result); },
  failure: (err) => { document.getElementById("ai-body").textContent = "分析失败：" + String(err); },
  link: async (node, opts, stale) => {
    if (stale()) return;
    await Promise.all([
      opts.source === "tree" ? Promise.resolve() : revealTreePath(node.path, stale),
      opts.source === "treemap" ? renderTreemap() : ensureTreemapCovers(node.path, stale),
    ]);
    if (!stale()) { setTreeSelection(node.path); await renderTreemap(); }
  },
});

function selectNode(node, opts = {}) {
  if (!node?.path) return Promise.resolve();
  node = treeStore.get(node.path) || node;
  hideContextMenu();
  selectedPath = node.path;
  setTreeSelection(node.path);
  showMediaPreview(node);
  updateActionsInstant(node);
  document.getElementById("ai-selected").textContent = node.name;
  document.getElementById("ai-body").innerHTML = '<div class="ai-placeholder">正在分析，视图联动与预览可继续使用…</div>';
  renderTreemap(); // cached base image + selection overlay; no AI wait
  return selectionJobs.select(node, opts).catch(() => {});
}

async function onTreeKeyDown(event) {
  const row = event.target.closest(".tree-row");
  if (!row) return;
  const state = treeRowStates.get(pathKey(row.dataset.path));
  if (!state) return;
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    const rect = row.getBoundingClientRect();
    openContextMenu({ preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(), clientX: rect.left + 35, clientY: rect.bottom }, state.node, "tree");
    return;
  }
  let next;
  if (event.key === "ArrowDown") next = row.nextElementSibling;
  else if (event.key === "ArrowUp") next = row.previousElementSibling;
  else if (event.key === "ArrowRight" && state.node.is_dir) {
    event.preventDefault();
    if (!state.expanded) await toggleExpand(state);
    else next = row.nextElementSibling;
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (state.expanded) await toggleExpand(state);
    else next = treeRowStates.get(pathKey(parentPath(state.node.path)))?.container;
  } else if (event.key === "Enter" && state.node.is_dir) {
    event.preventDefault(); drillInto(state.node); return;
  } else return;
  if (next?.classList.contains("tree-row")) {
    event.preventDefault(); next.focus({ preventScroll: true });
    const target = treeRowStates.get(pathKey(next.dataset.path));
    if (target) selectNode(target.node, { source: "tree" });
    next.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
}

// Immediate action-bar state derived from the node alone (before AI returns).
// Heuristic: folders are deletable with a caution label; files deletable.
// The AI verdict (updateActions) refines this moments later.
function updateActionsInstant(node) {
  const recycleBtn = document.getElementById("recycle-btn");
  const explorerBtn = document.getElementById("explorer-btn");
  const uninstallBtn = document.getElementById("uninstall-btn");
  const info = document.getElementById("action-info");

  explorerBtn.disabled = false;
  uninstallBtn.disabled = true;

  if (node.is_dir) {
    recycleBtn.disabled = true;
    recycleBtn.textContent = "移到回收站 (谨慎)";
    info.textContent = `已选中文件夹 · ${formatSize(node.size)}${node.file_count ? " · " + formatCount(node.file_count) + " 项" : ""}`;
  } else {
    recycleBtn.disabled = true;
    recycleBtn.textContent = "移到回收站";
    info.textContent = `已选中 · ${formatSize(node.size)}`;
  }
}

function renderAIPanel(node, analysis) {
  const body = document.getElementById("ai-body");
  const safetyLabels = { safe: "可清理", caution: "谨慎处理", danger: "危险·别动", unknown: "未知" };
  const sourceLabels = { local: "规则库", "ai-direct": "AI直连", "ai-license": "AI代理" };

  let html = "";

  html += `<div class="ai-section">
    <div class="ai-label">路径</div>
    <div class="ai-value mono">${escapeHtml(node.path)}</div>
  </div>`;

  html += `<div class="ai-section">
    <div class="ai-label">大小 / 类型</div>
    <div class="ai-value primary">${formatSize(node.size)} · ${node.is_dir ? "文件夹" : "文件"}${node.file_count ? " · " + formatCount(node.file_count) + " 项" : ""}</div>
  </div>`;

  html += `<div class="ai-divider"></div>`;

  if (analysis.description) {
    const sourceBadge = analysis.source
      ? `<span class="ai-source-badge ${escapeHtml(["local", "ai-direct", "ai-license"].includes(analysis.source) ? analysis.source : "local")}">${escapeHtml(sourceLabels[analysis.source] || "Unknown")}</span>`
      : "";
    const cacheBadge = analysis.cached
      ? `<span class="ai-source-badge cached">缓存</span>`
      : "";
    html += `<div class="ai-section">
      <div class="ai-label">说明 ${sourceBadge}${cacheBadge}</div>
      <div class="ai-value">${escapeHtml(analysis.description)}</div>
    </div>`;
  }

  html += `<div class="ai-divider"></div>`;

  html += `<div class="ai-section">
    <div class="ai-label">清理建议</div>
    <div style="margin-bottom: 8px;">
      <span class="safety-badge ${escapeHtml(["safe", "caution", "danger", "unknown"].includes(analysis.safety) ? analysis.safety : "unknown")}">${safetyLabels[analysis.safety] || "未知"}</span>
      <span style="margin-left: 8px; color: var(--text-tertiary); font-size: 11px;">${escapeHtml(analysis.category || "")}</span>
    </div>
    <div class="ai-value">${escapeHtml(analysis.recommendation || "暂无建议")}</div>
  </div>`;

  if (analysis.cleanable_items && analysis.cleanable_items.length > 0) {
    html += `<div class="ai-divider"></div>`;
    html += `<div class="ai-section">
      <div class="ai-label">可清理子项 (${analysis.cleanable_items.length})</div>`;
    for (const item of analysis.cleanable_items) {
      html += `<div class="cleanable-item" data-path="${escapeHtml(item.path)}">
        <span class="ci-name">${escapeHtml(item.name)}</span>
        <span class="ci-size">${formatSize(item.size)}</span>
      </div>`;
    }
    html += `</div>`;
  }

  if (analysis.has_uninstaller) {
    html += `<div class="ai-divider"></div>`;
    html += `<div class="ai-section">
      <div class="ai-label">卸载程序</div>
      <div class="ai-value mono">${escapeHtml(analysis.uninstaller_path)}</div>
    </div>`;
  }

  body.innerHTML = html;

  body.querySelectorAll(".cleanable-item").forEach((el) => {
    el.addEventListener("click", () => {
      const p = el.dataset.path;
      const fakeNode = { path: p, name: el.querySelector(".ci-name").textContent, size: 0, is_dir: true };
      selectNode(fakeNode);
    });
  });
}

function updateActions(node, analysis) {
  const recycleBtn = document.getElementById("recycle-btn");
  const explorerBtn = document.getElementById("explorer-btn");
  const uninstallBtn = document.getElementById("uninstall-btn");
  const info = document.getElementById("action-info");

  explorerBtn.disabled = false;

  if (analysis.safety === "safe") {
    recycleBtn.disabled = false;
    recycleBtn.textContent = "移到回收站";
  } else if (analysis.safety === "caution") {
    recycleBtn.disabled = false;
    recycleBtn.textContent = "移到回收站 (谨慎)";
  } else {
    recycleBtn.disabled = true;
    recycleBtn.textContent = "移到回收站";
  }

  if (analysis.has_uninstaller) {
    uninstallBtn.disabled = false;
  } else {
    uninstallBtn.disabled = true;
  }

  if (analysis.cleanable_items && analysis.cleanable_items.length > 0) {
    const total = analysis.cleanable_items.reduce((s, i) => s + i.size, 0);
    info.textContent = `可回收 ${formatSize(total)} · ${analysis.cleanable_items.length} 项`;
  } else if (analysis.safety === "safe") {
    info.textContent = `可回收 ${formatSize(node.size)}`;
  } else {
    info.textContent = "";
  }
}

// --- Treemap (WizTree-style recursive subdivision) ---

const TM_MIN = 2;                    // stop subdividing below this many px
const TM_MAX_RECTS = 8000;           // hard cap on drawn rects (perf guard)
const TM_MAX_DEPTH = 6;              // avoid exponential recursion on deep trees
const TM_MAX_CHILDREN = 200;         // cap items per layout step (O(n²) guard)
let tmRectCount = 0;
let tmLayoutDirty = true;
let tmLastFocus = null;
let tmLastWidth = 0, tmLastHeight = 0, tmLastRatio = 0;
let tmBaseCanvas = document.createElement("canvas");
let tmRectsByPath = new Map();
const scheduleTreemap = createFrameBatcher(requestAnimationFrame, () => {
  const canvas = document.getElementById("treemap-canvas");
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  if (tmLayoutDirty || tmLastFocus !== treemapFocus || tmLastWidth !== rect.width || tmLastHeight !== rect.height || tmLastRatio !== ratio) {
    drawTreemapNow(canvas, rect);
    tmBaseCanvas.width = canvas.width; tmBaseCanvas.height = canvas.height;
    tmBaseCanvas.getContext("2d").drawImage(canvas, 0, 0);
    tmRectsByPath = new Map(treemapRects.filter(r => r.node.path).map(r => [pathKey(r.node.path), r]));
    tmLastFocus = treemapFocus; tmLastWidth = rect.width; tmLastHeight = rect.height; tmLastRatio = ratio;
    tmLayoutDirty = false;
  } else {
    const ctx = canvas.getContext("2d");
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(tmBaseCanvas, 0, 0); ctx.restore();
  }
  drawTreemapSelection();
  updateTreemapNav();
});

function parentPath(path) { return normPath(path).replace(/[\\/][^\\/]+$/, "") || scanData?.root.path; }
function treemapHome() { if (scanData?.root) drillInto(scanData.root); }
function treemapUp() {
  if (!scanData?.root || !treemapFocus || pathKey(treemapFocus.path) === pathKey(scanData.root.path)) return;
  const parent = treeStore.get(parentPath(treemapFocus.path)) || scanData.root;
  drillInto(parent);
}
function renderTreemap() { return scheduleTreemap(); }

function drawTreemapNow(canvas, rect) {
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  treemapRects = [];
  tmRectCount = 0;
  if (treemapFocus) {
    // Base rect = current focus. Reserve a header strip so the current
    // folder name is always visible, then subdivide children inward.
    const baseHdr = 14;
    const base = { node: treemapFocus, x: 0, y: 0, w: rect.width, h: rect.height, isBase: true, hasHeader: true, hdr: baseHdr };
    treemapRects.push(base);
    subdivide(treemapFocus, 0, baseHdr, rect.width, rect.height - baseHdr, 0);
  }

  // Pass 1: draw all blocks (files + undrilled folders).
  for (const r of treemapRects) {
    drawRect(ctx, r);
  }
  // Pass 2: draw folder chrome (header label + border) on top so folders
  // stay visible even when drilled open.
  for (const r of treemapRects) {
    if (r.hasHeader) drawFolderChrome(ctx, r);
  }
  updateTreemapNav();
}

// Recursively subdivide a directory node's children inside its rectangle.
// Uses a power-transformed weight (displayWeight) so small files are not
// squashed into invisible slivers by a single huge file. Each directory is
// drilled until its rectangle becomes too small; the global cap only limits
// depth, never dropping a sibling, so the canvas is always 100% filled.
//
// With lazy loading, directory nodes may not have children loaded yet —
// they show as solid blocks. Clicking them triggers GetChildren + re-render.
function subdivide(node, x, y, w, h, depth) {
  if (w < TM_MIN || h < TM_MIN || depth >= TM_MAX_DEPTH) return;
  // Skip subdivision if children haven't been loaded (lazy tree).
  if (!node.children || node.children.length === 0) return;
  const kids = prepareChildren(node);
  if (!kids.length) return;

  const rects = squarifyNodes(kids, x, y, w, h);
  for (const r of rects) {
    treemapRects.push(r);
    tmRectCount++;
    if (r.node.is_dir && r.node.children && r.node.children.length > 0 && tmRectCount < TM_MAX_RECTS) {
      // Big folders get a thin header strip so the folder name is visible;
      // smaller ones are drilled with no header (name implied by boundary).
      const hdr = (r.w > 36 && r.h > 24) ? 12 : 0;
      if (hdr > 0) {
        r.hasHeader = true;
        r.hdr = hdr;
        subdivide(r.node, r.x, r.y + hdr, r.w, r.h - hdr, depth + 1);
      } else {
        subdivide(r.node, r.x, r.y, r.w, r.h, depth + 1);
      }
    }
  }
}

// Prepare children for layout: sort by size, apply display weight, and cap
// the count so the O(n²) squarify step stays fast. Any overflow is merged
// into a single "Others" node so the parent rectangle is still 100% filled.
function prepareChildren(node) {
  const kids = (node.children || []).slice().sort((a, b) => b.size - a.size);
  if (kids.length <= TM_MAX_CHILDREN) return kids;

  let kept = kids.slice(0, TM_MAX_CHILDREN - 1);
  const target = kids.find(c => pathKey(c.path) === pathKey(selectedPath) || isDescendant(selectedPath, c.path));
  if (target && !kept.includes(target)) kept = [...kept.slice(0, -1), target];
  const keep = new Set(kept);
  const overflow = kids.filter(c => !keep.has(c));
  const othersSize = overflow.reduce((s, c) => s + c.size, 0);
  const others = {
    name: `其他 ${overflow.length} 项`,
    path: "",
    size: othersSize,
    is_dir: true,
    file_count: overflow.reduce((s, c) => s + c.file_count, 0),
    modified: 0,
    children: [],
  };
  kept.push(others);
  return kept;
}

function displayWeight(size) {
  // Power transform: compress dynamic range so 50 MB doesn't swallow 128 KB.
  // A value below 0.5 gives small files meaningful visibility while keeping
  // large files large. 0 bytes/empty folders get the same base weight as 1 byte.
  return Math.pow(Math.max(size, 1), 0.55);
}

function squarifyNodes(nodes, x, y, w, h) {
  const rects = [];
  if (!nodes.length || w <= TM_MIN || h <= TM_MIN) return rects;

  // Build weighted items so small files still get visible rectangles.
  let totalWeight = 0;
  const weighted = nodes.map(n => {
    const weight = displayWeight(n.size);
    totalWeight += weight;
    return { node: n, weight };
  });
  if (totalWeight <= 0) return rects;

  // Floor: every item gets at least ~1% of the parent's visual weight, but
  // cap the total floor so huge folders don't turn into a uniform grid.
  let floorWeight = totalWeight * 0.01;
  const floorTotal = floorWeight * weighted.length;
  if (floorTotal > totalWeight * 0.35) {
    floorWeight = (totalWeight * 0.35) / weighted.length;
  }
  for (const item of weighted) {
    item.weight = Math.max(item.weight, floorWeight);
  }

  let remaining = weighted;
  let curX = x, curY = y, curW = w, curH = h;

  while (remaining.length > 0 && curW > TM_MIN && curH > TM_MIN) {
    const remainingTotal = remaining.reduce((s, i) => s + i.weight, 0);
    const isHorizontal = curW >= curH;

    // Standard squarify: build a row greedily. Start a new row with the next
    // item, then keep adding items while the aspect ratio improves (or stays
    // acceptable). This is O(n²) total — far better than the previous O(n³).
    let row = [remaining[0]];
    let rowWeight = remaining[0].weight;
    let bestRatio = worstRatio(row, rowWeight, remainingTotal, curW, curH, isHorizontal);

    for (let i = 1; i < remaining.length; i++) {
      const testRow = row.concat(remaining[i]);
      const testWeight = rowWeight + remaining[i].weight;
      const ratio = worstRatio(testRow, testWeight, remainingTotal, curW, curH, isHorizontal);
      if (ratio > bestRatio) break;
      row = testRow;
      rowWeight = testWeight;
      bestRatio = ratio;
    }

    const rowFraction = rowWeight / remainingTotal;
    if (isHorizontal) {
      const rowW = curW * rowFraction;
      let curYY = curY;
      for (const item of row) {
        const itemH = curH * (item.weight / rowWeight);
        rects.push({ node: item.node, x: curX, y: curYY, w: rowW, h: itemH });
        curYY += itemH;
      }
      curX += rowW;
      curW -= rowW;
    } else {
      const rowH = curH * rowFraction;
      let curXX = curX;
      for (const item of row) {
        const itemW = curW * (item.weight / rowWeight);
        rects.push({ node: item.node, x: curXX, y: curY, w: itemW, h: rowH });
        curXX += itemW;
      }
      curY += rowH;
      curH -= rowH;
    }
    remaining = remaining.slice(row.length);
  }

  // Tail pass: if space ran out but items remain (the smallest files), cram
  // them into the leftover rectangle so nothing is dropped.
  if (remaining.length > 0 && curW > 0 && curH > 0) {
    const tailTotal = remaining.reduce((s, i) => s + i.weight, 0) || 1;
    let cy = curY;
    for (const item of remaining) {
      const ih = Math.max(1, curH * (item.weight / tailTotal));
      rects.push({ node: item.node, x: curX, y: cy, w: curW, h: ih });
      cy += ih;
    }
  }

  return rects;
}

function worstRatio(row, rowWeight, total, w, h, isHorizontal) {
  const area = (rowWeight / total) * w * h;
  if (area <= 0 || rowWeight <= 0) return Infinity;
  const rowLen = isHorizontal ? h : w;
  const rowThickness = area / rowLen;
  let worst = 0;
  for (const item of row) {
    const itemArea = (item.weight / rowWeight) * area;
    const ratio = Math.max(itemArea / (rowThickness * rowThickness), (rowThickness * rowThickness) / itemArea);
    worst = Math.max(worst, ratio);
  }
  return worst;
}

// --- Color helpers (hex-based, for neon gradients) ---
function hexToRgb(hex) {
  const num = parseInt(hex.slice(1), 16);
  return { r: num >> 16, g: (num >> 8) & 0xff, b: num & 0xff };
}

function rgbStr(c, a) {
  return a === undefined
    ? `rgb(${c.r},${c.g},${c.b})`
    : `rgba(${c.r},${c.g},${c.b},${a})`;
}

function mixColor(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

// Lighten (amt > 0) or darken (amt < 0) a #rrggbb color, returning hex.
function shadeHex(hex, amt) {
  const num = parseInt(hex.slice(1), 16);
  const clamp = (v) => Math.min(255, Math.max(0, v));
  const r = clamp((num >> 16) + amt);
  const g = clamp(((num >> 8) & 0xff) + amt);
  const b = clamp((num & 0xff) + amt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// Shared type colour: independent of name, directory, file size and scan order.
function baseHexForNode(node) { return getFileKind(node).color; }

// Corner radius for treemap blocks (auto-clamps to half the smallest side
// so tiny slivers become pills instead of breaking).
const TM_RADIUS = 5;

// Trace a rounded-rectangle path (does NOT fill/stroke).
function roundRectPath(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Neon-gradient + embossed (relief) rounded block. A diagonal gradient runs
// from a bright neon highlight (top-left) through the base hue to a deep
// shadow (bottom-right); a light inner edge on top/left and a dark inner edge
// on bottom/right give the raised, beveled "relief" feel. Everything is
// clipped to a rounded-rectangle path.
function drawNeonBlock(ctx, r, baseHex) {
  const { x, y, w, h } = r;
  const base = hexToRgb(baseHex);
  const bright = mixColor(base, { r: 255, g: 255, b: 255 }, 0.45);
  const deep = mixColor(base, { r: 6, g: 8, b: 16 }, 0.52);

  ctx.save();
  roundRectPath(ctx, x, y, w, h, TM_RADIUS);
  ctx.clip();

  // Gradient fill.
  const grad = ctx.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, rgbStr(bright));
  grad.addColorStop(0.5, rgbStr(base));
  grad.addColorStop(1, rgbStr(deep));
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // Relief: light inner edge along top + left (clipped to the rounded shape).
  ctx.strokeStyle = rgbStr(mixColor(bright, { r: 255, g: 255, b: 255 }, 0.4), 0.85);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, y + h - 1);
  ctx.lineTo(x + 0.5, y + 0.5);
  ctx.lineTo(x + w - 1, y + 0.5);
  ctx.stroke();

  // Relief: dark inner edge along bottom + right.
  ctx.strokeStyle = rgbStr(mixColor(deep, { r: 0, g: 0, b: 0 }, 0.45), 0.85);
  ctx.beginPath();
  ctx.moveTo(x + w - 0.5, y + 1);
  ctx.lineTo(x + w - 0.5, y + h - 0.5);
  ctx.lineTo(x + 1, y + h - 0.5);
  ctx.stroke();

  ctx.restore();

  // Subtle dark outline so adjacent rounded blocks stay visually distinct.
  roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, TM_RADIUS);
  ctx.strokeStyle = "rgba(8,12,16,0.55)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawRect(ctx, r) {
  const node = r.node;
  drawNeonBlock(ctx, r, baseHexForNode(node));

  // Lazy-load hint: a folder that has children on disk but none loaded yet
  // gets a diagonal hatch so the user knows clicking will expand it.
  if (node.is_dir && node.file_count > 0 && (!node.children || node.children.length === 0) && r.w > 16 && r.h > 16) {
    ctx.save();
    roundRectPath(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, TM_RADIUS);
    ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,0.20)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let d = -r.h; d < r.w; d += 7) {
      ctx.moveTo(r.x + d, r.y + r.h);
      ctx.lineTo(r.x + d + r.h, r.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Labels: draw twice (dark offset then light) for an embossed look that
  // stays legible over both bright and dark regions of the gradient.
  if (r.w > 28 && r.h > 12) {
    ctx.textBaseline = "top";
    ctx.font = node.is_dir
      ? "600 13px 'Segoe UI', 'Microsoft YaHei', sans-serif"
      : "12px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    const name = node.name.length > 18 ? node.name.substring(0, 16) + "…" : node.name;
    // Shadow pass.
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillText(name, r.x + 3, r.y + 3);
    // Light pass.
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(name, r.x + 3, r.y + 2);
    if (r.h > 26) {
      ctx.font = "11px 'Segoe UI', 'Microsoft YaHei', sans-serif";
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillText(formatSize(node.size), r.x + 3, r.y + 15);
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.fillText(formatSize(node.size), r.x + 3, r.y + 14);
    }
  }
}

// Folder chrome: a neon header strip (folder name) drawn on top of a
// drilled-open folder so the folder stays visible, plus an embossed frame.
function drawFolderChrome(ctx, r) {
  const hdr = r.hdr || 12;
  const hue = getFileKind(r.node).color;
  const base = hexToRgb(hue);
  const bright = mixColor(base, { r: 255, g: 255, b: 255 }, 0.32);
  const deep = mixColor(base, { r: 6, g: 8, b: 16 }, 0.35);

  // Neon gradient strip (clipped to the block's rounded shape so the top
  // corners follow the same radius as the block).
  ctx.save();
  roundRectPath(ctx, r.x, r.y, r.w, r.h, TM_RADIUS);
  ctx.clip();
  const grad = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y);
  grad.addColorStop(0, rgbStr(bright));
  grad.addColorStop(1, rgbStr(deep));
  ctx.fillStyle = grad;
  ctx.fillRect(r.x, r.y, r.w, hdr);

  // Embossed top edge (light) + bottom edge (dark) of the strip.
  ctx.strokeStyle = rgbStr(mixColor(bright, { r: 255, g: 255, b: 255 }, 0.4), 0.8);
  ctx.beginPath();
  ctx.moveTo(r.x + 0.5, r.y + 0.5);
  ctx.lineTo(r.x + r.w - 1, r.y + 0.5);
  ctx.stroke();
  ctx.strokeStyle = rgbStr(mixColor(deep, { r: 0, g: 0, b: 0 }, 0.45), 0.8);
  ctx.beginPath();
  ctx.moveTo(r.x + 1, r.y + hdr - 0.5);
  ctx.lineTo(r.x + r.w - 0.5, r.y + hdr - 0.5);
  ctx.stroke();
  ctx.restore();

  // Folder name (embossed).
  ctx.textBaseline = "top";
  ctx.font = "600 11px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  const name = r.node.name.length > 24 ? r.node.name.substring(0, 22) + "…" : r.node.name;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillText(name, r.x + 4, r.y + 3);
  ctx.fillStyle = "rgba(255,255,255,0.97)";
  ctx.fillText(name, r.x + 4, r.y + 2);

  // Embossed outer frame around the whole folder block (rounded).
  roundRectPath(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, TM_RADIUS);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ---- Bidirectional linkage helpers ----

// Reveal a node's row in the directory tree: lazily expand every ancestor
// (root -> target's parent) and scroll the target row into view. Idempotent —
// already-expanded ancestors are skipped. Used when the Treemap drives selection.
async function revealTreePath(path, stale = () => false) {
  if (!scanData?.root) return;
  const existing = treeRowStates.get(pathKey(path));
  if (existing?.container.isConnected) { setTreeSelection(path); scrollTreeRowIntoView(path); return; }
  let cur = scanData.root;
  for (const segment of pathSegments(path, cur.path)) {
    if (stale()) return;
    const state = treeRowStates.get(pathKey(cur.path));
    if (!state) return;
    if (state.loading) await state.loading;
    if (stale()) return;
    if (!state.expanded) await toggleExpand(state);
    if (stale()) return;
    cur = (cur.children || []).find(child => child.name.toLowerCase() === segment.toLowerCase());
    if (!cur) return;
  }
  if (!stale()) { setTreeSelection(path); scrollTreeRowIntoView(path); }
}

function scrollTreeRowIntoView(path) {
  treeRowStates.get(pathKey(path))?.container.scrollIntoView({ block: "nearest", behavior: "instant" });
}

async function ensureTreemapCovers(path, stale = () => false) {
  if (stale()) return;
  if (!scanData?.root) return;
  const root = scanData.root;
  if (pathKey(path) === pathKey(root.path)) { treemapFocus = root; return renderTreemap(); }
  if (!isDescendant(path, root.path)) return;
  if (tmLastFocus === treemapFocus && tmRectsByPath.has(pathKey(path))) return renderTreemap();
  let cur = root;
  const segments = pathSegments(path, root.path);
  for (let i = 0; i < segments.length - 1; i++) {
    await treeStore.load(cur);
    if (stale()) return;
    const next = cur.children.find(child => child.name.toLowerCase() === segments[i].toLowerCase());
    if (!next) return;
    cur = next;
  }
  await treeStore.load(cur);
  if (stale()) return;
  treemapFocus = cur;
  tmLayoutDirty = true;
  await renderTreemap();
}

function treemapHit(event) {
  const box = document.getElementById("treemap-canvas").getBoundingClientRect();
  const x = event.clientX - box.left, y = event.clientY - box.top;
  for (let i = treemapRects.length - 1; i >= 0; i--) {
    const r = treemapRects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
}
function onTreemapClick(event) {
  const hit = treemapHit(event);
  if (hit?.node.path) selectNode(hit.node, { source: "treemap" });
}
function onTreemapDoubleClick(event) {
  const hit = treemapHit(event);
  if (hit?.node.is_dir && hit.node.path) drillInto(hit.node);
  else if (hit && !hit.node.path && treemapFocus) drillInto(treemapFocus);
}
async function drillInto(node) {
  const generation = scanGeneration;
  const selected = selectNode(node, { source: "treemap" });
  const path = node.path;
  try {
    await treeStore.load(node);
    if (generation !== scanGeneration || pathKey(selectedPath) !== pathKey(path)) return;
    treemapFocus = treeStore.get(path) || node;
    tmLayoutDirty = true;
    await renderTreemap();
    await selected;
  } catch (err) { document.getElementById("scan-status").textContent = "目录加载失败，可重试"; }
}
function drawTreemapSelection() {
  const r = tmRectsByPath.get(pathKey(selectedPath));
  if (!r) return;
  const ctx = document.getElementById("treemap-canvas").getContext("2d");
  ctx.save(); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 4;
  roundRectPath(ctx, r.x + 2, r.y + 2, Math.max(1, r.w - 4), Math.max(1, r.h - 4), TM_RADIUS); ctx.stroke();
  ctx.strokeStyle = "#00c389"; ctx.lineWidth = 2;
  roundRectPath(ctx, r.x + 2, r.y + 2, Math.max(1, r.w - 4), Math.max(1, r.h - 4), TM_RADIUS); ctx.stroke(); ctx.restore();
}
function updateTreemapNav() {
  const nav = document.getElementById("treemap-nav");
  const crumbs = nav?.querySelector(".treemap-crumb");
  if (!nav || !crumbs) return;
  nav.style.display = "inline-flex";
  const root = scanData?.root;
  const focus = treemapFocus;
  const signature = focus?.path || "";
  if (crumbs.dataset.path !== signature) {
    crumbs.dataset.path = signature;
    crumbs.replaceChildren();
    if (root && focus) {
      let path = root.path;
      const parts = [{ name: root.name || root.path, path }];
      for (const name of pathSegments(focus.path, root.path)) { path = joinPath(path, name); parts.push({ name, path }); }
      for (const part of parts) {
        const button = document.createElement("button");
        button.className = "treemap-breadcrumb"; button.textContent = part.name; button.title = part.path;
        button.addEventListener("click", () => { const node = treeStore.get(part.path); if (node) drillInto(node); });
        crumbs.append(button);
      }
    }
  }
  const atRoot = !root || !focus || pathKey(focus.path) === pathKey(root.path);
  document.getElementById("treemap-up").disabled = atRoot;
  document.getElementById("treemap-root").disabled = atRoot;
}

// Context-menu actions always operate on the item that opened the menu.
function hideContextMenu(restoreFocus = false) {
  const menu = document.getElementById("file-context-menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  contextTarget = null;
  if (restoreFocus && contextReturnFocus?.isConnected) contextReturnFocus.focus({ preventScroll: true });
}

function openContextMenu(event, node, source) {
  event.preventDefault();
  event.stopPropagation();
  if (!node?.path) return;
  if (pathKey(selectedPath) !== pathKey(node.path)) selectNode(node, { source });
  contextTarget = treeStore.get(node.path) || node;
  contextReturnFocus = source === "tree" ? treeRowStates.get(pathKey(node.path))?.container : document.getElementById("treemap-canvas");
  const menu = document.getElementById("file-context-menu");
  document.getElementById("context-file-name").textContent = node.name;
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8)) + "px";
  menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}

function onContextMenuKeyDown(event) {
  const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled)")];
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement);
  let next;
  if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
  else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else if (event.key === "Tab") { hideContextMenu(true); return; }
  else return;
  event.preventDefault();
  buttons[next].focus();
}

// --- Actions ---

async function doRecycle() {
  if (!selectedPath || document.getElementById("recycle-btn").disabled) return;
  const path = contextTarget?.path || selectedPath;
  hideContextMenu();
  if (!confirm(`确定将以下项目移到回收站？\n\n${path}`)) return;
  try {
    document.getElementById("recycle-btn").disabled = true;
    await MoveToRecycleBin(path);
    document.getElementById("action-info").textContent = "已移到回收站";
    setTimeout(() => doScan(), 500);
  } catch (err) {
    alert("操作失败: " + err);
  }
}

async function doExplorer() {
  const path = contextTarget?.path || selectedPath;
  if (!path) return;
  hideContextMenu();
  try {
    await OpenInExplorer(path);
  } catch (err) {
    alert("无法打开: " + err);
  }
}

async function doUninstall() {
  const path = contextTarget?.path || selectedPath;
  if (!path || document.getElementById("uninstall-btn").disabled) return;
  hideContextMenu();
  try {
    const analysis = await AnalyzePath(path);
    if (analysis.has_uninstaller) {
      if (confirm(`确定运行卸载程序？\n\n${analysis.uninstaller_path}`)) {
        await RunUninstaller(analysis.uninstaller_path);
      }
    }
  } catch (err) {
    alert("无法运行卸载程序: " + err);
  }
}

// --- Utils ---

function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + " " + units[i];
}

function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function findNodeByPath(node, path) {
  if (node.path === path) return node;
  for (const child of node.children || []) {
    const found = findNodeByPath(child, path);
    if (found) return found;
  }
  return null;
}

init();
