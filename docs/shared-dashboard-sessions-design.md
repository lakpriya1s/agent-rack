# Shared dashboard sessions — design

## Problem

`agent-rack`'s `SessionManager` is in-memory and scoped to a single process. Every MCP client
(Claude Code, Codex CLI, opencode, etc.) currently spawns its own private `agent-rack start`
subprocess over stdio per that client's own MCP config, and `agent-rack dashboard`/`ui`
instantiates a second, completely separate `SessionManager` of its own (`App.tsx`). There is no
file, socket, or other shared state between any of these processes, so a session created via one
(e.g. a background codex task started through Claude Code's MCP tools) can never appear in a
dashboard launched separately — even on the same machine.

## Goal

Make it possible to launch a background agent task from any MCP client and see it appear, live,
in a dashboard opened separately — by making all of them talk to the same persistent server
instead of each owning private, disconnected state.

## Chosen approach: dashboard becomes an MCP client of a shared server

One persistent process — `agent-rack start --transport sse --port <p>` — is the single source of
truth, holding the one `SessionManager` instance. Every other participant (Claude Code, Codex,
opencode, and the dashboard itself) connects to that same server as an MCP client instead of
spawning or owning its own session state.

The dashboard specifically stops instantiating `SessionManager` directly and instead uses the
SDK's `SSEClientTransport` + `Client` (already a transitive dependency of
`@modelcontextprotocol/sdk`, no new package needed) to drive its UI purely off tool calls.

### Alternatives considered and rejected

- **Shared file/DB-backed session store** (every process, including ephemeral stdio ones, reads
  and writes a shared SQLite/JSON file): adds a new dependency and file-locking risk to solve a
  problem that doesn't exist once a single persistent server is in the picture — the user
  explicitly confirmed running one persistent shared server is acceptable.
- **Dashboard-as-server** (dashboard hosts the SSE server, other tools point at it): rejected
  because it would make closing the dashboard UI break every other tool's agent-rack access. A
  UI window shouldn't be a backend's uptime dependency.
- **Dashboard falls back to local/standalone mode when no shared server is reachable**: rejected
  in favor of always requiring the shared server — one code path, and no reintroduction of "was
  this session shared or local-only?" ambiguity.

## Components

### 1. Multi-client SSE fix (prerequisite)

`src/server.ts`'s `sse` branch currently tracks a single shared `SSEServerTransport` variable,
and the MCP SDK's `Server`/`Protocol.connect()` binds one `Server` instance to one transport at a
time — so only one client can ever be usefully connected. This must change before multiple
clients (Claude Code + Codex + dashboard) can connect simultaneously:

- `GET /sse` creates a **fresh `Server` instance** (registered with the same tool handlers,
  sharing the one `SessionManager`/`config`) connected to a **fresh `SSEServerTransport`**.
- Track connections in `Map<sessionId, Server>` keyed by `SSEServerTransport.sessionId` (the SDK
  generates this per-transport for exactly this purpose).
- `POST /message?sessionId=...` routes to the matching map entry.
- Remove the map entry on transport close/disconnect.

### 2. `agent_session_list` tool

- `SessionManager.listSessions(): AgentSession[]` — `Array.from(this.sessions.values())`, sorted
  by `createdAt` descending.
- New tool in `tools/unified.ts`, no params, returns `sessions.map(s => s.getInfo())` as JSON —
  same shape `agent_session_status` already returns per-session.

### 3. Dashboard remote client (`src/cli/dashboard/remoteClient.ts`)

Thin wrapper around the SDK's `Client` + `SSEClientTransport`, exposing:
`listSessions()`, `getSessionStatus(id)`, `getSessionLogs(id, offset?, limit?)`,
`sendInput(id, message)`, `cancelSession(id)`, `createSession(agent, prompt, workspace, kind, model?)`.
Each method calls the matching MCP tool and parses its JSON text content into a typed object.

### 4. Connection resolution

- Explicit `--connect <url>` CLI flag wins.
- Otherwise derived from the loaded config: `transport === 'sse'` → `http://localhost:<port>/sse`.
- If config's transport is `stdio`, print a clear error explaining a shared SSE server is
  required and exit (see "always require shared server" below) rather than silently falling back
  to anything.

