// pi-chat browser client.
// Loads sessions from the server API, renders the active branch, and
// streams live agent events over Server-Sent Events.

const kPanelStorageKey = "pi-chat-tool-panel";
const kDiffToolNames = new Set(["edit", "write"]);
const kFlashMs = 1500;
const kToastMs = 6000;
const kTypeaheadDelayMs = 150;
const kProcessingPlaceholder = "Processing prompt...";
const kThinkingPreviewLines = 6;
// Distance from the bottom edge within which a scrollable pane is
// considered "following" new content.
const kFollowEdgePx = 48;

const state = {
  sessions: [],
  activeId: null,
  selectedIds: new Set(),
  lastClickedId: null,
  eventSource: null,
  streaming: false,
  streamBubble: null,
  streamTextEl: null,
  streamTextRaw: "",
  streamRenderPending: false,
  streamThinkingBox: null,
  streamThinkingEl: null,
  streamThinkingRaw: "",
  streamPlaceholderEl: null,
  streamHasContent: false,
  followMessages: true, // message pane follows new content
  followToolPanel: true, // tool panel follows new content
  panelOpen: true,
  autoTitle: true,
  streamingBehavior: "followUp",
  models: [], // available models for the active session, with thinkingLevels
  liveTools: new Map(), // toolCallId -> { head, output }
  commands: [], // { name, description, source }
  extStatus: new Map(), // statusKey -> statusText
  extWidgets: new Map(), // widgetKey -> string[]
  pendingDialog: null, // { sessionId, request }
  menuIndex: -1,
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
  thinkingLevelSelect: document.getElementById("thinking-level-select"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  stopBtn: document.getElementById("stop-btn"),
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  sendBtn: document.getElementById("send-btn"),
  stopRunBtn: document.getElementById("stop-run-btn"),
  toolPanel: document.getElementById("tool-panel"),
  toolPanelBody: document.getElementById("tool-panel-body"),
  toolPanelToggle: document.getElementById("tool-panel-toggle"),
  toolPanelClose: document.getElementById("tool-panel-close"),
  extStatusBox: document.getElementById("ext-status-box"),
  extWidget: document.getElementById("ext-widget"),
  commandMenu: document.getElementById("command-menu"),
  toasts: document.getElementById("toasts"),
  dialogBackdrop: document.getElementById("ext-dialog-backdrop"),
  dialogTitle: document.getElementById("ext-dialog-title"),
  dialogBody: document.getElementById("ext-dialog-body"),
  dialogActions: document.getElementById("ext-dialog-actions"),
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
  const ok = await confirmDialog(
    "Delete session",
    `Delete session "${sessionTitle(session)}"? This removes the session file.`,
    "Delete",
  );
  if (!ok) return;
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
  const ok = await confirmDialog(
    "Delete sessions",
    `Delete ${ids.length} sessions${label}? This removes the session files.`,
    "Delete",
  );
  if (!ok) return;
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
  if (e.key === "Escape") {
    if (state.pendingDialog) {
      cancelDialog();
      return;
    }
    if (localDialog) {
      dismissLocalDialog();
      return;
    }
    clearSelection();
  }
}

// Start a new session in a chosen working directory.
async function newSession() {
  const cwd = await directoryDialog();
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
    showToast(`New session failed: ${err.message}`, "error");
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
  resetExtensionUi();
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
  state.followToolPanel = true;
  resetExtensionUi();
  loadCommands();
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
    state.streamingBehavior = data.streamingBehavior === "steer" ? "steer" : "followUp";
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
    state.models = data.models;
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
// Also fills the thinking level dropdown for that model.
async function selectCurrentModel(id, models, session) {
  let current = session?.model ?? null;
  let thinkingLevel = null;
  try {
    const status = await api(`/api/sessions/${id}/status`);
    if (status.model?.provider && status.model?.id) {
      current = `${status.model.provider}/${status.model.id}`;
    }
    thinkingLevel = status.thinkingLevel ?? null;
  } catch {
    // Process not ready; keep the session file record.
  }
  if (id !== state.activeId) return;
  if (!current) {
    updateThinkingLevels(null, thinkingLevel);
    return;
  }
  const match = models.find((m) => `${m.provider}/${m.modelId}` === current);
  if (match) {
    elements.modelSelect.value = `${match.provider}|${match.modelId}`;
    elements.chatModel.textContent = `· ${current}`;
  }
  updateThinkingLevels(match ?? null, thinkingLevel);
}

// Display label for a thinking level. "off" is the non-thinking option.
function thinkingLevelLabel(level) {
  return level === "off" ? "off (no thinking)" : level;
}

// Fill the thinking level dropdown for one model and select the active
// level when it is listed. With no model, the dropdown stays empty
// and disabled so a level can only be chosen per model.
function updateThinkingLevels(model, activeLevel) {
  const select = elements.thinkingLevelSelect;
  select.innerHTML = "";
  if (!model) {
    select.append(el("option", "", "Choose level…"));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const level of model.thinkingLevels) {
    const option = el("option", "", thinkingLevelLabel(level));
    option.value = level;
    select.append(option);
  }
  if (activeLevel && model.thinkingLevels.includes(activeLevel)) {
    select.value = activeLevel;
  }
}

// Select the given level in the thinking dropdown when it is listed.
// Used to follow live state (hello event, status refreshes).
function syncThinkingLevelSelect(level) {
  const select = elements.thinkingLevelSelect;
  for (const option of select.options) {
    if (option.value === level) {
      select.value = level;
      return;
    }
  }
}

// Fetch the session's current thinking level from the live process state.
async function currentThinkingLevel() {
  try {
    const status = await api(`/api/sessions/${state.activeId}/status`);
    return status.thinkingLevel ?? null;
  } catch {
    return null;
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
    const model = state.models.find((m) => m.provider === provider && m.modelId === modelId) ?? null;
    // pi clamps the thinking level to the new model's capabilities,
    // so re-read the level after the switch.
    updateThinkingLevels(model, await currentThinkingLevel());
  } catch (err) {
    elements.messages.append(el("div", "error-line", `Model change failed: ${err.message}`));
  }
}

// Apply the selected thinking level to the active session.
async function changeThinkingLevel() {
  const level = elements.thinkingLevelSelect.value;
  if (!level) return;
  try {
    await api(`/api/sessions/${state.activeId}/thinking-level`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
    });
  } catch (err) {
    elements.messages.append(el("div", "error-line", `Thinking level change failed: ${err.message}`));
  }
}

// Clear the per-session extension UI state (status, widgets, commands).
function resetExtensionUi() {
  state.extStatus.clear();
  state.extWidgets.clear();
  state.commands = [];
  state.pendingDialog = null;
  elements.dialogBackdrop.hidden = true;
  renderExtStatus();
  renderExtWidget();
  hideCommandMenu();
}

// Load the slash commands available to the session (extension commands,
// prompt templates, skills). The process is spawned on demand by the server.
async function loadCommands() {
  const requestedId = state.activeId;
  try {
    const data = await api(`/api/sessions/${requestedId}/commands`);
    if (requestedId !== state.activeId) return;
    state.commands = data.commands ?? [];
    renderCommandMenu();
  } catch (err) {
    console.error("command list failed:", err);
  }
}

// The command token being typed, or null when the input is not a command.
// A command is a leading "/" with no space typed yet.
function commandToken(text) {
  if (!text.startsWith("/") || /\s/.test(text)) return null;
  return text.slice(1);
}

// Commands matching the typed token by name prefix.
function filterCommands(token) {
  const query = token.toLowerCase();
  return state.commands.filter((command) => command.name.toLowerCase().startsWith(query));
}

// Show or hide the command menu above the input, with the active row.
function renderCommandMenu() {
  const token = commandToken(elements.input.value);
  const menu = elements.commandMenu;
  if (token === null) {
    hideCommandMenu();
    return;
  }
  const matches = filterCommands(token);
  if (matches.length === 0) {
    menu.hidden = true;
    state.menuIndex = -1;
    return;
  }
  menu.innerHTML = "";
  matches.forEach((command, index) => {
    const item = el("div", "cmd-item" + (index === state.menuIndex ? " active" : ""));
    item.append(
      el("span", "cmd-name", `/${command.name}`),
      el("span", "cmd-desc", command.description ?? ""),
    );
    item.onmousedown = (e) => {
      e.preventDefault();
      selectCommand(command);
    };
    menu.append(item);
  });
  menu.hidden = false;
}

// Hide the command menu and reset the highlighted row.
function hideCommandMenu() {
  elements.commandMenu.hidden = true;
  state.menuIndex = -1;
}

// Fill the input with the chosen command and a trailing space.
function selectCommand(command) {
  elements.input.value = `/${command.name} `;
  hideCommandMenu();
  elements.input.focus();
}

// Render the extension status box (e.g. the live goal status line).
// One line per status key. Generic: any extension's status shows up.
function renderExtStatus() {
  const box = elements.extStatusBox;
  box.innerHTML = "";
  for (const [key, text] of state.extStatus) {
    const label = text.startsWith(`${key}: `) ? text : `${key}: ${text}`;
    box.append(el("div", "ext-status-line", label));
  }
  box.hidden = state.extStatus.size === 0;
}

// Render the extension widget lines above the input bar.
function renderExtWidget() {
  const widget = elements.extWidget;
  widget.innerHTML = "";
  let any = false;
  for (const lines of state.extWidgets.values()) {
    for (const line of lines) {
      widget.append(el("div", "ext-widget-line", line));
      any = true;
    }
  }
  widget.hidden = !any;
}

// Show a toast notification. It auto-dismisses after a few seconds.
function showToast(message, type) {
  const toast = el("div", `toast ${type ?? "info"}`, String(message));
  toast.onclick = () => toast.remove();
  elements.toasts.append(toast);
  setTimeout(() => toast.remove(), kToastMs);
}

// Handle one extension UI request (status, widget, notify, dialogs).
// This is generic: any extension's UI state shows up, not just goals.
function handleExtensionUi(event) {
  if (event.method === "notify") {
    showToast(event.message, event.notifyType ?? "info");
    return;
  }
  if (event.method === "setStatus") {
    if (event.statusText === undefined || event.statusText === null) state.extStatus.delete(event.statusKey);
    else state.extStatus.set(event.statusKey, event.statusText);
    renderExtStatus();
    return;
  }
  if (event.method === "setWidget") {
    if (event.widgetLines === undefined || event.widgetLines === null) state.extWidgets.delete(event.widgetKey);
    else state.extWidgets.set(event.widgetKey, event.widgetLines);
    renderExtWidget();
    return;
  }
  if (event.method === "setTitle") {
    if (event.title) document.title = event.title;
    return;
  }
  if (["select", "confirm", "input", "editor"].includes(event.method)) {
    openDialog(event);
  }
}

// Open a dialog for an extension UI request. Replaces any open dialog.
function openDialog(request) {
  dismissLocalDialog();
  state.pendingDialog = { sessionId: state.activeId, request };
  elements.dialogTitle.textContent = request.title ?? "";
  const body = elements.dialogBody;
  const actions = elements.dialogActions;
  body.innerHTML = "";
  actions.innerHTML = "";
  if (request.method === "select") {
    for (const option of request.options ?? []) {
      const button = el("button", "dialog-option", option);
      button.type = "button";
      button.onclick = () => respondDialog({ value: option });
      body.append(button);
    }
  } else if (request.method === "confirm") {
    if (request.message) body.append(el("div", "dialog-message", request.message));
    const yes = el("button", "", "Yes");
    yes.type = "button";
    yes.onclick = () => respondDialog({ confirmed: true });
    const no = el("button", "", "No");
    no.type = "button";
    no.onclick = () => respondDialog({ confirmed: false });
    actions.append(yes, no);
  } else if (request.method === "input" || request.method === "editor") {
    const field = document.createElement(request.method === "input" ? "input" : "textarea");
    field.className = "dialog-field";
    if (request.method === "input") {
      field.type = "text";
      field.placeholder = request.placeholder ?? "";
    } else {
      field.rows = 8;
    }
    field.value = request.prefill ?? "";
    body.append(field);
    const ok = el("button", "", request.method === "input" ? "OK" : "Save");
    ok.type = "button";
    ok.onclick = () => respondDialog({ value: field.value });
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => respondDialog({ cancelled: true });
    actions.append(ok, cancel);
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && request.method === "input") {
        e.preventDefault();
        respondDialog({ value: field.value });
      }
    });
  }
  elements.dialogBackdrop.hidden = false;
}

