import "./style.css";
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
  document.getElementById("treemap-up").addEventListener("click", treemapHome);

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

  // Clear old data immediately
  document.getElementById("tree-body").innerHTML = '<div class="ai-placeholder">扫描中...</div>';
  document.getElementById("scan-summary").textContent = "";
  treemapRects = [];
  treemapFocus = null;
  renderTreemap();

  try {
    // Scan runs in Go; progress events fire via EventsOn
    const result = await Scan(path);
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
      `<div class="ai-placeholder">扫描失败: ${err}</div>`;
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
}

function createTreeNode(node, depth, parentSize) {
  const row = document.createElement("div");
  row.className = "tree-row";
  row.dataset.path = node.path;
  row.dataset.depth = depth;   // used by collapse to know where to stop

  const indent = document.createElement("span");
  indent.style.width = depth * 16 + "px";
  indent.style.flexShrink = "0";

  const toggle = document.createElement("span");
  toggle.className = "tree-toggle";
  // Show toggle for any directory that either has loaded children OR is
  // lazy-loadable (file_count > 0 but children pruned by backend).
  const canExpand = node.is_dir && (node.file_count > 0 || (node.children && node.children.length > 0));
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
  row.appendChild(name);
  row.appendChild(barContainer);
  row.appendChild(size);
  row.appendChild(percent);

  // State for expand/collapse
  const state = { container: row, expanded: false, toggle, node, depth };
  if (node.path) treeRowStates.set(pathKey(node.path), state);

  // Click on row: select this node (tree is the source, so it drives the Treemap)
  row.addEventListener("click", (e) => {
    e.stopPropagation();
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
      toggleExpand(state);
    });
  }

  return state;
}

async function toggleExpand(state) {
  if (state.expanded) {
    // Collapse: remove only THIS node's descendant rows. Stop as soon as we
    // hit a sibling or ancestor (a row whose depth is <= our depth), so we
    // never delete following siblings of the same level.
    const container = state.container;
    let next = container.nextElementSibling;
    while (next) {
      const nextDepth = parseInt(next.dataset.depth, 10);
      // Stop at a sibling/ancestor (depth <= ours) or any row without a depth.
      if (isNaN(nextDepth) || nextDepth <= state.depth) break;
      const toRemove = next;
      next = next.nextElementSibling;
      // Unregister the row state so stale DOM refs never resurface.
      if (toRemove.dataset.path) treeRowStates.delete(pathKey(toRemove.dataset.path));
      toRemove.remove();
    }
    state.expanded = false;
    state.toggle.textContent = "▸";
  } else {
    // Expand: insert children after this row.
    // If children haven't been loaded yet (lazy tree), fetch from backend.
    let children = state.node.children;
    if ((!children || children.length === 0) && state.node.is_dir && state.node.file_count > 0) {
      state.toggle.textContent = "◂";
      try {
        children = await GetChildren(state.node.path);
        state.node.children = children;
      } catch (err) {
        state.toggle.textContent = "▸";
        return;
      }
    }
    if (!children || children.length === 0) {
      state.toggle.textContent = "";
      return;
    }
    const sorted = [...children].sort((a, b) => b.size - a.size);
    const frag = document.createDocumentFragment();
    for (const child of sorted) {
      const childEl = createTreeNode(child, state.depth + 1, state.node.size);
      frag.appendChild(childEl.container);
    }
    // Insert after the current row
    state.container.after(frag);
    state.expanded = true;
    state.toggle.textContent = "▾";
  }
}

function getBarColor(node) {
  if (node.size > 10 * 1024 * 1024 * 1024) return "#d85a30";
  if (node.size > 1 * 1024 * 1024 * 1024) return "#ba7517";
  if (node.size > 100 * 1024 * 1024) return "#1d9e75";
  return "#534ab7";
}

// --- Selection + AI analysis (async, non-blocking) ---

let aiRequestSeq = 0;

