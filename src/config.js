// App configuration, persisted as JSON in the server directory.
// A missing file or missing keys fall back to defaults.
// The file is re-read on every access, so edits apply without a
// restart.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const kLogPrefix = "config";
const kDefaults = { autoTitle: true };

function log(message) {
  console.log(`${kLogPrefix}: ${message}`);
}

// Read and write one small JSON config file.
export class AppConfig {
  constructor(file) {
    this.file_ = file;
    this.values_ = { ...kDefaults };
  }

  // Re-read values from disk. Missing file or keys keep the current
  // values.
  async load_() {
    try {
      const data = JSON.parse(await readFile(this.file_, "utf8"));
      for (const [key, value] of Object.entries(kDefaults)) {
        if (typeof data[key] === typeof value) this.values_[key] = data[key];
      }
    } catch (err) {
      if (err.code !== "ENOENT") log(`cannot load ${this.file_}: ${err.message}`);
    }
  }

  // Return one config value.
  async get(key) {
    await this.load_();
    return this.values_[key];
  }

  // Set one config value and persist it. Throws on unknown keys or
  // wrong value types.
  async set(key, value) {
    await this.load_();
    if (!(key in kDefaults)) throw new Error(`unknown config key: ${key}`);
    if (typeof value !== typeof kDefaults[key]) {
      throw new Error(`config ${key} must be a ${typeof kDefaults[key]}`);
    }
    this.values_[key] = value;
    await this.persist_();
  }

  // Return every config value as a plain object.
  async all() {
    await this.load_();
    return { ...this.values_ };
  }

  // Persist the current values to disk.
  async persist_() {
    await mkdir(path.dirname(this.file_), { recursive: true });
    await writeFile(this.file_, `${JSON.stringify(this.values_, null, 2)}\n`, "utf8");
  }
}
