// pi-chat entry point.
// Reads Pi sessions from disk and serves the web UI on localhost.
// Pi processes are always launched headless: `pi --mode rpc`.

import os from "node:os";
import path from "node:path";
import { createServer } from "./server.js";
import { SessionProcessManager } from "./rpc_manager.js";
import { SessionTitleStore } from "./session_titles.js";
import { AppConfig } from "./config.js";

const kDefaultPort = 8090;
const kDefaultHost = "127.0.0.1";
const kShutdownGraceMs = 3000;

function main() {
  const port = Number(process.env.PICHAT_PORT ?? kDefaultPort);
  const host = process.env.PICHAT_HOST ?? kDefaultHost;
  const sessionsDir =
    process.env.PI_SESSIONS_DIR ?? path.join(os.homedir(), ".pi", "agent", "sessions");
  const publicDir = path.join(import.meta.dirname, "..", "public");
  const tmpDir = path.join(import.meta.dirname, "..", "tmp");

  const manager = new SessionProcessManager({ fallbackCwd: os.homedir() });
  const titleStore = new SessionTitleStore(tmpDir);
  const config = new AppConfig(path.join(import.meta.dirname, "..", "config.json"));
  const server = createServer({ sessionsDir, manager, publicDir, titleStore, config });

  server.listen(port, host, () => {
    console.log(`pi-chat: listening on http://${host}:${port}`);
    console.log(`pi-chat: sessions dir ${sessionsDir}`);
    console.log(`pi-chat: titles file ${titleStore.file_}`);
    console.log(`pi-chat: config file ${config.file_}`);
  });

  const shutdown = () => {
    console.log("pi-chat: shutting down");
    manager.stopAll();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), kShutdownGraceMs).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
