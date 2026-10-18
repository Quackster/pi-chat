// Reads Pi session files from disk.
// Sessions live in <sessionsDir>/--<cwd>--/<timestamp>_<uuid>.jsonl.
// Each file is JSONL. The first line is the session header.
// Later lines are tree entries linked by id and parentId.

import { readdir, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const kLogPrefix = "sessions";
const kPreviewLength = 120;

function log(message) {
  console.log(`${kLogPrefix}: ${message}`);
}

// Split a JSONL text into parsed objects. Bad lines are skipped with a log line.
function parseJsonl(raw, fileName) {
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      log(`skipping unparseable line in ${fileName}`);
    }
  }
  return entries;
}

// Extract plain text from a message content field (string or block array).
export function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

// Build a session summary from one parsed file.
function summarize(file, header, entries) {
  let name = null;
  let model = null;
  let thinkingLevel = null;
  let lastActivity = header.timestamp;
  let preview = null;
  let messageCount = 0;
  for (const entry of entries) {
    if (entry.timestamp > lastActivity) lastActivity = entry.timestamp;
    if (entry.type === "session_info" && entry.name) name = entry.name;
    if (entry.type === "model_change") {
      model = `${entry.provider}/${entry.modelId}`;
    }
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
    if (entry.type === "message") {
      messageCount += 1;
      if (preview === null && entry.message.role === "user") {
        const text = extractText(entry.message.content).replace(/\s+/g, " ").trim();
        preview = text.length > kPreviewLength ? `${text.slice(0, kPreviewLength)}...` : text;
      }
    }
  }
  return {
    id: header.id,
    file,
    cwd: header.cwd,
    createdAt: header.timestamp,
    lastActivity,
    name,
    preview,
    model,
    thinkingLevel,
    messageCount,
  };
}

// Parse one session file into { summary, entries }.
// Files that lost their first line (truncated writes) get a
// synthesized header from the file name and directory name.
async function parseSessionFile(file) {
  const raw = await readFile(file, "utf8");
  const lines = parseJsonl(raw, path.basename(file));
  let header = lines.find((entry) => entry.type === "session");
  if (!header) {
    header = synthesizeHeader(file);
    if (!header) {
      log(`no header in ${file}, skipping`);
      return null;
    }
    log(`synthesized header for truncated file ${file}`);
  }
  const entries = lines.filter((entry) => entry.type !== "session");
  return { summary: summarize(file, header, entries), entries };
}

// Rebuild a minimal header for a file that lost its first line.
// The id and creation time come from the file name; the cwd comes
// from the session subdirectory name. Returns null when the file
// name does not match the <timestamp>_<uuid>.jsonl pattern.
function synthesizeHeader(file) {
  const base = path.basename(file, ".jsonl");
  const underscore = base.lastIndexOf("_");
  if (underscore <= 0) return null;
  const timestamp = base.slice(0, underscore);
  const id = base.slice(underscore + 1);
  if (!timestamp || !/^[0-9a-f-]+$/i.test(id)) return null;
  const dir = path.basename(path.dirname(file));
  const cwd =
    dir.startsWith("--") && dir.endsWith("--") && dir.length > 4
      ? dir.slice(1, -1).replace(/-/g, "/")
      : null;
  return { id, timestamp, cwd };
}

// List every session in the session directory, newest activity first.
export async function listSessions(sessionsDir) {
  let files;
  try {
    files = await readdir(sessionsDir, { recursive: true });
  } catch (err) {
    log(`cannot read session dir ${sessionsDir}: ${err.message}`);
    return [];
  }
  const sessions = [];
  for (const relative of files) {
    if (!relative.endsWith(".jsonl")) continue;
    const file = path.join(sessionsDir, relative);
    try {
      const parsed = await parseSessionFile(file);
      if (parsed) sessions.push(parsed.summary);
    } catch (err) {
      log(`failed to read ${file}: ${err.message}`);
    }
  }
  sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return sessions;
}

// Find one session by full or partial UUID.
// The UUID is embedded in the file name, so the fast path avoids reading files.
export async function findSession(sessionsDir, sessionId) {
  const sessions = await listSessions(sessionsDir);
  const match =
    sessions.find((session) => session.id === sessionId) ??
    sessions.find((session) => session.id.startsWith(sessionId));
  return match ?? null;
}

// Delete a session file from disk. A missing file is treated as already
// deleted (pi writes new session files lazily).
export async function deleteSessionFile(file) {
  if (!file) return;
  if (existsSync(file)) await unlink(file);
  log(`deleted session file ${file}`);
}

// Return the active branch of a session: the chain from the last written
// entry back to the root, in chronological order. Returns [] when the file
// does not exist yet (pi writes new session files lazily).
export async function readSessionMessages(file) {
  if (!file || !existsSync(file)) return [];
  const parsed = await parseSessionFile(file);
  if (!parsed) return [];
  const entries = parsed.entries;
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain = [];
  let cursor = entries[entries.length - 1];
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
  }
  return chain.reverse();
}
