let requestID = 0;
let textRequest = null;

export function resetMediaPreview() {
  requestID++;
  if (textRequest) { textRequest.abort(); textRequest = null; }
  const host = document.getElementById("media-preview");
  const video = host.querySelector("video");
  if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
  message(host, "文件预览", "选择文本、图片或视频，即可在这里查看内容。");
  return host;
}

function message(host, title, detail) {
  const box = document.createElement("div");
  box.className = "preview-idle";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const caption = document.createElement("p");
  caption.textContent = detail;
  box.append(heading, caption);
  host.replaceChildren(box);
}

function renderTextPreview(host, name, data) {
  const header = document.createElement("div");
  header.className = "preview-text-header";
  const title = document.createElement("strong");
  title.textContent = name;
  title.title = name;
  const wrap = document.createElement("button");
  wrap.className = "btn btn-secondary btn-sm";
  wrap.textContent = "自动换行";
  wrap.type = "button";
  wrap.setAttribute("aria-pressed", "true");
  const content = document.createElement("pre");
  content.className = "text-preview-content wrap-lines";
  content.tabIndex = 0;
  content.setAttribute("aria-label", name + " 文本内容");
  const lines = data.content.split("\n");
  for (const line of lines) {
    const row = document.createElement("span");
    row.className = "text-preview-line";
    // Content is always plain text: HTML, scripts and Markdown are not executed.
    row.textContent = line || "\u200b";
    content.append(row);
  }
  wrap.addEventListener("click", () => {
    const active = content.classList.toggle("wrap-lines");
    wrap.setAttribute("aria-pressed", String(active));
  });
  const meta = document.createElement("div");
  meta.className = "preview-text-meta";
  meta.textContent = `${data.encoding} · ${lines.length} 行${data.truncated ? "（部分内容）" : ""}`;
  header.append(title, wrap);
  host.replaceChildren(header, content, meta);
  if (data.truncated) {
    const notice = document.createElement("div");
    notice.className = "preview-text-notice";
    notice.textContent = "仅预览前 256 KB / 3000 行。完整内容请通过右键菜单「打开位置」查看。";
    host.append(notice);
  }
}

export async function showMediaPreview(node) {
  const host = resetMediaPreview();
  document.getElementById("details-scroll").scrollTop = 0;
  const current = requestID;
  host.hidden = false;
  if (node.is_dir) {
    message(host, "文件夹", "选择其中的文本、图片或视频，即可预览内容。");
    return;
  }
  const ext = (node.name.match(/\.[^.]+$/) || [""])[0].toUpperCase();
  message(host, "正在载入预览…", "本地文件直接预览，不上传到网络。");
  try {
    const preview = await window.go.main.App.GetMediaPreview(node.path);
    if (current !== requestID) return;
    if (preview.kind === "text") {
      textRequest = new AbortController();
      const response = await fetch(preview.url, { signal: textRequest.signal, cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      const text = await response.json();
      if (current !== requestID) return;
      renderTextPreview(host, preview.name, text);
      return;
    }
    const media = document.createElement(preview.kind === "video" ? "video" : "img");
    media.className = "preview-media";
    const stage = document.createElement("div");
    stage.className = "preview-stage";
    const meta = document.createElement("div");
    meta.className = "preview-meta";
    const title = document.createElement("strong");
    title.textContent = preview.name;
    title.title = preview.name;
    const info = document.createElement("span");
    info.textContent = "正在读取…";
    const ready = () => {
      if (current !== requestID) return;
      info.textContent = preview.kind === "image"
        ? `${media.naturalWidth} × ${media.naturalHeight} · ${ext.slice(1)}`
        : `${media.videoWidth} × ${media.videoHeight} · ${Number.isFinite(media.duration) ? Math.round(media.duration) + " 秒" : ext.slice(1)}`;
    };
    if (preview.kind === "video") {
      media.controls = true;
      media.preload = "metadata";
      media.playsInline = true;
      media.addEventListener("loadedmetadata", ready, { once: true });
    } else {
      media.alt = preview.name;
      media.addEventListener("load", ready, { once: true });
    }
    media.addEventListener("error", () => {
      if (current !== requestID) return;
      message(host, "暂时无法预览", preview.kind === "video"
        ? "该视频的编码可能不受当前系统支持，可通过右键菜单「打开位置」使用本地播放器查看。"
        : "图片可能已移动、损坏，或当前系统不支持此格式。可通过右键菜单「打开位置」查看。");
    }, { once: true });
    stage.append(media);
    meta.append(title, info);
    host.replaceChildren(stage, meta);
    media.src = preview.url;
  } catch (err) {
    if (current === requestID) message(host, "无法读取预览", String(err));
  }
}
