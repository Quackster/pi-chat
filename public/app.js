// pi-chat browser client.
// Loads sessions from the server API, renders the active branch, and
// streams live agent events over Server-Sent Events.

const kPanelStorageKey = "pi-chat-tool-panel";
const kDiffToolNames = new Set(["edit", "write"]);
const kFlashMs = 1500;

const state = {
  sessions: [],
  activeId: null,
  selectedIds: new Set(),
  lastClickedId: null,
  eventSource: null,
  streaming: false,
  streamBubble: null,
  streamTextEl: null,
  panelOpen: true,
  autoTitle: true,
  liveTools: new Map(), // toolCallId -> { head, output }
};

// Tracks which session the model list is already loaded for.
let modelsLoadedFor = null;

const elements = {
  search: document.getElementById("search"),
  sessionList: document.getElementById("session-list"),
  refreshBtn: document.getElementById("refresh-btn"),
  newSessionBtn: document.getElementById("new-session-btn"),
  deleteSelectedBtn: document.getElementById("delete-selected-btn"),
  emptyState: document.getElementById("empty-state"),
  emptySummary: document.getElementById("empty-summary"),
  emptyNewBtn: document.getElementById("empty-new-btn"),
  chat: document.getElementById("chat"),
  chatName: document.getElementById("chat-name"),
  chatCwd: document.getElementById("chat-cwd"),
  chatModel: document.getElementById("chat-model"),
  modelSelect: document.getElementById("model-select"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  stopBtn: document.getElementById("stop-btn"),
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  sendBtn: document.getElementById("send-btn"),
  abortBtn: document.getElementById("abort-btn"),
  toolPanel: document.getElementById("tool-panel"),
  toolPanelBody: document.getElementById("tool-panel-body"),
  toolPanelToggle: document.getElementById("tool-panel-toggle"),
  toolPanelClose: document.getElementById("tool-panel-close"),
};

// Fetch a JSON API endpoint. Throws with the server error message.
async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// Create a DOM element with an optional class and text content.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Extract plain text from a message content field (string or block array).
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

// Format an ISO timestamp as a short relative time.
function relativeTime(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Title shown in the session list.
function sessionTitle(session) {
  return session.title ?? session.name ?? session.preview ?? session.id.slice(0, 8);
}

// Load the session list from the server and render it.
async function loadSessions() {
  const data = await api("/api/sessions");
  state.sessions = data.sessions;
  renderSessionList();
  renderEmptyState();
}

// Render the default page summary: session count and most recent activity.
function renderEmptyState() {
  const count = state.sessions.length;
  const text = count === 0
    ? "No sessions yet. Start a new one."
    : `${count} session${count === 1 ? "" : "s"} · last active ${relativeTime(state.sessions[0].lastActivity)}`;
  elements.emptySummary.textContent = text;
}

// Render the session list, applying the search filter.
function renderSessionList() {
  const list = elements.sessionList;
  list.innerHTML = "";
  const filter = elements.search.value.toLowerCase();
  for (const session of state.sessions) {
    const haystack = `${session.cwd} ${sessionTitle(session)}`.toLowerCase();
    if (filter && !haystack.includes(filter)) continue;
    const item = el("li", "session-item" + (session.id === state.activeId ? " active" : ""));
    item.dataset.id = session.id;
    const info = el("div", "session-info");
    info.append(
      el("div", "session-title", sessionTitle(session)),
      el("div", "session-sub", `${session.cwd} · ${relativeTime(session.lastActivity)}`),
    );
    const del = el("button", "session-delete", "✕");
    del.type = "button";
    del.title = "Delete session";
    del.onclick = (e) => {
      e.stopPropagation();
      deleteSession(session);
    };
    item.append(info, del);
    item.onclick = (e) => handleItemClick(e, session.id);
    list.append(item);
  }
  applySelection(state.selectedIds);
}

// Session list items currently rendered, i.e. after the search filter.
function visibleItems() {
  return [...elements.sessionList.querySelectorAll(".session-item")];
}

// Handle a click on a session item: open, toggle, or range-select.
function handleItemClick(e, id) {
  if (e.ctrlKey || e.metaKey) {
    toggleSelect(id);
    return;
  }
  if (e.shiftKey) {
    selectRange(id);
    return;
  }
  state.lastClickedId = id;
  if (state.selectedIds.has(id)) {
    deselect(id);
    return;
  }
  selectOnly(id);
  openSession(id);
}

// Select only the given session.
function selectOnly(id) {
  applySelection(new Set([id]));
}

// Toggle one session in the selection.
function toggleSelect(id) {
  const next = new Set(state.selectedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  applySelection(next);
}

// Deselect one session. If it is the active session, close the chat pane.
function deselect(id) {
  const next = new Set(state.selectedIds);
  next.delete(id);
  applySelection(next);
  if (id === state.activeId) resetView();
}

// Select the range from the last clicked item to the given item.
function selectRange(id) {
  const ids = visibleItems().map((item) => item.dataset.id);
  const from = Math.min(ids.indexOf(state.lastClickedId), ids.indexOf(id));
  const to = Math.max(ids.indexOf(state.lastClickedId), ids.indexOf(id));
  if (from === -1 || to === -1) {
    selectOnly(id);
    return;
  }
  const next = new Set(state.selectedIds);
  for (let i = from; i <= to; i += 1) next.add(ids[i]);
  applySelection(next);
}

// Select every session visible under the current filter.
function selectAllVisible() {
  applySelection(new Set(visibleItems().map((item) => item.dataset.id)));
}

// Clear the selection.
function clearSelection() {
  applySelection(new Set());
}

// Replace the selection and update the item classes and delete button.
function applySelection(ids) {
  state.selectedIds = ids;
  for (const item of visibleItems()) {
    item.classList.toggle("selected", ids.has(item.dataset.id));
  }
  updateDeleteButton();
}

// Show or hide the delete button and label it with the selection count.
function updateDeleteButton() {
  const count = state.selectedIds.size;
  elements.deleteSelectedBtn.hidden = count === 0;
  elements.deleteSelectedBtn.textContent = count > 0 ? `Delete (${count})` : "Delete";
}

// Delete a session file through the server and refresh the list.
async function deleteSession(session) {
  if (!window.confirm(`Delete session "${sessionTitle(session)}"? This removes the session file.`)) return;
  try {
    await api(`/api/sessions/${session.id}`, { method: "DELETE" });
  } catch (err) {
    console.error("delete failed:", err);
    return;
  }
  state.selectedIds.delete(session.id);
  if (session.id === state.activeId) resetView();
  await loadSessions();
}

// Delete every selected session through the bulk endpoint.
async function deleteSelected() {
  const ids = [...state.selectedIds];
  if (ids.length === 0) return;
  const names = ids
    .map((id) => state.sessions.find((s) => s.id === id))
    .filter(Boolean)
    .map((s) => sessionTitle(s));
  const shown = names.slice(0, 5).join(", ");
  const extra = names.length > 5 ? `, and ${names.length - 5} more` : "";
  const label = names.length > 0 ? ` (${shown}${extra})` : "";
  if (!window.confirm(`Delete ${ids.length} sessions${label}? This removes the session files.`)) return;
  try {
    await api("/api/sessions/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  } catch (err) {
    console.error("bulk delete failed:", err);
    return;
  }
  if (state.selectedIds.has(state.activeId)) resetView();
  clearSelection();
  await loadSessions();
}

// Rubber-band drag state for multi-selecting sessions.
const kDragStartPx = 5;
const kScrollEdgePx = 24;
const kScrollStepPx = 6;
let drag = null; // { startX, startY, y, base, moved }
let suppressClick = false;

// Start a potential drag on a session item press.
function startDrag(e) {
  if (e.button !== 0) return;
  suppressClick = false;
  const item = e.target.closest(".session-item");
  if (!item || e.target.closest(".session-delete")) return;
  drag = {
    startX: e.clientX,
    startY: e.clientY,
    y: e.clientY,
    base: e.ctrlKey || e.metaKey ? new Set(state.selectedIds) : new Set(),
    moved: false,
  };
}

// Extend the drag and select every item the vertical band touches.
function moveDrag(e) {
  if (!drag) return;
  const dx = Math.abs(e.clientX - drag.startX);
  const dy = Math.abs(e.clientY - drag.startY);
  if (!drag.moved && (dx > kDragStartPx || dy > kDragStartPx)) drag.moved = true;
  if (!drag.moved) return;
  drag.y = e.clientY;
  const top = Math.min(drag.startY, drag.y);
  const bottom = Math.max(drag.startY, drag.y);
  const next = new Set(drag.base);
  for (const item of visibleItems()) {
    const rect = item.getBoundingClientRect();
    if (rect.top < bottom && top < rect.bottom) next.add(item.dataset.id);
  }
  applySelection(next);
  autoScrollList(e.clientY);
}

// End the drag. A real drag suppresses the click that follows it.
function endDrag() {
  if (!drag) return;
  if (drag.moved) suppressClick = true;
  drag = null;
}

// Swallow the click that follows a drag, before the item handler runs.
function swallowDragClick(e) {
  if (!suppressClick) return;
  suppressClick = false;
  e.stopPropagation();
  e.preventDefault();
}

// Scroll the session list while the drag is near its top or bottom edge.
function autoScrollList(clientY) {
  const list = elements.sessionList;
  const rect = list.getBoundingClientRect();
  if (clientY < rect.top + kScrollEdgePx) list.scrollTop -= kScrollStepPx;
  else if (clientY > rect.bottom - kScrollEdgePx) list.scrollTop += kScrollStepPx;
}

// Ctrl+A selects all visible sessions, Esc clears the selection.
function handleKeydown(e) {
  const target = e.target;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !typing) {
    e.preventDefault();
    selectAllVisible();
    return;
  }
  if (e.key === "Escape") clearSelection();
}

// Start a new session in a chosen working directory.
async function newSession() {
  const active = state.sessions.find((s) => s.id === state.activeId);
  const cwd = window.prompt("Working directory for the new session:", active?.cwd ?? "~");
  if (!cwd) return;
  try {
    const created = await api("/api/new-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    await loadSessions();
    await openSession(created.id);
  } catch (err) {
    console.error("new session failed:", err);
  }
}

// Return the main pane to the empty state.
function resetView() {
  closeEventStream();
  state.activeId = null;
  resetStreamingState();
  elements.chat.hidden = true;
  elements.emptyState.hidden = false;
  elements.messages.innerHTML = "";
  clearToolPanel();
  syncToolPanelVisibility();
  renderSessionList();
}

// Load the saved tool panel visibility, defaulting to open.
function loadPanelOpen() {
  try {
    return localStorage.getItem(kPanelStorageKey) !== "closed";
  } catch {
    return true;
  }
}

// Show or hide the tool panel, update the toggle label, and persist the choice.
function setToolPanel(open) {
  state.panelOpen = open;
  elements.toolPanelToggle.textContent = open ? "Hide tools" : "Show tools";
  elements.toolPanelToggle.classList.toggle("on", open);
  syncToolPanelVisibility();
  try {
    localStorage.setItem(kPanelStorageKey, open ? "open" : "closed");
  } catch {
    // Storage unavailable; the choice just does not persist.
  }
}

// Sync the panel visibility: shown only when a session is open and the
// panel toggle is on.
function syncToolPanelVisibility() {
  elements.toolPanel.hidden = !state.panelOpen || elements.chat.hidden;
}

// Toggle the tool panel open or closed.
function toggleToolPanel() {
  setToolPanel(!state.panelOpen);
}

// Clear the tool panel.
function clearToolPanel() {
  elements.toolPanelBody.innerHTML = "";
}

// Scroll the tool panel to the bottom when it is visible.
function scrollPanelBottom() {
  if (!state.panelOpen) return;
  elements.toolPanelBody.scrollTop = elements.toolPanelBody.scrollHeight;
}

// Open a session: show the chat pane, render history, start the event stream,
// and fill the model dropdown with the session's current model selected.
async function openSession(id) {
  state.activeId = id;
  closeEventStream();
  resetStreamingState();
  const session = state.sessions.find((s) => s.id === id);
  elements.emptyState.hidden = true;
  elements.chat.hidden = false;
  syncToolPanelVisibility();
  elements.chatName.textContent = session ? sessionTitle(session) : id;
  elements.chatCwd.textContent = session ? session.cwd : "";
  elements.chatModel.textContent = session?.model ? `· ${session.model}` : "";
  renderSessionList();
  updateStatus({ running: false });
  loadModels();
  loadTitle(id);
  clearToolPanel();
  await refreshMessages();
  openEventStream(id);
}

// Ask the server for the session title, generating one if needed.
// The request may take a few seconds; the UI updates when it resolves.
async function loadTitle(id) {
  try {
    const data = await api(`/api/sessions/${id}/title`);
    if (!data.title) return;
    const session = state.sessions.find((s) => s.id === id);
    if (session) session.title = data.title;
    renderSessionList();
    if (id === state.activeId) elements.chatName.textContent = data.title;
  } catch (err) {
    console.error("title load failed:", err);
  }
}

// Load the server config and apply it to the UI.
async function loadConfig() {
  try {
    const data = await api("/api/config");
    state.autoTitle = Boolean(data.autoTitle);
  } catch (err) {
    console.error("config load failed:", err);
  }
}

// Load the available model list once per session, when the session opens.
// Resets the dropdown, fills it, then selects the session's current model.
async function loadModels() {
  const requestedId = state.activeId;
  if (modelsLoadedFor === requestedId) return;
  const session = state.sessions.find((s) => s.id === requestedId);
  const select = elements.modelSelect;
  select.innerHTML = "";
  select.append(el("option", "", "Choose model…"));
  try {
    const data = await api(`/api/sessions/${requestedId}/models`);
    if (requestedId !== state.activeId) return;
    for (const model of data.models) {
      const option = el("option", "", `${model.name} (${model.provider})`);
      option.value = `${model.provider}|${model.modelId}`;
      select.append(option);
    }
    modelsLoadedFor = requestedId;
    await selectCurrentModel(requestedId, data.models, session);
  } catch (err) {
    if (requestedId !== state.activeId) return;
    elements.messages.append(el("div", "error-line", `Model list failed: ${err.message}`));
  }
}

// Select the dropdown option matching the model the session is currently using.
// Prefers the live process state; falls back to the session file record.
async function selectCurrentModel(id, models, session) {
  let current = session?.model ?? null;
  try {
    const status = await api(`/api/sessions/${id}/status`);
    if (status.model?.provider && status.model?.id) {
      current = `${status.model.provider}/${status.model.id}`;
    }
  } catch {
    // Process not ready; keep the session file record.
  }
  if (id !== state.activeId) return;
  if (!current) return;
  const match = models.find((m) => `${m.provider}/${m.modelId}` === current);
  if (match) {
    elements.modelSelect.value = `${match.provider}|${match.modelId}`;
    elements.chatModel.textContent = `· ${current}`;
  }
}

// Apply the selected model to the active session.
async function changeModel() {
  const value = elements.modelSelect.value;
  if (!value) return;
  const [provider, modelId] = value.split("|");
  try {
    const data = await api(`/api/sessions/${state.activeId}/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, modelId }),
    });
    elements.chatModel.textContent = `· ${data.model?.name ?? modelId}`;
  } catch (err) {
    elements.messages.append(el("div", "error-line", `Model change failed: ${err.message}`));
  }
}

// Re-render the message history and the tool panel from disk (the source of truth).
async function refreshMessages() {
  const data = await api(`/api/sessions/${state.activeId}/messages`);
  const container = elements.messages;
  container.innerHTML = "";
  renderToolPanel(data.messages);
  for (const entry of data.messages) {
    const dom = entryToDom(entry);
    if (dom) container.append(dom);
  }
  scrollBottom();
}

// Render the tool panel from session entries: one entry per tool call
// block with its result, in conversation order.
function renderToolPanel(messages) {
  const results = collectResults(messages);
  const panel = elements.toolPanelBody;
  panel.innerHTML = "";
  for (const entry of messages) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content ?? []) {
      if (block.type !== "toolCall") continue;
      const result = results.get(block.id);
      panel.append(toolCallEntry(block.name, block.arguments, result?.text ?? null, result?.isError ?? false, block.id));
    }
  }
}

// Build a map of toolCallId -> { text, isError } from result messages.
function collectResults(messages) {
  const results = new Map();
  for (const entry of messages) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") {
      results.set(message.toolCallId, { text: extractText(message.content), isError: message.isError === true });
    } else if (message.role === "bashExecution") {
      results.set(message.toolCallId ?? message.id, { text: message.output ?? "", isError: false });
    }
  }
  return results;
}

// Map one session entry to a DOM node. Returns null for hidden entry types.
function entryToDom(entry) {
  switch (entry.type) {
    case "message":
      return messageToDom(entry.message);
    case "model_change":
      return el("div", "meta-line", `Model: ${entry.provider}/${entry.modelId}`);
    case "thinking_level_change":
      return el("div", "meta-line", `Thinking: ${entry.thinkingLevel}`);
    case "compaction":
      return el("div", "note-line", `Context compacted (${entry.tokensBefore} tokens summarized)`);
    case "branch_summary":
      return el("div", "note-line", `Branch summary: ${entry.summary}`);
    case "custom_message":
      if (entry.display === false) return null;
      return el("div", "note-line", String(entry.content));
    default:
      return null;
  }
}

// Map one stored message to a DOM node.
function messageToDom(message) {
  if (message.role === "user") {
    const div = el("div", "msg user");
    div.append(el("div", "msg-label", "You"), el("div", "msg-body", extractText(message.content)));
    return div;
  }
  if (message.role === "assistant") {
    const div = el("div", "msg assistant");
    div.append(el("div", "msg-label", `Pi${message.model ? ` · ${message.model}` : ""}`));
    for (const block of message.content ?? []) {
      if (block.type === "text") div.append(el("div", "msg-text", block.text));
      else if (block.type === "thinking") div.append(thinkingBlock(block.thinking));
      else if (block.type === "toolCall") {
        if (kDiffToolNames.has(block.name)) div.append(toolCallEntry(block.name, block.arguments, null, false, block.id));
        else div.append(toolCallChip(block.name, block.arguments, block.id));
      }
    }
    return div;
  }
  // Tool results and bash executions live in the tool panel, not the chat.
  return null;
}

// Thinking block, always expanded.
function thinkingBlock(text) {
  const div = el("div", "thinking");
  div.append(el("div", "thinking-label", "thinking"));
  div.append(el("pre", "", text));
  return div;
}

// Parse tool arguments into an object, or null when they do not parse.
function parseArgs(args) {
  if (args === undefined || args === null) return null;
  if (typeof args === "object") return args;
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return null;
    }
  }
  return null;
}

// Build the diff lines for an edit tool call: minus lines for each
// oldText and plus lines for each newText.
function diffLinesForEdit(args) {
  const path = typeof args.path === "string" ? args.path : "";
  const lines = [
    { kind: "file", text: `--- a/${path}` },
    { kind: "file", text: `+++ b/${path}` },
  ];
  const edits = Array.isArray(args.edits) ? args.edits : [];
  for (const edit of edits) {
    const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
    const newText = typeof edit.newText === "string" ? edit.newText : "";
    if (oldText) for (const line of oldText.split("\n")) lines.push({ kind: "del", text: line });
    if (newText) for (const line of newText.split("\n")) lines.push({ kind: "add", text: line });
  }
  return lines;
}

// Build the diff lines for a write tool call: the whole file is added.
function diffLinesForWrite(args) {
  const path = typeof args.path === "string" ? args.path : "";
  const lines = [
    { kind: "file", text: "--- /dev/null" },
    { kind: "file", text: `+++ b/${path}` },
  ];
  const content = typeof args.content === "string" ? args.content : "";
  for (const line of content.split("\n")) lines.push({ kind: "add", text: line });
  return lines;
}

// Render diff lines into a pre with one colored span per line.
function diffPre(lines) {
  const pre = el("pre", "diff");
  for (const line of lines) pre.append(el("span", `diff-line ${line.kind}`, line.text));
  return pre;
}

// Build the always-expanded diff body for a file edit tool call.
// Returns null when the arguments do not parse to an object.
function fileEditDiff(name, args) {
  const parsed = parseArgs(args);
  if (!parsed) return null;
  return diffPre(name === "write" ? diffLinesForWrite(parsed) : diffLinesForEdit(parsed));
}

// Build a short one-line summary of a tool call's arguments.
function toolSummary(args) {
  const parsed = parseArgs(args);
  if (parsed) {
    for (const key of ["command", "path", "query", "url", "pattern"]) {
      if (typeof parsed[key] === "string" && parsed[key]) return parsed[key].split("\n")[0];
    }
  }
  const text = args === undefined ? "" : typeof args === "string" ? args : JSON.stringify(args, null, 2);
  return text.split("\n")[0];
}

// Build one tool call entry for the tool panel: head, arguments (a diff
// for file edits, JSON otherwise), and the result when present.
function toolCallEntry(name, args, result, isError, callId) {
  const div = el("div", "tool-entry");
  if (callId) div.dataset.callId = callId;
  div.append(el("div", "tool-head", `${name} ${toolSummary(args)}`));
  const diff = kDiffToolNames.has(name) ? fileEditDiff(name, args) : null;
  if (diff) {
    div.append(diff);
  } else {
    const argText = args === undefined ? "" : typeof args === "string" ? args : JSON.stringify(args, null, 2);
    div.append(el("pre", "tool-args", argText));
  }
  const resultPre = el("pre", "tool-result");
  if (result) {
    resultPre.textContent = result;
    if (isError) resultPre.classList.add("error");
  } else {
    resultPre.hidden = true;
  }
  div.append(resultPre);
  return div;
}

// Build a subtle clickable chip for a tool call in the main chat.
// Clicking it opens the tool panel and jumps to the matching entry.
function toolCallChip(name, args, callId) {
  const chip = el("div", "tool-chip");
  if (callId) chip.dataset.callId = callId;
  chip.append(el("span", "chip-name", name), el("span", "chip-arg", toolSummary(args)));
  chip.onclick = () => openToolPanelFor(chip.dataset.callId);
  return chip;
}

// Open the tool panel and scroll to the entry for the given tool call.
function openToolPanelFor(callId) {
  setToolPanel(true);
  const target = elements.toolPanelBody.querySelector(`[data-call-id="${callId}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), kFlashMs);
}

// Start a new assistant bubble for live streaming.
function startStreamBubble() {
  finishStreamBubble();
  const div = el("div", "msg assistant streaming");
  div.append(el("div", "msg-label", "Pi · streaming"));
  const text = el("div", "msg-text", "");
  div.append(text);
  elements.messages.append(div);
  state.streamBubble = div;
  state.streamTextEl = text;
  scrollBottom();
}

// Append a text delta to the streaming bubble.
function appendStreamText(delta) {
  if (!state.streamTextEl) startStreamBubble();
  state.streamTextEl.textContent += delta;
  scrollBottom();
}

// Remove the streaming marker when the run settles.
function finishStreamBubble() {
  if (state.streamBubble) {
    state.streamBubble.classList.remove("streaming");
    const label = state.streamBubble.querySelector(".msg-label");
    if (label) label.textContent = "Pi";
  }
  resetStreamingState();
}

// Reset the per-session streaming UI state: bubble, live tools, abort button.
// Called on session switch, view reset, and run settlement.
function resetStreamingState() {
  state.streaming = false;
  state.streamBubble = null;
  state.streamTextEl = null;
  state.liveTools.clear();
  elements.abortBtn.hidden = true;
}

// Add a live tool entry to the tool panel and a chip to the chat
// for a tool_execution_start event.
function addLiveToolBlock(event) {
  const node = toolCallEntry(event.toolName, event.args, null, false, event.toolCallId);
  elements.toolPanelBody.append(node);
  state.liveTools.set(event.toolCallId, {
    head: node.querySelector(".tool-head"),
    output: node.querySelector(".tool-result"),
  });
  if (state.streamBubble) state.streamBubble.append(toolCallChip(event.toolName, event.args, event.toolCallId));
  scrollPanelBottom();
}

// Update the live tool entry with accumulated output.
function updateLiveToolBlock(event) {
  const block = state.liveTools.get(event.toolCallId);
  if (!block) return;
  const content = event.partialResult?.content;
  const text = Array.isArray(content) ? extractText(content) : "";
  if (text) {
    block.output.textContent = text;
    block.output.hidden = false;
  }
}

// Mark the live tool entry as finished.
function finalizeLiveToolBlock(event) {
  const block = state.liveTools.get(event.toolCallId);
  if (!block) return;
  const result = event.result?.content;
  const text = Array.isArray(result) ? extractText(result) : "";
  if (text) {
    block.output.textContent = text;
    block.output.hidden = false;
  }
  if (event.isError && block.head) block.head.textContent += " (error)";
}

// Open the SSE stream for the active session.
function openEventStream(id) {
  const es = new EventSource(`/api/sessions/${id}/events`);
  state.eventSource = es;
  es.addEventListener("hello", (e) => {
    const status = JSON.parse(e.data);
    updateStatus(status);
    if (status.isStreaming) {
      state.streaming = true;
      elements.abortBtn.hidden = false;
      startStreamBubble();
    }
  });
  es.addEventListener("ping", () => {});
  es.addEventListener("event", (e) => handleAgentEvent(JSON.parse(e.data)));
  es.onerror = () => updateStatus({ running: false });
}

function closeEventStream() {
  state.eventSource?.close();
  state.eventSource = null;
}

// Route one live agent event to the UI.
function handleAgentEvent(event) {
  switch (event.type) {
    case "message_start":
      if (event.message?.role === "assistant") startStreamBubble();
      break;
    case "message_update": {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta") appendStreamText(delta.delta);
      break;
    }
    case "tool_execution_start":
      addLiveToolBlock(event);
      break;
    case "tool_execution_update":
      updateLiveToolBlock(event);
      break;
    case "tool_execution_end":
      finalizeLiveToolBlock(event);
      break;
    case "agent_settled":
      state.streaming = false;
      elements.abortBtn.hidden = true;
      finishStreamBubble();
      refreshMessages();
      if (state.autoTitle) loadTitle(state.activeId);
      break;
    case "process_exited":
      updateStatus({ running: false });
      break;
  }
}

// Update the process status dot and label.
function updateStatus(status) {
  elements.statusDot.className = `dot${status.running ? " on" : ""}`;
  if (status.running && status.isStreaming) {
    elements.statusText.textContent = `Pi is working (pid ${status.pid})`;
  } else if (status.running) {
    elements.statusText.textContent = `Pi process running (pid ${status.pid})`;
  } else {
    elements.statusText.textContent = "Pi process stopped. It starts on the next message.";
  }
}

// Send the current input as a prompt.
async function sendMessage() {
  const text = elements.input.value.trim();
  if (!text || state.streaming) return;
  elements.input.value = "";
  const bubble = el("div", "msg user");
  bubble.append(el("div", "msg-label", "You"), el("div", "msg-body", text));
  elements.messages.append(bubble);
  scrollBottom();
  state.streaming = true;
  elements.abortBtn.hidden = false;
  try {
    await api(`/api/sessions/${state.activeId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
  } catch (err) {
    state.streaming = false;
    elements.abortBtn.hidden = true;
    elements.messages.append(el("div", "error-line", `Send failed: ${err.message}`));
    scrollBottom();
  }
}

// Abort the in-flight agent run.
async function abortRun() {
  try {
    await api(`/api/sessions/${state.activeId}/abort`, { method: "POST" });
  } catch (err) {
    elements.messages.append(el("div", "error-line", `Abort failed: ${err.message}`));
  }
}

// Stop the pi process for the active session.
async function stopProcess() {
  try {
    await api(`/api/sessions/${state.activeId}/stop`, { method: "POST" });
    updateStatus({ running: false });
  } catch (err) {
    elements.messages.append(el("div", "error-line", `Stop failed: ${err.message}`));
  }
}

// Scroll the message pane to the bottom.
function scrollBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

// Wire up static controls.
function init() {
  elements.search.oninput = renderSessionList;
  elements.refreshBtn.onclick = () => loadSessions().catch((err) => console.error(err));
  elements.newSessionBtn.onclick = newSession;
  elements.emptyNewBtn.onclick = newSession;
  elements.deleteSelectedBtn.onclick = deleteSelected;
  elements.sendBtn.onclick = sendMessage;
  elements.abortBtn.onclick = abortRun;
  elements.stopBtn.onclick = stopProcess;
  elements.modelSelect.addEventListener("focus", loadModels);
  elements.modelSelect.addEventListener("change", changeModel);
  elements.toolPanelToggle.onclick = toggleToolPanel;
  elements.toolPanelClose.onclick = toggleToolPanel;
  state.panelOpen = loadPanelOpen();
  setToolPanel(state.panelOpen);
  elements.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  elements.sessionList.addEventListener("mousedown", startDrag);
  elements.sessionList.addEventListener("click", swallowDragClick, true);
  document.addEventListener("mousemove", moveDrag);
  document.addEventListener("mouseup", endDrag);
  document.addEventListener("keydown", handleKeydown);
  boot();
}

// Load the session list and config on startup; the default page shows
// until a session is opened.
async function boot() {
  try {
    await loadSessions();
  } catch (err) {
    console.error("failed to load sessions:", err);
  }
  loadConfig();
}

init();