async function selectNode(node, opts = {}) {
  selectedPath = node.path;

  // ---- Instant visual sync: tree row highlight + action bar state ----
  document.querySelectorAll(".tree-row").forEach((r) => r.classList.remove("selected"));
  const rowKey = pathKey(node.path);
  let row = null;
  const state = treeRowStates.get(rowKey);
  if (state && state.container.isConnected) row = state.container;
  else row = document.querySelector(`.tree-row[data-path="${CSS.escape(node.path)}"]`);
  if (row) row.classList.add("selected");

  // Action bar reacts immediately from the node itself — no waiting on AI.
  updateActionsInstant(node);

  // Immediately show basic info (instant, no waiting)
  const aiBody = document.getElementById("ai-body");
  const aiSelected = document.getElementById("ai-selected");
  aiSelected.textContent = node.name;

  const seq = ++aiRequestSeq;
  aiBody.innerHTML = '<div class="ai-placeholder">分析中...</div>';

  try {
    const result = await AnalyzePath(node.path);
    // Check if a newer request superseded this one
    if (seq !== aiRequestSeq) return;

    renderAIPanel(node, result);
    // Refine action bar with AI verdict (may relax/lock the recycle button).
    updateActions(node, result);
  } catch (err) {
    if (seq !== aiRequestSeq) return;
    aiBody.innerHTML = `<div class="ai-placeholder">分析失败: ${err}</div>`;
  }

  // ---- Cross-panel linkage (async, non-blocking) ----
  // Every step carries a stale-guard so a newer selection cancels in-flight
  // linkage from an older one (e.g. rapid clicking while ancestors load).
  const isStale = () => seq !== aiRequestSeq;
  if (opts.source !== "tree") {
    // Selection came from the Treemap (or elsewhere): reveal the tree row —
    // expand ancestor rows lazily and scroll it into view.
    revealTreePath(node.path, isStale).catch(() => {});
  }
  if (opts.source !== "treemap") {
    // Selection came from the tree: make sure the Treemap shows this block
    // (drilling down through not-yet-loaded ancestors) and highlights it.
    try {
      await ensureTreemapCovers(node.path, isStale);
    } catch (e) { /* best effort */ }
    if (isStale()) return;
  }
  await highlightTreemap(node.path);
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
    recycleBtn.disabled = false;
    recycleBtn.textContent = "移到回收站 (谨慎)";
    info.textContent = `已选中文件夹 · ${formatSize(node.size)}${node.file_count ? " · " + formatCount(node.file_count) + " 项" : ""}`;
  } else {
    recycleBtn.disabled = false;
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
      ? `<span class="ai-source-badge ${analysis.source}">${sourceLabels[analysis.source] || analysis.source}</span>`
      : "";
    html += `<div class="ai-section">
      <div class="ai-label">说明 ${sourceBadge}</div>
      <div class="ai-value">${escapeHtml(analysis.description)}</div>
    </div>`;
  }

  html += `<div class="ai-divider"></div>`;

  html += `<div class="ai-section">
    <div class="ai-label">清理建议</div>
    <div style="margin-bottom: 8px;">
      <span class="safety-badge ${analysis.safety}">${safetyLabels[analysis.safety] || "未知"}</span>
      <span style="margin-left: 8px; color: var(--text-tertiary); font-size: 11px;">${analysis.category || ""}</span>
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
let tmRenderFrame = 0;

function treemapHome() {
  if (!scanData || !scanData.root) return;
  treemapFocus = scanData.root;
  renderTreemap();
}

function renderTreemap() {
  const canvas = document.getElementById("treemap-canvas");
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return Promise.resolve();

  // Cancel any pending render so the latest focus wins.
  if (tmRenderFrame) cancelAnimationFrame(tmRenderFrame);
  return new Promise((resolve) => {
    tmRenderFrame = requestAnimationFrame(() => {
      tmRenderFrame = 0;
      drawTreemapNow(canvas, rect);
      resolve();
    });
  });
}

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

  const kept = kids.slice(0, TM_MAX_CHILDREN - 1);
  const overflow = kids.slice(TM_MAX_CHILDREN - 1);
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

// Curated mid-saturation palette tuned for the dark theme.
// Every block gets a hue from here — gray blocks are gone.
const TM_PALETTE = [
  "#2e9e77", "#3d7fd9", "#b0862c", "#8a6fd1", "#c96a3c", "#3f9fb5",
  "#c4586f", "#6c9a34", "#5770e0", "#b57638", "#2fa3a0", "#a06298"
];

function tmHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
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

// Base hue for a node (hex). Directories get a darker tint of their own hue;
// files are keyed by extension with a per-file lightness jitter.
function baseHexForNode(node) {
  if (node.is_dir) {
    return shadeHex(TM_PALETTE[tmHash(node.name) % TM_PALETTE.length], -46);
  }
  const ext = (node.name.split(".").pop() || "").toLowerCase();
  const h = tmHash(ext || node.name);
  const jitter = ((h >>> 7) % 25) - 12;
  return shadeHex(TM_PALETTE[h % TM_PALETTE.length], jitter);
}

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
      ? "600 11px 'Segoe UI', 'Microsoft YaHei', sans-serif"
      : "10px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    const name = node.name.length > 18 ? node.name.substring(0, 16) + "…" : node.name;
    // Shadow pass.
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillText(name, r.x + 3, r.y + 3);
    // Light pass.
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(name, r.x + 3, r.y + 2);
    if (r.h > 26) {
      ctx.font = "9px 'Segoe UI', 'Microsoft YaHei', sans-serif";
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
  const hue = TM_PALETTE[tmHash(r.node.name) % TM_PALETTE.length];
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
async function revealTreePath(path, isStale = () => false) {
  if (!scanData || !scanData.root) return;
  const rootPath = scanData.root.path;
  if (path === rootPath || !isDescendant(path, rootPath)) {
    scrollTreeRowIntoView(path);
    return;
  }

  const segs = pathSegments(path, rootPath);
  let cur = scanData.root;
  // Expand root, segs[0]-node, ..., segs[n-2]-node. After the loop, `cur` is
  // the target and its row has just been inserted by the last expansion.
  for (let i = 0; i < segs.length; i++) {
    if (isStale()) return;
    const st = treeRowStates.get(pathKey(cur.path));
    if (!st) break;
    if (!st.expanded) {
      await toggleExpand(st);   // handles lazy GetChildren internally
    }
    const nextSeg = segs[i].toLowerCase();
    const child = (cur.children || []).find(
      (c) => c.name && c.name.toLowerCase() === nextSeg
    );
    if (!child) break;
    cur = child;
  }

  if (isStale()) return;
  scrollTreeRowIntoView(path);
}

function scrollTreeRowIntoView(path) {
  const st = treeRowStates.get(pathKey(path));
  if (st && st.container.isConnected) {
    st.container.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  const row = document.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
  if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// Ensure the Treemap's current focus rectangle covers `path`, drilling down
// through any ancestors whose children haven't been lazy-loaded yet. The focus
// ends on the target's parent, so the target itself is drawn as a block that
// highlightTreemap() can then outline.
async function ensureTreemapCovers(path, isStale = () => false) {
  if (!scanData || !scanData.root) return;
  const rootPath = scanData.root.path;
  if (path !== rootPath && !isDescendant(path, rootPath)) return;

  const segs = path === rootPath ? [] : pathSegments(path, rootPath);
  if (segs.length === 0) {
    // Target is the scan root — just park the focus at the root.
    if (treemapFocus !== scanData.root) {
      treemapFocus = scanData.root;
      await renderTreemap();
    }
    return;
  }

  // Start from the deepest node that is already an ancestor of the target:
  // the current treemap focus if it is one, otherwise the scan root.
  let cur = scanData.root;
  let startIdx = 0;
  if (treemapFocus && treemapFocus !== scanData.root && isDescendant(path, treemapFocus.path)) {
    cur = treemapFocus;
    startIdx = pathSegments(treemapFocus.path, rootPath).length;
  } else if (treemapFocus !== scanData.root) {
    // Target lives outside the current (deeper) focus — zoom back to root.
    treemapFocus = scanData.root;
    await renderTreemap();
  }

  // Drill focus down one level per segment, stopping at the target's parent.
  for (let i = startIdx; i < segs.length - 1; i++) {
    if (isStale()) return;
    if ((!cur.children || cur.children.length === 0) && cur.file_count > 0) {
      try { cur.children = await GetChildren(cur.path); } catch (e) { return; }
    }
    const nextSeg = segs[i].toLowerCase();
    const child = (cur.children || []).find(
      (c) => c.name && c.name.toLowerCase() === nextSeg
    );
    if (!child) return;
    cur = child;
    // Pre-load the child's contents so the drilled frame is never empty.
    if ((!cur.children || cur.children.length === 0) && cur.file_count > 0) {
      try { cur.children = await GetChildren(cur.path); } catch (e) { /* continue */ }
    }
    if (treemapFocus !== cur) {
      treemapFocus = cur;
      await renderTreemap();
    }
  }

  // Safety: if the loop ran zero times, the focus may not have its children
  // loaded yet — load them so the target block actually gets drawn.
  if (cur && (!cur.children || cur.children.length === 0) && cur.file_count > 0) {
    try { cur.children = await GetChildren(cur.path); } catch (e) { /* best effort */ }
  }
}

async function onTreemapClick(e) {
  const canvas = document.getElementById("treemap-canvas");
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  // Hit-test topmost-first (last drawn = on top). Skip the full-canvas base rect.
  for (let i = treemapRects.length - 1; i >= 0; i--) {
    const r = treemapRects[i];
    if (r.isBase) continue;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      if (r.node.is_dir) {
        // Lazy-load children if not yet fetched, then drill in.
        if ((!r.node.children || r.node.children.length === 0) && r.node.file_count > 0) {
          try {
            r.node.children = await GetChildren(r.node.path);
          } catch (err) {
            // Load failed — fall through to selectNode
          }
        }
        if (r.node.children && r.node.children.length > 0) {
          treemapFocus = r.node;
          await renderTreemap();
          // Drilling into a folder also selects it (two-way sync to the tree).
          selectNode(r.node, { source: "treemap" });
        } else if (r.node.path) {
          selectNode(r.node, { source: "treemap" });
        }
      } else if (r.node.path) {
        selectNode(r.node, { source: "treemap" });
      }
      return;
    }
  }
}

async function highlightTreemap(path) {
  await renderTreemap();
  for (const r of treemapRects) {
    if (r.node && r.node.path === path) {
      const ctx = document.getElementById("treemap-canvas").getContext("2d");
      // Neon selection: soft outer glow + a bright inner stroke (rounded).
      ctx.save();
      ctx.shadowColor = "rgba(93, 226, 190, 0.9)";
      ctx.shadowBlur = 10;
      ctx.strokeStyle = "rgba(93, 226, 190, 0.95)";
      ctx.lineWidth = 2;
      roundRectPath(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, TM_RADIUS);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 1;
      roundRectPath(ctx, r.x + 2.5, r.y + 2.5, r.w - 5, r.h - 5, TM_RADIUS);
      ctx.stroke();
      ctx.restore();
      break;
    }
  }
}

function updateTreemapNav() {
  const nav = document.getElementById("treemap-nav");
  if (!nav) return;
  if (treemapFocus && scanData && treemapFocus.path !== scanData.root.path) {
    nav.style.display = "inline-flex";
    nav.querySelector(".treemap-crumb").textContent = treemapFocus.path;
  } else {
    nav.style.display = "none";
  }
}

// --- Actions ---

async function doRecycle() {
  if (!selectedPath) return;
  if (!confirm(`确定将以下项目移到回收站？\n\n${selectedPath}`)) return;
  try {
    await MoveToRecycleBin(selectedPath);
    document.getElementById("action-info").textContent = "已移到回收站";
    setTimeout(() => doScan(), 500);
  } catch (err) {
    alert("操作失败: " + err);
  }
}

async function doExplorer() {
  if (!selectedPath) return;
  try {
    await OpenInExplorer(selectedPath);
  } catch (err) {
    alert("无法打开: " + err);
  }
}

async function doUninstall() {
  if (!selectedPath) return;
  try {
    const analysis = await AnalyzePath(selectedPath);
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
  return div.innerHTML;
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
