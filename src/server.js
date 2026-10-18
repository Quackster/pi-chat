// HTTP server for pi-chat.
// Serves the web UI and a small JSON API.
// Agent events are fanned out to browser clients over Server-Sent Events.

import http from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { deleteSessionFile, findSession, listSessions, readSessionMessages } from "./session_store.js";

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

// Create the HTTP server. options: { sessionsDir, manager, publicDir }.
export function createServer(options) {
  const { sessionsDir, manager, publicDir } = options;

  // Stop the session process, forget it, and delete its file.
  // Throws when the session is not known and not on disk.
  async function deleteSessionById(id) {
    const session = (await findSession(sessionsDir, id)) ?? manager.getKnownSession(id);
    if (!session) throw new Error(`session not found: ${id}`);
    manager.stop(session.id);
    manager.forgetSession(session.id);
    await deleteSessionFile(session.file);
    return session;
  }

  // Handle one API request. parts is the pathname split into segments.
  async function handleApi(req, res, parts) {
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
    if (action === "status" && req.method === "GET") {
      return sendJson(res, 200, await manager.getState(session.id));
    }
    if (action === "models" && req.method === "GET") {
      const models = await manager.getAvailableModels(session);
      return sendJson(res, 200, { models });
    }
    if (action === "model" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.provider !== "string" || typeof body.modelId !== "string") {
        return sendJson(res, 400, { error: "provider and modelId are required" });
      }
      const model = await manager.setModel(session, body.provider, body.modelId);
      return sendJson(res, 200, { ok: true, model });
    }
    if (action === "events" && req.method === "GET") {
      return await openSseStream(res, session.id, manager);
    }
    if (action === "prompt" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (typeof body.message !== "string" || !body.message.trim()) {
        return sendJson(res, 400, { error: "message must be a non-empty string" });
      }
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
