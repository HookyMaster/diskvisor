// One semantic palette for tree icons/bars, treemap blocks and the legend.
// Colours describe file types, never deletion safety or file size.
export const FILE_KINDS = Object.freeze([
  { id: "folder", label: "文件夹", color: "#b7791f" },
  { id: "image", label: "图片", color: "#8b5cf6", extensions: "png jpg jpeg gif webp bmp avif heic heif ico tif tiff svg raw cr2 nef arw" },
  { id: "video", label: "视频", color: "#2563eb", extensions: "mp4 m4v webm mov avi mkv wmv flv ogv mpg mpeg ts mts m2ts" },
  { id: "audio", label: "音频", color: "#db2777", extensions: "mp3 wav flac aac m4a ogg opus wma aiff mid midi" },
  { id: "document", label: "文档", color: "#0e7490", extensions: "txt md markdown log pdf doc docx rtf odt xls xlsx csv tsv ods ppt pptx odp epub mobi" },
  { id: "code", label: "代码 / 配置", color: "#0f766e", extensions: "go js jsx tsx py rs java c h cpp hpp cc cs sh bat ps1 sql vue svelte html htm css scss less json jsonl yaml yml xml toml ini cfg conf env ipynb rb php swift kt kts dart lua r pl cmake lock" },
  { id: "archive", label: "压缩包", color: "#c2410c", extensions: "zip rar 7z tar gz bz2 xz tgz zst cab iso" },
  { id: "program", label: "程序 / 库", color: "#b91c1c", extensions: "exe msi msix dll sys com scr appx so dylib bin" },
  { id: "other", label: "其他", color: "#64748b" },
].map(Object.freeze));

const byID = new Map(FILE_KINDS.map(kind => [kind.id, kind]));
const byExtension = new Map(FILE_KINDS.flatMap(kind =>
  (kind.extensions || "").split(" ").filter(Boolean).map(ext => [ext, kind])));
const names = new Map([
  ["readme", "document"], ["license", "document"], ["licence", "document"], ["changelog", "document"],
  ["dockerfile", "code"], ["makefile", "code"], [".gitignore", "code"], [".gitattributes", "code"],
  [".editorconfig", "code"], [".env", "code"], ["go.mod", "code"], ["go.sum", "code"],
]);

export function getFileKind(node) {
  if (node.is_dir) return byID.get(node.path === "" ? "other" : "folder");
  const name = (node.name || "").toLowerCase();
  if (names.has(name)) return byID.get(names.get(name));
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  // .ts normally denotes TypeScript source; MPEG transport streams remain
  // grouped with video when named .mts/.m2ts.
  if (ext === "ts") return byID.get("code");
  return byExtension.get(ext) || byID.get("other");
}

export function createFileIcon(node) {
  const kind = getFileKind(node);
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 20 20");
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add("file-kind-icon");
  icon.style.color = kind.color;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", node.is_dir
    ? "M2 4a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Z"
    : "M5 2h6l5 5v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm6 1.8V8h4.2L11 3.8Z");
  icon.append(path);
  return icon;
}
