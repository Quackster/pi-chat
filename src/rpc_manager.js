// Manages one headless `pi --mode rpc` process per session.
// A process is spawned on demand when it is not already running and stays
// alive between messages. The protocol is strict JSONL over stdin/stdout.
// Stdout records are split on "\n" only, per the RPC framing rules.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const kLogPrefix = "rpc";
const kCommandTimeoutMs = 60000;
const kReadyTimeoutMs = 30000;
const kStateTimeoutMs = 5000;
const kStderrTailLength = 2000;

function log(message) {
  console.log(`${kLogPrefix}: ${message}`);
}

// Owns the pi processes for a set of sessions.
export class SessionProcessManager {
  constructor(options = {}) {
    this.piCommand_ = options.piCommand ?? "pi";
    this.fallbackCwd_ = options.fallbackCwd ?? process.cwd();
    this.requestCounter_ = 0;
    this.spawnCounter_ = 0;
    this.processes_ = new Map(); // sessionId -> process record
    this.listeners_ = new Map(); // sessionId -> Set of event listeners
    this.knownSessions_ = new Map(); // sessionId -> summary (sessions we created)
  }

  // The pi executable used for all spawns.
  getPiCommand() {
    return this.piCommand_;
  }

  // Summaries of sessions this server created. pi writes their files lazily
  // (on the first assistant message), so disk lookups may miss them.
  getKnownSessions() {
    return [...this.knownSessions_.values()];
  }

  // Find a session we created, or null.
  getKnownSession(sessionId) {
    return this.knownSessions_.get(sessionId) ?? null;
  }

  // Drop a session from the registry (e.g. after deletion).
  forgetSession(sessionId) {
    this.knownSessions_.delete(sessionId);
  }

  // True when a live process is attached to the session.
  isRunning(sessionId) {
    const record = this.processes_.get(sessionId);
    return record !== undefined && !record.exited;
  }

  // Status snapshot for the UI. Never spawns a process.
  // When running, it includes pi's get_state data (isStreaming, model, ...).
  async getState(sessionId) {
    const record = this.processes_.get(sessionId);
    if (record === undefined || record.exited) return { running: false };
    try {
      const response = await this.sendCommand(sessionId, { type: "get_state" }, { timeoutMs: kStateTimeoutMs });
      return { running: true, pid: record.proc.pid, startedAt: record.startedAt, ...response.data };
    } catch (err) {
      return { running: !record.exited, pid: record.proc.pid, error: err.message };
    }
  }

  // Spawn a headless RPC process for the session if it is not running.
  // sessionMeta is a session_store summary. Resolves once get_state answers.
  async ensureProcess(sessionMeta) {
    const existing = this.processes_.get(sessionMeta.id);
    if (existing !== undefined && !existing.exited) return existing;
    const cwd = this.resolveCwd_(sessionMeta.id, sessionMeta.cwd);
    const record = this.spawnProcess_(sessionMeta.id, cwd, ["--session", sessionMeta.id]);
    try {
      await this.sendCommand(sessionMeta.id, { type: "get_state" }, { timeoutMs: kReadyTimeoutMs });
    } catch (err) {
      this.teardown_(sessionMeta.id, record);
      throw new Error(`pi process for session ${sessionMeta.id} did not become ready: ${err.message}`);
    }
    return record;
  }

  // Start a fresh session: spawn a headless process in cwd without --session.
  // Resolves with { id, file, cwd } once get_state reports the session id.
  async startNewSession(cwd) {
    this.spawnCounter_ += 1;
    const tempId = `new-${this.spawnCounter_}`;
    const record = this.spawnProcess_(tempId, cwd, []);
    let state;
    try {
      state = await this.sendCommand(tempId, { type: "get_state" }, { timeoutMs: kReadyTimeoutMs });
    } catch (err) {
      this.teardown_(tempId, record);
      throw new Error(`new session process did not become ready: ${err.message}`);
    }
    const sessionId = state.data?.sessionId;
    if (!sessionId) {
      this.teardown_(tempId, record);
      throw new Error("new session process did not report a session id");
    }
    this.rekey_(tempId, sessionId);
    const now = new Date().toISOString();
    this.knownSessions_.set(sessionId, {
      id: sessionId,
      file: state.data?.sessionFile ?? null,
      cwd,
      createdAt: now,
      lastActivity: now,
      name: null,
      preview: null,
      model: null,
      thinkingLevel: null,
      messageCount: 0,
    });
    log(`created new session ${sessionId} in ${cwd} (pid ${record.proc.pid})`);
    return { id: sessionId, file: state.data?.sessionFile ?? null, cwd };
  }

  // List the models available to the session, spawning the process if needed.
  async getAvailableModels(sessionMeta) {
    await this.ensureProcess(sessionMeta);
    const response = await this.sendCommand(sessionMeta.id, { type: "get_available_models" });
    if (response.success === false) throw new Error(response.error ?? "failed to list models");
    return (response.data?.models ?? []).map((model) => ({
      provider: model.provider,
      modelId: model.id,
      name: model.name ?? model.id,
    }));
  }

  // Switch the session to a specific model, spawning the process if needed.
  async setModel(sessionMeta, provider, modelId) {
    await this.ensureProcess(sessionMeta);
    const response = await this.sendCommand(sessionMeta.id, { type: "set_model", provider, modelId });
    if (response.success === false) throw new Error(response.error ?? "failed to set model");
    return response.data ?? null;
  }