// Close the dialog and send the response to the session that asked.
async function respondDialog(payload) {
  const pending = state.pendingDialog;
  state.pendingDialog = null;
  elements.dialogBackdrop.hidden = true;
  if (!pending) return;
  try {
    await api(`/api/sessions/${pending.sessionId}/ui-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pending.request.id, ...payload }),
    });
  } catch (err) {
    showToast(`Dialog response failed: ${err.message}`, "error");
  }
}

// Dismiss the open dialog without answering.
function cancelDialog() {
  respondDialog({ cancelled: true });
}

// The open in-page dialog (confirm or prompt). settle resolves the
// promise; dismissValue is what a dismiss (Escape, backdrop click, or
// an extension dialog taking over the box) resolves with.
let localDialog = null;

// Settle the open in-page dialog with a value. A second settle is a no-op.
// An optional onDismiss hook runs before the settle, for dialog cleanup.
function settleLocalDialog(value) {
  if (!localDialog) return;
  const settle = localDialog.settle;
  const onDismiss = localDialog.onDismiss;
  localDialog = null;
  elements.dialogBackdrop.hidden = true;
  if (onDismiss) onDismiss();
  settle(value);
}

// Dismiss the open in-page dialog with its dismiss value.
function dismissLocalDialog() {
  if (!localDialog) return;
  settleLocalDialog(localDialog.dismissValue);
}

// Show an in-page confirmation in the dialog box. Resolves true only
// when the user clicks the confirm button. Any dismiss resolves false.
function confirmDialog(title, message, confirmLabel) {
  return new Promise((resolve) => {
    if (state.pendingDialog) cancelDialog();
    localDialog = { settle: resolve, dismissValue: false };
    elements.dialogTitle.textContent = title;
    const body = elements.dialogBody;
    const actions = elements.dialogActions;
    body.innerHTML = "";
    actions.innerHTML = "";
    if (message) body.append(el("div", "dialog-message", message));
    const yes = el("button", "", confirmLabel ?? "OK");
    yes.type = "button";
    yes.onclick = () => settleLocalDialog(true);
    const no = el("button", "", "Cancel");
    no.type = "button";
    no.onclick = () => settleLocalDialog(false);
    actions.append(yes, no);
    elements.dialogBackdrop.hidden = false;
  });
}

// Open the new-session directory picker. Starts in the active
// session's working directory, or the service user's home when no
// session is open. Typing a path live-updates the list with the
// matching subdirectories. Resolves the chosen path, or null when
// dismissed or cancelled.
function directoryDialog() {
  return new Promise((resolve) => {
    if (state.pendingDialog) cancelDialog();
    localDialog = {
      settle: resolve,
      dismissValue: null,
      onDismiss: () => clearTimeout(typeaheadTimer),
    };
    elements.dialogTitle.textContent = "New session";
    const body = elements.dialogBody;
    const actions = elements.dialogActions;
    body.innerHTML = "";
    actions.innerHTML = "";
    body.append(el("div", "dialog-message", "Working directory for the new session:"));
    const field = document.createElement("input");
    field.className = "dialog-field";
    field.type = "text";
    field.placeholder = "path";
    body.append(field);
    const toolbar = el("div", "dir-toolbar");
    body.append(toolbar);
    const list = el("div", "dir-list");
    body.append(list);
    const select = el("button", "", "Select");
    select.type = "button";
    select.onclick = () => settleLocalDialog(field.value);
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => settleLocalDialog(null);
    actions.append(select, cancel);
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        settleLocalDialog(field.value);
      }
    });
    let browseToken = 0;
    let typeaheadTimer = null;
    // Load one directory into the field and the list. A stale
    // response (superseded by a newer click or keystroke) is dropped.
    // Returns true when the directory loaded.
    async function browse(dir) {
      const token = ++browseToken;
      try {
        const data = await api(dir ? `/api/browse?path=${encodeURIComponent(dir)}` : "/api/browse");
        if (token !== browseToken) return false;
        field.value = data.path;
        renderToolbar(data.path, data.home);
        renderList(data.path, data.entries, "");
        return true;
      } catch (err) {
        if (token === browseToken) showToast(`Browse failed: ${err.message}`, "error");
        return false;
      }
    }
    // Render the directory list: the ".." entry plus the subdirectory
    // entries, narrowed to names starting with the typed suffix. When
    // the suffix matches nothing, all entries show.
    function renderList(dirPath, entries, suffix) {
      list.innerHTML = "";
      if (dirPath !== "/") {
        list.append(dirItem("..", dirPath.split("/").slice(0, -1).join("/") || "/"));
      }
      let shown = entries;
      if (suffix) {
        const matches = entries.filter((entry) => entry.name.toLowerCase().startsWith(suffix.toLowerCase()));
        if (matches.length > 0) shown = matches;
      }
      for (const entry of shown) list.append(dirItem(entry.name, entry.path));
    }
    // The parent of an absolute directory path and its last segment.
    // Returns null at the root and for relative paths.
    function popSegment(dir) {
      if (!dir.startsWith("/")) return null;
      const parts = dir.split("/").filter(Boolean);
      if (parts.length === 0) return null;
      const segment = parts.pop();
      const parent = parts.length === 0 ? "/" : `/${parts.join("/")}`;
      return { parent, segment };
    }
    // Live update while typing: walk the typed path up to the longest
    // existing directory and list its subdirectories matching the
    // remaining typed text. Never overwrites the typed value.
    async function browseTypeahead() {
      const token = ++browseToken;
      const value = field.value.trim();
      if (!value) return;
      let dir = value;
      let suffix = "";
      let data = null;
      for (;;) {
        try {
          data = await api(`/api/browse?path=${encodeURIComponent(dir)}`);
          break;
        } catch {
          const step = popSegment(dir);
          if (!step) return;
          suffix = step.segment + (suffix ? `/${suffix}` : "");
          dir = step.parent;
        }
      }
      if (token !== browseToken) return;
      renderToolbar(data.path, data.home);
      renderList(data.path, data.entries, suffix);
    }
    field.addEventListener("input", () => {
      clearTimeout(typeaheadTimer);
      typeaheadTimer = setTimeout(browseTypeahead, kTypeaheadDelayMs);
    });
    const dirItem = (name, target) => {
      const item = el("button", "dir-item", name);
      item.type = "button";
      item.onclick = () => browse(target);
      return item;
    };
    const toolButton = (label, onclick) => {
      const button = el("button", "dir-tool", label);
      button.type = "button";
      button.onclick = onclick;
      return button;
    };
    // Toolbar buttons for the current directory.
    function renderToolbar(current, home) {
      toolbar.innerHTML = "";
      toolbar.append(toolButton("Go", () => browse(field.value)));
      if (current !== "/") {
        toolbar.append(toolButton("↑", () => browse(current.split("/").slice(0, -1).join("/") || "/")));
      }
      toolbar.append(toolButton("Home", () => browse(home)));
      toolbar.append(toolButton("New folder", startNewFolder));
      toolbar.append(toolButton("Refresh", () => browse(field.value)));
    }
    // Replace the toolbar with a name input to create a subdirectory.
    function startNewFolder() {
      const name = document.createElement("input");
      name.className = "dialog-field";
      name.type = "text";
      name.placeholder = "new folder name";
      const ok = el("button", "", "OK");
      ok.type = "button";
      const back = el("button", "", "Cancel");
      back.type = "button";
      back.onclick = () => browse(field.value);
      ok.onclick = async () => {
        const folder = name.value.trim();
        if (!folder) return;
        const target = field.value === "/" ? `/${folder}` : `${field.value}/${folder}`;
        try {
          await api("/api/mkdir", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: target }),
          });
          browse(target);
        } catch (err) {
          showToast(`New folder failed: ${err.message}`, "error");
        }
      };
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          ok.onclick();
        }
      });
      toolbar.innerHTML = "";
      toolbar.append(name, ok, back);
      name.focus();
    }
    elements.dialogBackdrop.hidden = false;
    field.focus();
    // Start in the active session's working directory, or in the
    // service user's home when no session is open or it is gone.
    const active = state.sessions.find((s) => s.id === state.activeId);
    const startDir = active ? active.cwd : null;
    field.value = startDir ?? "";
    browse(startDir).then((ok) => {
      if (!ok && startDir) browse(null);
    });
  });
}

// Re-render the message history and the tool panel from disk (the
// source of truth). With scroll true the pane jumps to the bottom
// (session switch). With scroll false it jumps only when the user
// is already following.
async function refreshMessages(scroll) {
  const data = await api(`/api/sessions/${state.activeId}/messages`);
  const container = elements.messages;
  container.innerHTML = "";
  renderToolPanel(data.messages);
  for (const entry of data.messages) {
    const dom = entryToDom(entry);
    if (dom) container.append(dom);
  }
  if (scroll) state.followMessages = true;
  if (state.followMessages) scrollBottom();
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
      if (block.type === "text") {
    const text = el("div", "msg-text");
    text.innerHTML = renderMarkdown(block.text);
    div.append(text);
  }
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

// Thinking block, collapsed to the last few lines by default.
// Click the label to expand or collapse it.
function thinkingBlock(text) {
  const div = el("div", "thinking collapsed");
  const label = thinkingLabel(false);
  div.append(label, el("pre", "", thinkingTail(text)));
  label.addEventListener("click", () => toggleThinking(div, text));
  return div;
}

// Build the clickable thinking label with its toggle indicator.
function thinkingLabel(expanded) {
  const label = el("div", "thinking-label");
  label.append(el("span", "thinking-toggle", expanded ? "\u25be" : "\u25b8"), el("span", "", "thinking"));
  return label;
}

// Last kThinkingPreviewLines lines of the text, prefixed with an
// ellipsis when the text was truncated.
function thinkingTail(text) {
  const lines = text.split("\n");
  if (lines.length <= kThinkingPreviewLines) return text;
  return "\u2026\n" + lines.slice(-kThinkingPreviewLines).join("\n");
}

// Toggle a thinking block between collapsed (last few lines) and
// expanded (full text).
function toggleThinking(div, fullText) {
  const pre = div.querySelector("pre");
  const collapsed = div.classList.toggle("collapsed");
  pre.textContent = collapsed ? thinkingTail(fullText) : fullText;
  const indicator = div.querySelector(".thinking-toggle");
  if (indicator) indicator.textContent = collapsed ? "\u25b8" : "\u25be";
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

// Remove the streaming marker from a bubble and restore its label.
function settleBubbleVisuals(bubble) {
  bubble.classList.remove("streaming");
  const label = bubble.querySelector(".msg-label");
  if (label) label.textContent = "Pi";
}

// Start a new assistant bubble for live streaming. A previous bubble,
// if any, is settled visually and its state is replaced.
function startStreamBubble() {
  if (state.streamBubble) settleBubbleVisuals(state.streamBubble);
  state.streamBubble = null;
  state.streamTextEl = null;
  state.streamTextRaw = "";
  state.streamRenderPending = false;
  state.streamThinkingBox = null;
  state.streamThinkingEl = null;
  state.streamThinkingRaw = "";
  state.streamPlaceholderEl = null;
  state.streamHasContent = false;
  const div = el("div", "msg assistant streaming");
  div.append(el("div", "msg-label", "Pi · streaming"));
  const thinking = el("div", "thinking");
  thinking.hidden = true;
  thinking.append(el("div", "thinking-label", "thinking"));
  const thinkingPre = el("pre", "", "");
  thinking.append(thinkingPre);
  const text = el("div", "msg-text", "");
  text.hidden = true;
  const placeholder = el("div", "msg-text msg-placeholder", kProcessingPlaceholder);
  div.append(thinking, text, placeholder);
  elements.messages.append(div);
  state.streamBubble = div;
  state.streamTextEl = text;
  state.streamThinkingBox = thinking;
  state.streamThinkingEl = thinkingPre;
  state.streamPlaceholderEl = placeholder;
  followMessagesScroll();
}

// Reuse the placeholder bubble when it has no content yet; otherwise
// start a fresh bubble for the new assistant message.
function ensureStreamBubble() {
  if (state.streamBubble && !state.streamHasContent) return;
  startStreamBubble();
}

// Append a text delta to the streaming bubble. The accumulated text
// is re-rendered as markdown, at most once per animation frame.
// Thinking deltas stay plain text.
function appendStreamText(delta) {
  if (!state.streamTextEl) startStreamBubble();
  state.streamTextEl.hidden = false;
  markStreamContent();
  state.streamTextRaw += delta;
  scheduleStreamTextRender();
}

// Re-render the streamed text as markdown and keep the pane at the
// bottom. At most one render per animation frame.
function scheduleStreamTextRender() {
  if (state.streamRenderPending) return;
  state.streamRenderPending = true;
  requestAnimationFrame(() => {
    state.streamRenderPending = false;
    if (!state.streamTextEl) return;
    state.streamTextEl.innerHTML = renderMarkdown(state.streamTextRaw);
    followMessagesScroll();
  });
}

// Append a thinking delta to the streaming bubble. The full text is
// kept in state; the visible pane shows the last few lines unless the
// user expanded the block.
function appendStreamThinking(delta) {
  if (!state.streamThinkingEl) startStreamBubble();
  state.streamThinkingBox.hidden = false;
  markStreamContent();
  state.streamThinkingRaw += delta;
  const expanded = !state.streamThinkingBox.classList.contains("collapsed");
  state.streamThinkingEl.textContent = expanded ? state.streamThinkingRaw : thinkingTail(state.streamThinkingRaw);
  followMessagesScroll();
}

// Mark the bubble as having content: hide the processing placeholder.
function markStreamContent() {
  if (state.streamPlaceholderEl) state.streamPlaceholderEl.hidden = true;
  state.streamHasContent = true;
}

// Remove the streaming marker when the run settles and clear state.
function finishStreamBubble() {
  if (state.streamBubble) settleBubbleVisuals(state.streamBubble);
  resetStreamingState();
}

// Reset the per-session streaming UI state: bubble, live tools, abort button.
// Called on session switch, view reset, and run settlement.
function resetStreamingState() {
  state.streaming = false;
  state.streamBubble = null;
  state.streamTextEl = null;
  state.streamTextRaw = "";
  state.streamRenderPending = false;
  state.streamThinkingBox = null;
  state.streamThinkingEl = null;
  state.streamThinkingRaw = "";
  state.streamPlaceholderEl = null;
  state.streamHasContent = false;
  state.liveTools.clear();
  elements.stopRunBtn.hidden = true;
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
  if (state.streamBubble) {
    state.streamBubble.append(toolCallChip(event.toolName, event.args, event.toolCallId));
    markStreamContent();
  }
  followToolPanelScroll();
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
      elements.stopRunBtn.hidden = false;
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
    case "agent_start":
      state.streaming = true;
      elements.stopRunBtn.hidden = false;
      ensureStreamBubble();
      break;
    case "message_start":
      if (event.message?.role === "assistant") ensureStreamBubble();
      break;
    case "message_update": {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta") appendStreamText(delta.delta);
      else if (delta?.type === "thinking_delta") appendStreamThinking(delta.delta);
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
      elements.stopRunBtn.hidden = true;
      finishStreamBubble();
      refreshMessages(false);
      if (state.autoTitle) loadTitle(state.activeId);
      break;
    case "process_exited":
      updateStatus({ running: false });
      break;
    case "extension_ui_request":
      handleExtensionUi(event);
      break;
  }
}

// Update the process status dot and label, and follow the live
// thinking level when the status carries one.
function updateStatus(status) {
  elements.statusDot.className = `dot${status.running ? " on" : ""}`;
  if (status.running && status.isStreaming) {
    elements.statusText.textContent = `Pi is working (pid ${status.pid})`;
  } else if (status.running) {
    elements.statusText.textContent = `Pi process running (pid ${status.pid})`;
  } else {
    elements.statusText.textContent = "Pi process stopped. It starts on the next message.";
  }
  if (status.thinkingLevel !== undefined) syncThinkingLevelSelect(status.thinkingLevel);
}

// Send the current input as a message or a slash command.
// streamingBehavior is always sent: pi ignores it when idle and
// requires it when streaming. Extension commands execute immediately
// in pi and ignore it.
async function sendMessage() {
  const text = elements.input.value.trim();
  if (!text) return;
  const isCommand = text.startsWith("/");
  elements.input.value = "";
  hideCommandMenu();
  const bubble = el("div", "msg user");
  bubble.append(el("div", "msg-label", "You"), el("div", "msg-body", text));
  elements.messages.append(bubble);
  scrollBottom();
  const body = { message: text, streamingBehavior: state.streamingBehavior };
  if (!isCommand) {
    state.streaming = true;
    elements.stopRunBtn.hidden = false;
  }
  try {
    await api(`/api/sessions/${state.activeId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (!isCommand) {
      state.streaming = false;
      elements.stopRunBtn.hidden = true;
    }
    elements.messages.append(el("div", "error-line", `Send failed: ${err.message}`));
    scrollBottom();
  }
}

// Interrupt the in-flight agent run. The pi process stays alive.
async function abortRun() {
  try {
    await api(`/api/sessions/${state.activeId}/abort`, { method: "POST" });
  } catch (err) {
    elements.messages.append(el("div", "error-line", `Stop failed: ${err.message}`));
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

// Check whether a scrollable pane is within kFollowEdgePx of its
// bottom edge.
function isNearBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= kFollowEdgePx;
}

// Scroll the message pane to the bottom.
function scrollBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

// Follow the message pane: scroll to the bottom only while the user
// is still near it. Lets the user read older messages without
// streaming updates pulling the view down.
function followMessagesScroll() {
  if (state.followMessages) scrollBottom();
}

// Follow the tool panel: scroll to the bottom only while the user
// is still near it.
function followToolPanelScroll() {
  if (state.followToolPanel) scrollPanelBottom();
}

// Wire up static controls.
function init() {
  elements.search.oninput = renderSessionList;
  elements.refreshBtn.onclick = () => loadSessions().catch((err) => console.error(err));
  elements.newSessionBtn.onclick = newSession;
  elements.emptyNewBtn.onclick = newSession;
  elements.deleteSelectedBtn.onclick = deleteSelected;
  elements.sendBtn.onclick = sendMessage;
  elements.stopRunBtn.onclick = abortRun;
  elements.stopBtn.onclick = stopProcess;
  elements.modelSelect.addEventListener("focus", loadModels);
  elements.modelSelect.addEventListener("change", changeModel);
  elements.thinkingLevelSelect.addEventListener("change", changeThinkingLevel);
  elements.toolPanelToggle.onclick = toggleToolPanel;
  elements.toolPanelClose.onclick = toggleToolPanel;
  elements.messages.addEventListener("scroll", () => {
    state.followMessages = isNearBottom(elements.messages);
  });
  elements.toolPanelBody.addEventListener("scroll", () => {
    state.followToolPanel = isNearBottom(elements.toolPanelBody);
  });
  state.panelOpen = loadPanelOpen();
  setToolPanel(state.panelOpen);
  elements.input.addEventListener("input", renderCommandMenu);
  elements.input.addEventListener("keydown", (e) => {
    const menuVisible = !elements.commandMenu.hidden;
    if (menuVisible && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const matches = filterCommands(commandToken(elements.input.value) ?? "");
      if (matches.length > 0) {
        const count = matches.length;
        state.menuIndex = e.key === "ArrowDown"
          ? (state.menuIndex + 1) % count
          : (state.menuIndex - 1 + count) % count;
        renderCommandMenu();
      }
      return;
    }
    if (menuVisible && (e.key === "Tab" || e.key === "Enter") && state.menuIndex >= 0) {
      e.preventDefault();
      const matches = filterCommands(commandToken(elements.input.value) ?? "");
      selectCommand(matches[state.menuIndex]);
      return;
    }
    if (menuVisible && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hideCommandMenu();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  elements.dialogBackdrop.addEventListener("click", (e) => {
    if (e.target !== elements.dialogBackdrop) return;
    if (state.pendingDialog) cancelDialog();
    else dismissLocalDialog();
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
