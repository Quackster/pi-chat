// pi-chat media actions.
// A right-click (or a left-click) on the icon of an embedded media
// (svg, png, code) opens a small menu: open in tab, view source,
// download. Events are delegated on the message pane, so re-rendered
// media keep working.

// File extensions for code downloads, by language.
const kExtByLang = {
  js: "js", ts: "ts", py: "py", python: "py", json: "json",
  sh: "sh", bash: "sh", shell: "sh", css: "css", sql: "sql",
  c: "c", cpp: "cpp", "c++": "cpp", cs: "cs", java: "java",
  go: "go", golang: "go", rust: "rs", yaml: "yaml", yml: "yaml",
  html: "html", xml: "xml",
};

// The open context menu element, or null.
let mediaMenu = null;

// The content type of a media source.
function mediaType(entry) {
  if (entry.kind === "svg") return "image/svg+xml";
  if (entry.kind === "image") return "";
  return "text/plain";
}

// Decode an svg data uri to its markup, for view source.
function svgSourceFromDataUri(uri) {
  if (uri.startsWith("data:image/svg+xml;base64,")) {
    return atob(uri.slice("data:image/svg+xml;base64,".length));
  }
  if (uri.startsWith("data:image/svg+xml;utf8,")) {
    return decodeURIComponent(uri.slice("data:image/svg+xml;utf8,".length));
  }
  return uri;
}

// Open the media in a new tab. Remote and data-uri images open
// directly; svg and code open as blobs.
function openMediaTab(entry) {
  if (entry.kind === "image" && /^(https?:|data:)/.test(entry.source)) {
    window.open(entry.source, "_blank");
    return;
  }
  window.open(URL.createObjectURL(new Blob([entry.source], { type: mediaType(entry) })), "_blank");
}

// Show the raw source of the media in a new tab.
function viewMediaSource(entry) {
  if (entry.kind === "image" && /^https?:/.test(entry.source)) {
    window.open(entry.source, "_blank");
    return;
  }
  const source = entry.kind === "svg" ? svgSourceFromDataUri(entry.source) : entry.source;
  window.open(URL.createObjectURL(new Blob([source], { type: "text/plain" })), "_blank");
}

// A file name for the download, from the media hash.
function mediaFilename(entry) {
  const tag = entry.hash.slice(0, 6);
  if (entry.kind === "svg") return `media-${tag}.svg`;
  if (entry.kind === "image") return `media-${tag}.png`;
  return `snippet-${tag}.${kExtByLang[entry.lang] ?? "txt"}`;
}

// Download the media as a file. A cross-origin image that cannot be
// fetched falls back to opening it in a tab.
async function downloadMedia(entry) {
  try {
    let blob;
    if (entry.kind === "image" && /^(https?:|data:)/.test(entry.source)) {
      blob = await (await fetch(entry.source)).blob();
    } else {
      const source = entry.kind === "svg" ? svgSourceFromDataUri(entry.source) : entry.source;
      blob = new Blob([source], { type: mediaType(entry) });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = mediaFilename(entry);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    window.open(entry.source, "_blank");
  }
}

// Close the open context menu.
function closeMediaMenu() {
  if (!mediaMenu) return;
  mediaMenu.remove();
  mediaMenu = null;
}

// Show the context menu at the cursor for a media id.
function showMediaMenu(e, mediaId) {
  const entry = mediaRegistry.get(mediaId);
  if (!entry) return;
  closeMediaMenu();
  mediaMenu = document.createElement("div");
  mediaMenu.className = "media-menu";
  for (const [label, action] of [
    ["Open in tab", () => openMediaTab(entry)],
    ["View source", () => viewMediaSource(entry)],
    ["Download", () => downloadMedia(entry)],
  ]) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.onclick = () => {
      closeMediaMenu();
      action();
    };
    mediaMenu.append(item);
  }
  document.body.append(mediaMenu);
  const rect = mediaMenu.getBoundingClientRect();
  mediaMenu.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - rect.width - 8))}px`;
  mediaMenu.style.top = `${Math.max(8, Math.min(e.clientY, window.innerHeight - rect.height - 8))}px`;
  // Close on the next outside click or right-click.
  setTimeout(() => {
    document.addEventListener("click", closeMediaMenu, { once: true });
    document.addEventListener("contextmenu", closeMediaMenu, { once: true });
  }, 0);
}

// Wire up the delegated events for the media icons and images.
function initMedia() {
  const messages = document.getElementById("messages");
  messages.addEventListener("contextmenu", (e) => {
    const target = e.target.closest(".media-icon") ?? e.target.closest(".media-img");
    const media = target?.closest(".media");
    if (!media) return;
    e.preventDefault();
    showMediaMenu(e, media.dataset.mediaId);
  });
  // A left-click on the icon also opens the menu (for touch use).
  messages.addEventListener("click", (e) => {
    const icon = e.target.closest(".media-icon");
    if (!icon) return;
    e.preventDefault();
    showMediaMenu(e, icon.closest(".media").dataset.mediaId);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMediaMenu();
  });
}

initMedia();