  // Send a user prompt, spawning the process first if needed.
  // streamingBehavior is "steer" or "followUp" when the agent is busy.
  async prompt(sessionMeta, message, streamingBehavior) {
    await this.ensureProcess(sessionMeta);
    const command = { type: "prompt", message };
    if (streamingBehavior) command.streamingBehavior = streamingBehavior;
    const response = await this.sendCommand(sessionMeta.id, command);
    if (response.success === false) throw new Error(response.error ?? "prompt rejected by pi");
    return response;
  }

  // Abort the in-flight agent run of a running session.
  async abort(sessionId) {
    const record = this.processes_.get(sessionId);
    if (record === undefined || record.exited) {
      throw new Error(`no live pi process for session ${sessionId}`);
    }
    return this.sendCommand(sessionId, { type: "abort" });
  }

  // Terminate the session process. The next prompt spawns a fresh one.
  stop(sessionId) {
    const record = this.processes_.get(sessionId);
    if (record === undefined || record.exited) return false;
    record.proc.kill("SIGTERM");
    log(`stopped process for session ${sessionId}`);
    return true;
  }

  // Terminate every managed process. Used on server shutdown.
  stopAll() {
    for (const sessionId of this.processes_.keys()) this.stop(sessionId);
  }

  // Subscribe to agent events for one session. Returns an unsubscribe function.
  onEvent(sessionId, listener) {
    let set = this.listeners_.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.listeners_.set(sessionId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  // Broadcast one event to every listener of the session.
  emitEvent(sessionId, event) {
    const set = this.listeners_.get(sessionId);
    if (set === undefined) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        log(`listener for session ${sessionId} threw: ${err.message}`);
      }
    }
  }

  // Send one RPC command and wait for its correlated response.
  // Resolves with the full response object. Rejects on timeout or exit.
  async sendCommand(sessionId, command, options = {}) {
    const record = this.processes_.get(sessionId);
    if (record === undefined || record.exited || record.proc.stdin.destroyed) {
      throw new Error(`no live pi process for session ${sessionId}`);
    }
    this.requestCounter_ += 1;
    const id = `req-${this.requestCounter_}`;
    const timeoutMs = options.timeoutMs ?? kCommandTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.pending.delete(id);
        reject(new Error(`command ${command.type} for session ${sessionId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      record.pending.set(id, { resolve, reject, timer });
      record.proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (err) => {
        if (err) {
          record.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // Resolve the working directory for a spawn, falling back when missing.
  resolveCwd_(label, cwd) {
    if (cwd && existsSync(cwd)) return cwd;
    log(`cwd ${cwd} missing for ${label}, using ${this.fallbackCwd_}`);
    return this.fallbackCwd_;
  }

  // Spawn a pi process, register its record, wire its handlers.
  spawnProcess_(key, cwd, extraArgs) {
    const proc = spawn(this.piCommand_, ["--mode", "rpc", ...extraArgs], {
      cwd,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const record = {
      key,
      proc,
      startedAt: new Date().toISOString(),
      exited: false,
      pending: new Map(),
      buffer: "",
      stderrTail: "",
    };
    this.processes_.set(key, record);
    this.attachToProcess_(record);
    log(`spawned ${this.piCommand_} for ${key} (pid ${proc.pid}, cwd ${cwd})`);
    return record;
  }

  // Move a process record and its listeners from one key to another.
  // The record keeps its current key so handlers emit under the right name.
  rekey_(from, to) {
    const record = this.processes_.get(from);
    this.processes_.delete(from);
    record.key = to;
    this.processes_.set(to, record);
    const listeners = this.listeners_.get(from);
    if (listeners !== undefined) {
      this.listeners_.delete(from);
      this.listeners_.set(to, listeners);
    }
  }

  // Wire stdout, stderr, error, and exit handlers onto a process record.
  attachToProcess_(record) {
    record.proc.stdout.on("data", (chunk) => this.onStdout_(record, chunk));
    record.proc.stderr.on("data", (chunk) => {
      record.stderrTail = (record.stderrTail + chunk.toString()).slice(-kStderrTailLength);
    });
    record.proc.on("error", (err) => {
      log(`process for session ${record.key} failed to start: ${err.message}`);
      this.markExited_(record, { code: null, error: err.message });
    });
    record.proc.on("exit", (code, signal) => {
      log(`process for session ${record.key} exited (code ${code}, signal ${signal})`);
      this.markExited_(record, { code, signal });
    });
  }

  // Consume one stdout chunk, split on "\n" only, route records.
  onStdout_(record, chunk) {
    record.buffer += chunk.toString();
    let index;
    while ((index = record.buffer.indexOf("\n")) !== -1) {
      let line = record.buffer.slice(0, index);
      record.buffer = record.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        log(`unparseable line from session ${record.key}: ${line.slice(0, 200)}`);
        continue;
      }
      if (event.type === "response" && event.id !== undefined && record.pending.has(event.id)) {
        const pending = record.pending.get(event.id);
        record.pending.delete(event.id);
        clearTimeout(pending.timer);
        pending.resolve(event);
      } else {
        this.emitEvent(record.key, event);
      }
    }
  }

  // Mark a process as exited, fail pending commands, notify listeners.
  markExited_(record, info) {
    if (record.exited) return;
    record.exited = true;
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`pi process for session ${record.key} exited before responding`));
    }
    record.pending.clear();
    this.emitEvent(record.key, { type: "process_exited", ...info, stderr: record.stderrTail || undefined });
  }

  // Kill a process that failed to become ready and drop its record.
  teardown_(sessionId, record) {
    if (!record.exited) record.proc.kill("SIGTERM");
    this.markExited_(record, { code: null, error: "readiness check failed" });
  }
}
