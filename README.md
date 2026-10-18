# pi-chat

Website UI interface to chat with your Pi agents.

## Screenshot

<img width="1848" height="1076" alt="Screenshot_20261018_142219" src="https://github.com/user-attachments/assets/b2d7f9d5-d64b-41f5-bf4c-b6d822c048dd" />

The left pane lists sessions. The center pane shows the message stream.
Tool calls appear as chips. File edits show as diffs. Thinking stays expanded.
The right pane is the tool call panel. It shows each command and its result.

## How it works

- Reads Pi sessions from `~/.pi/agent/sessions/` (JSONL files).
- Launches `pi --mode rpc --session <id>` on demand. Always headless.
- Keeps one process per session alive between messages.
- Streams agent events to the browser over Server-Sent Events.
- The session file on disk is the source of truth for history.

## Usage

```bash
npm start
# or
node src/main.js
```

Open http://127.0.0.1:8090.

Select a session, send a message, and watch the response stream in.
The Pi process starts on the first message if it is not already running.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `PICHAT_PORT` | `8090` | Port to listen on |
| `PICHAT_HOST` | `127.0.0.1` | Interface to bind |
| `PI_SESSIONS_DIR` | `~/.pi/agent/sessions` | Session storage directory |

## API

| Route | Method | Meaning |
|-------|--------|---------|
| `/api/sessions` | GET | List all sessions, newest first |
| `/api/sessions/:id/messages` | GET | Active branch of one session |
| `/api/sessions/:id/status` | GET | Process status for one session |
| `/api/sessions/:id/prompt` | POST | Send a message. Body: `{"message": "...", "streamingBehavior": "steer" \| "followUp"}` |
| `/api/sessions/:id/abort` | POST | Abort the in-flight run |
| `/api/sessions/:id/stop` | POST | Stop the session process |
| `/api/sessions/:id/events` | GET | SSE stream of agent events |

## Security note

The server binds to localhost by default. Pi processes run with full
system access. Do not expose the port without a gateway that
authenticates callers.
