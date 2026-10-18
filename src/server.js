// HTTP server for pi-chat.
// Serves the web UI and a small JSON API.
// Agent events are fanned out to browser clients over Server-Sent Events.

import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteSessionFile, findSession, listSessions, readSessionMessages } from "./session_store.js";
import { generateSessionTitle } from "./session_titles.js";
import { kThinkingLevels } from "./rpc_manager.js";

const kLogPrefix = "server";
const kMaxBodyBytes = 1024 * 1024;
const kSseHeartbeatMs = 20000;

function log(message) {
  console.log(`${kLogPrefix}: ${message}`);
}

// Send a JSON response with the given status code.
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

// Read and parse a JSON request body, bounded in size.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > kMaxBodyBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Serve a static file from the public directory.
async function serveStatic(res, publicDir, name) {
  const file = path.join(publicDir, path.normalize(name).replace(/^(\.\.[\/\\])+/, ""));
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": contentTypeFor(file) });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: `not found: ${name}` });
  }
}

// Map a file extension to a Content-Type header value.
function contentTypeFor(file) {
  const ext = path.extname(file);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

// Open an SSE stream for one session and relay its agent events.
// The listener is registered before the hello so no event is lost while
// the hello state query is in flight.
async function openSseStream(res, sessionId, manager) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const unsubscribe = manager.onEvent(sessionId, (event) => send("event", event));
  send("hello", await manager.getState(sessionId));
  const heartbeat = setInterval(() => send("ping", {}), kSseHeartbeatMs);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// Create the HTTP server.
// options: { sessionsDir, manager, publicDir, titleStore, config }.
export function createServer(options) {
  const { sessionsDir, manager, publicDir, titleStore, config } = options;

  // Stop the session process, forget it, and delete its file and title.
  // Throws when the session is not known and not on disk.
  async function deleteSessionById(id) {
    const session = (await findSession(sessionsDir, id)) ?? manager.getKnownSession(id);
    if (!session) throw new Error(`session not found: ${id}`);
    manager.stop(session.id);
    manager.forgetSession(session.id);
    await deleteSessionFile(session.file);
    await titleStore.delete(session.id);
    return session;
  }

  // Resolve the title for a session: the stored title, the session's own
  // name, or a freshly generated title that is stored for next time.
  // Generation only happens when auto titles are enabled.
  async function resolveSessionTitle(session) {
    const stored = await titleStore.get(session.id);
    if (stored) return stored;
    if (session.name) return session.name;
    if (!(await config.get("autoTitle"))) return null;
    const entries = await readSessionMessages(session.file);
    const title = await generateSessionTitle({
      piCommand: manager.getPiCommand(),
      cwd: session.cwd,
      entries,
    });
    if (title) await titleStore.set(session.id, title);
    return title;
  }

  // Generate a title for the first user prompt of a session when auto
  // titles are enabled. Fire and forget: the prompt must not wait for
  // the title model run.
  async function maybeAutoTitle(session, message) {
    try {
      if (!(await config.get("autoTitle"))) return;
      if (await titleStore.get(session.id)) return;
      if (session.name) return;
      const entries = await readSessionMessages(session.file);
      const hasUserMessage = entries.some(
        (entry) => entry.type === "message" && entry.message?.role === "user",
      );
      if (hasUserMessage) return;
      const title = await generateSessionTitle({
        piCommand: manager.getPiCommand(),
        cwd: session.cwd,
        entries: [{ type: "message", message: { role: "user", content: message } }],
      });
      if (title) {
        await titleStore.set(session.id, title);
        log(`auto title for session ${session.id}: ${title}`);
      }
    } catch (err) {
      log(`auto title for session ${session.id} failed: ${err.message}`);
    }
  }

  // Handle one API request. parts is the pathname split into segments.
  async function handleApi(req, res, parts) {
    if (parts[1] === "config") {
      if (req.method === "GET") {
        return sendJson(res, 200, await config.all());
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (body.autoTitle !== undefined) await config.set("autoTitle", body.autoTitle);
        if (body.streamingBehavior !== undefined) {
          if (body.streamingBehavior !== "steer" && body.streamingBehavior !== "followUp") {
            return sendJson(res, 400, { error: "streamingBehavior must be 'steer' or 'followUp'" });
          }
          await config.set("streamingBehavior", body.streamingBehavior);
        }
        return sendJson(res, 200, await config.all());
      }
      return sendJson(res, 405, { error: "use GET or POST" });
    }
    if (parts[1] === "new-session") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });
      const body = await readJsonBody(req);
      if (typeof body.cwd !== "string" || !body.cwd) {
        return sendJson(res, 400, { error: "cwd must be a non-empty string" });
      }
      if (!existsSync(body.cwd)) {
        return sendJson(res, 400, { error: `cwd does not exist: ${body.cwd}` });
      }
      return sendJson(res, 200, await manager.startNewSession(body.cwd));
    }
    if (parts[1] === "browse" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const raw = url.searchParams.get("path");
      const target = raw ? path.resolve(raw) : os.homedir();
      let info;
      try {
        info = await stat(target);
      } catch {
        return sendJson(res, 404, { error: `no such directory: ${target}` });
      }
      if (!info.isDirectory()) {
        return sendJson(res, 400, { error: `not a directory: ${target}` });
      }
      let dirents;
      try {
        dirents = await readdir(target, { withFileTypes: true });
      } catch (err) {
        return sendJson(res, 500, { error: `cannot read ${target}: ${err.message}` });
      }
      const entries = dirents
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .filter((d) => !d.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({ name: d.name, path: target === "/" ? `/${d.name}` : `${target}/${d.name}` }));
      return sendJson(res, 200, { path: target, home: os.homedir(), entries });
    }
    if (parts[1] === "mkdir" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.path !== "string" || !body.path) {
        return sendJson(res, 400, { error: "path must be a non-empty string" });
      }
      const target = path.resolve(body.path);
      try {
        await mkdir(target, { recursive: true });
      } catch (err) {
        return sendJson(res, 500, { error: `mkdir failed: ${err.message}` });
      }
      return sendJson(res, 200, { ok: true, path: target });
    }
    if (parts[1] !== "sessions") {
      return sendJson(res, 404, { error: `unknown api route: ${req.url}` });
    }
    if (parts[2] === "bulk-delete") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids)
        ? [...new Set(body.ids.filter((value) => typeof value === "string" && value))]
        : [];
      if (ids.length === 0) return sendJson(res, 400, { error: "ids must be a non-empty array" });
      const results = [];
      for (const id of ids) {
        try {
          const session = await deleteSessionById(id);
          results.push({ id, ok: true, deleted: session.file });
        } catch (err) {
          results.push({ id, ok: false, error: err.message });
        }
      }
      return sendJson(res, 200, { results });
    }
    const id = parts[2];
    const action = parts[3];
    if (action === undefined && !id) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "use GET" });
      const sessions = await listSessions(sessionsDir);
      for (const known of manager.getKnownSessions()) {
        if (!sessions.some((s) => s.id === known.id)) sessions.push(known);
      }
      const titles = await titleStore.all();
      for (const session of sessions) session.title = titles[session.id] ?? null;
      sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
      return sendJson(res, 200, { sessions });
    }
    if (!id) return sendJson(res, 400, { error: "missing session id" });
    const session = (await findSession(sessionsDir, id)) ?? manager.getKnownSession(id);
    if (!session) return sendJson(res, 404, { error: `session not found: ${id}` });

    if (action === undefined && req.method === "DELETE") {
      await deleteSessionById(session.id);
      return sendJson(res, 200, { ok: true, deleted: session.file });
    }
    if (action === undefined) return sendJson(res, 405, { error: "use GET or DELETE" });

    if (action === "messages" && req.method === "GET") {
      const messages = await readSessionMessages(session.file);
      return sendJson(res, 200, { messages });
    }
    if (action === "title" && req.method === "GET") {
      const title = await resolveSessionTitle(session);
      return sendJson(res, 200, { title });
    }
    if (action === "status" && req.method === "GET") {
      return sendJson(res, 200, await manager.getState(session.id));
    }
    if (action === "models" && req.method === "GET") {
      const models = await manager.getAvailableModels(session);
      return sendJson(res, 200, { models });
    }
    if (action === "commands" && req.method === "GET") {
      const commands = await manager.getCommands(session);
      return sendJson(res, 200, { commands });
    }
    if (action === "ui-response" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.id !== "string" || !body.id) {
        return sendJson(res, 400, { error: "id must be a non-empty string" });
      }
      const hasValue = "value" in body;
      const hasConfirmed = "confirmed" in body;
      const hasCancelled = body.cancelled === true;
      const count = (hasValue ? 1 : 0) + (hasConfirmed ? 1 : 0) + (hasCancelled ? 1 : 0);
      if (count !== 1) {
        return sendJson(res, 400, { error: "exactly one of value, confirmed, or cancelled is required" });
      }
      if (hasValue && typeof body.value !== "string") {
        return sendJson(res, 400, { error: "value must be a string" });
      }
      if (hasConfirmed && typeof body.confirmed !== "boolean") {
        return sendJson(res, 400, { error: "confirmed must be a boolean" });
      }
      const response = { type: "extension_ui_response", id: body.id };
      if (hasValue) response.value = body.value;
      if (hasConfirmed) response.confirmed = body.confirmed;
      if (hasCancelled) response.cancelled = true;
      try {
        manager.sendUiResponse(session.id, response);
      } catch (err) {
        return sendJson(res, 502, { error: err.message });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (action === "model" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.provider !== "string" || typeof body.modelId !== "string") {
        return sendJson(res, 400, { error: "provider and modelId are required" });
      }
      const model = await manager.setModel(session, body.provider, body.modelId);
      return sendJson(res, 200, { ok: true, model });
    }
    if (action === "thinking-level" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!kThinkingLevels.includes(body.level)) {
        return sendJson(res, 400, { error: `level must be one of: ${kThinkingLevels.join(", ")}` });
      }
      const response = await manager.setThinkingLevel(session, body.level);
      return sendJson(res, 200, { ok: true, response });
    }
    if (action === "events" && req.method === "GET") {
      return await openSseStream(res, session.id, manager);
    }
    if (action === "prompt" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.message !== "string" || !body.message.trim()) {
        return sendJson(res, 400, { error: "message must be a non-empty string" });
      }
      maybeAutoTitle(session, body.message);
      const response = await manager.prompt(session, body.message, body.streamingBehavior);
      return sendJson(res, 200, { ok: true, response });
    }
    if (action === "abort" && req.method === "POST") {
      const response = await manager.abort(session.id);
      return sendJson(res, 200, { ok: true, response });
    }
    if (action === "stop" && req.method === "POST") {
      const stopped = manager.stop(session.id);
      return sendJson(res, 200, { ok: true, stopped });
    }
    return sendJson(res, 404, { error: `unknown action: ${action}` });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "api") {
        await handleApi(req, res, parts);
        return;
      }
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "use GET" });
      }
      const name = parts.length === 0 ? "index.html" : parts.join("/");
      await serveStatic(res, publicDir, name);
    } catch (err) {
      log(`request failed: ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    }
  });

  return server;
}
