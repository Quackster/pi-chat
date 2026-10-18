// Session titles: one-shot model generation and persistence.
// A generated title is stored in <dir>/titles.json so it survives
// restarts. Deleting a session removes its entry from the file.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractText } from "./session_store.js";

const kLogPrefix = "titles";
const kModelTimeoutMs = 60000;
const kPromptLimit = 2000;
const kTitleLimit = 80;
const kStderrTailLength = 200;
const kSystemPrompt =
  "You name conversations. Given the start of a conversation, reply with " +
  "one short title of at most 8 words. No quotes. No trailing punctuation. " +
  "No prefix such as Title.";

function log(message) {
  console.log(`${kLogPrefix}: ${message}`);
}

// Persist generated session titles in a JSON file inside a directory.
export class SessionTitleStore {
  constructor(dir) {
    this.dir_ = dir;
    this.file_ = path.join(dir, "titles.json");
    this.titles_ = new Map();
    this.loaded_ = false;
    this.writeChain_ = Promise.resolve();
  }

  // Load titles from disk once. A missing or corrupt file starts empty.
  async load_() {
    if (this.loaded_) return;
    this.loaded_ = true;
    try {
      const data = JSON.parse(await readFile(this.file_, "utf8"));
      for (const [id, title] of Object.entries(data)) {
        if (typeof title === "string" && title) this.titles_.set(id, title);
      }
    } catch (err) {
      if (err.code !== "ENOENT") log(`cannot load ${this.file_}: ${err.message}`);
    }
  }

  // Return the stored title for a session, or null.
  async get(sessionId) {
    await this.load_();
    return this.titles_.get(sessionId) ?? null;
  }

  // Store a title and persist it to disk.
  async set(sessionId, title) {
    await this.load_();
    this.titles_.set(sessionId, title);
    await this.persist_();
  }

  // Remove a title and persist the change.
  async delete(sessionId) {
    await this.load_();
    if (!this.titles_.delete(sessionId)) return;
    await this.persist_();
  }

  // Return every stored title as a plain object.
  async all() {
    await this.load_();
    return Object.fromEntries(this.titles_);
  }

  // Serialize writes so concurrent mutations cannot interleave.
  async persist_() {
    const snapshot = JSON.stringify(Object.fromEntries(this.titles_), null, 2);
    this.writeChain_ = this.writeChain_.then(async () => {
      await mkdir(this.dir_, { recursive: true });
      await writeFile(this.file_, snapshot, "utf8");
    });
    await this.writeChain_;
  }
}

// Build the title prompt from the first user message of a session.
// Returns null when the session has no user text.
function buildTitlePrompt(entries) {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const text = extractText(entry.message.content).replace(/\s+/g, " ").trim();
    if (!text) continue;
    return text.length > kPromptLimit ? text.slice(0, kPromptLimit) : text;
  }
  return null;
}

// Derive a title from the first user message. Used when the model
// run fails or returns nothing usable.
function deriveTitle(prompt) {
  if (!prompt) return null;
  return prompt.length > kTitleLimit ? prompt.slice(0, kTitleLimit).trim() : prompt;
}

// Clean a model reply into a title. Takes the first line and strips
// quotes, prefixes, and trailing punctuation. Returns null when the
// reply holds nothing usable.
function cleanTitle(raw) {
  let title = raw.split("\n")[0].trim();
  title = title.replace(/^["'`]+|["'`]+$/g, "");
  title = title.replace(/^(title|topic)\s*:\s*/i, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/[.!?]+$/g, "");
  if (title.length > kTitleLimit) title = title.slice(0, kTitleLimit).trim();
  return title || null;
}

// Run a one-shot headless `pi -p` and resolve with its stdout text.
// Rejects on spawn error, non-zero exit, or timeout.
function runTitleModel(piCommand, cwd, prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--thinking",
      "off",
      "--system-prompt",
      kSystemPrompt,
      prompt,
    ];
    const proc = spawn(piCommand, args, {
      cwd,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`title model timed out after ${kModelTimeoutMs}ms`));
    }, kModelTimeoutMs);
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`title model exited with code ${code}: ${stderr.slice(-kStderrTailLength).trim()}`));
    });
  });
}

// Generate a title for one session. Tries a one-shot model run first,
// then falls back to the first user message. Resolves with a title
// string or null when the session has no usable text.
export async function generateSessionTitle(options) {
  const { piCommand, cwd, entries } = options;
  const prompt = buildTitlePrompt(entries);
  const fallback = deriveTitle(prompt);
  if (!prompt) return fallback;
  try {
    const target = cwd && existsSync(cwd) ? cwd : process.cwd();
    const raw = await runTitleModel(piCommand, target, prompt);
    const title = cleanTitle(raw);
    if (title) return title;
    log("model returned no usable title, using derived title");
  } catch (err) {
    log(`model title failed, using derived title: ${err.message}`);
  }
  return fallback;
}