### 5. `App.tsx` rewrite

- Drops the local `SessionManager` entirely.
- Polls `listSessions()` on an interval (~1.5s) to refresh the session list/statuses, diffing by
  `sessionId` against local React state so scroll position/selection survive each refresh.
- For whichever session is currently selected/viewed, additionally polls `getSessionLogs()` more
  often (~750ms), tracking an `offset` cursor client-side so each poll only fetches new events.

### 6. Launcher / send / cancel handlers

`handleLaunch`, `handleSendInput`, and the cancel action become `async` calls into the remote
client instead of direct synchronous `SessionManager` method calls. Errors are caught and surfaced
via the existing `statusMessage` banner — no new UI needed.

### 7. Startup preflight

Before rendering, `startDashboard()` makes one `listSessions()` call against the resolved server
URL. On failure (connection refused/timeout), it prints how to start the server
(`agent-rack start --transport sse --port <p>`) and exits non-zero instead of rendering a broken
UI.

### Cleanup: `src/cli/dashboard/launch.ts` becomes dead code

Once the Launcher calls the remote `agent_session_create` tool instead of a local
`SessionManager`, model resolution (`resolveModel`/`applyModelOverride`) already happens
server-side inside that tool's handler — the same code path Claude Code/Codex already use.
`computeLaunchAgentConfig` in `src/cli/dashboard/launch.ts` (and its test) is deleted rather than
left as unused code.

## Data flow

- **Startup**: `agent-rack start -t sse -p <port>` boots once. Claude Code/Codex/dashboard configs
  all point at the same `http://localhost:<port>/sse`.
- **Launching**: any client (Claude Code, Codex, or the dashboard's own Launcher) is just calling
  `agent_session_create`/`agent_run`/`agent_review` against the shared server. Only the server
  ever spawns an `AgentProcessController` — the dashboard no longer spawns anything itself.
- **Observing**: the dashboard's polling loop is the only thing driving its own UI; nothing is
  pushed to it.
- **Sending input / cancelling**: goes straight to the server; the next poll picks up the
  resulting state change. This introduces an inherent lag of up to one poll interval, versus
  today's instant in-process update — an accepted, explicit trade-off.

## Error handling

- **Dashboard can't reach the server at startup**: preflight check fails, clear message, exit.
- **Server becomes unreachable mid-session**: a failed poll doesn't crash the UI — shows a
  "connection lost, retrying…" status and keeps polling; recovers automatically once the server
  is back.
- **`create`/`send`/`cancel` calls fail**: caught, surfaced via the existing `statusMessage`
  pattern.
- **Server restart loses all sessions**: unchanged limitation from today, just now shared instead
  of scattered per-client — nothing is persisted to disk. Out of scope; a separate feature if
  ever wanted.
- **Client disconnects mid-task**: doesn't kill the task. `SessionManager.createSession` already
  runs the agent process as a detached background promise independent of the calling connection.
- **Multiple dashboards open at once**: just works — independent clients of the same server
  state, no conflicts.
- **No new auth**: SSE endpoint stays plain localhost HTTP, unchanged from today. Only relevant if
  ever bound beyond localhost, which is out of scope here.

## Testing

- `SessionManager.listSessions()` — unit test (empty; sorted by `createdAt` desc).
- `agent_session_list` tool — unit test with a couple of fake sessions.
- Multi-client SSE fix — integration test: real server on an ephemeral port, two separate
  `Client`+`SSEClientTransport` instances connected concurrently, both independently call a tool
  successfully without clobbering each other.
- Dashboard `remoteClient` — tested against a real running server on an ephemeral port (not a
  mocked SDK client), matching this repo's existing preference for real subprocesses over mocks
  (`review.test.ts`, `engine.test.ts`).
- Connection-resolution logic — pure function, unit tested directly (flag wins; sse-config
  derives URL; stdio-config signals the "server required" error).
- Ink UI itself — no render/interaction tests (no ink-testing-library in this project); covered by
  typecheck plus a manual pty-based smoke test (happy path + server-down path), same technique
  used for the earlier TTY-guard and version fixes.

## Explicit non-goals

- Session persistence across a server restart.
- Any new authentication/authorization on the SSE endpoint.
- A fallback standalone/local dashboard mode.
