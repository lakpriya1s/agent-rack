<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/agent-rack-logo-horizontal-dark.svg">
  <img src="./assets/agent-rack-logo-horizontal.svg" alt="agent-rack" width="480">
</picture>

**Bridge any CLI coding agent into any MCP client**<br>
Ships with Claude Code, Codex, opencode, and Antigravity built in.

[![npm](https://img.shields.io/npm/v/agent-rack?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/agent-rack)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933.svg?logo=node.js&logoColor=white)](package.json)

</div>

---

`agent-rack` wraps command-line AI coding agents behind a single [Model Context
Protocol](https://modelcontextprotocol.io) server. It ships with four agents built in —
`claude`, `codex`, `opencode`, and Antigravity (`agy`) — but isn't limited to them: any other
local CLI coding agent can be wired in with a small adapter (see
[Connecting your own CLI agent](#connecting-your-own-cli-agent)). Point any MCP client at it, and it spawns sub-agents
synchronously for one-shot tasks, or as background sessions with log streaming, follow-up
input, and cancellation.

It also ships a structured, adversarial-capable **code review** tool
(`agent_review`) that runs read-only and returns validated JSON instead of free text.

---

## Install

**Using Claude Code?** Skip the steps below entirely and install the
[Claude Code plugin](plugins/agent-rack/README.md) instead — it registers the MCP server
automatically and adds slash commands (`/agent-rack:run`, `/agent-rack:review`, …) for every tool:

```
/plugin marketplace add lakpriya1s/agent-rack
/plugin install agent-rack@agent-rack
/reload-plugins
```

For every other MCP client, no cloning, no config file to write by hand — just register it:

```sh
npx agent-rack install --target claude     # Claude Code CLI
npx agent-rack install --target desktop    # Claude Desktop
npx agent-rack snippet cursor              # print a snippet to paste anywhere else
```

Then restart your MCP client to pick up the new tools. That's it — with no config file present,
agents are automatically scoped to whichever directory your MCP client launches the server
from (almost always your project root). See [Configuration](#configuration) below only if you
need to customize that.

Prefer a global install so the `agent-rack` command is always on hand?

```sh
npm install -g agent-rack
agent-rack install --target claude
```

> `--target desktop` writes to macOS's Claude Desktop config path
> (`~/Library/Application Support/Claude/claude_desktop_config.json`). On other platforms, run
> `agent-rack snippet claude-desktop` and paste the printed JSON into your config by hand.

## Requirements

- **Node.js 20+**
- Whichever underlying CLI(s) you intend to run must be on `$PATH`: `claude`, `codex`,
  `opencode`, and/or `agy`. Check with `npx agent-rack agents`.

## Configuration

**Most people don't need this section.** With no config file present, `agent-rack`
defaults to `allowedWorkspaces: [<the directory the server started in>]` and wires up all four
agents automatically — nothing to write or edit.

Reach for a config file only if you want to:
- allow agents into more than one directory,
- change the timeout, concurrency limit, or transport (`stdio` vs `sse`),
- customize an agent's CLI flags, or point at a different binary.

Config is resolved in this order (`src/config/loader.ts`):

1. `$AGENT_RACK_CONFIG` env var
2. `./agent-rack.config.json`
3. `~/.config/agent-rack/config.json`
4. The zero-config default described above

To customize it, generate a real config scoped to your current directory (no placeholder paths
to edit):

```sh
npx agent-rack config init
```

Or start from the fully-commented template if you want to see every option, including agent
definitions:

```sh
cp agent-rack.config.example.json agent-rack.config.json
```

| Key | Description |
| --- | --- |
| `transport` | `stdio` (default, for local IDE integration) or `sse` (HTTP-SSE, for remote/mobile access) |
| `port` | HTTP port when `transport` is `sse` |
| `allowedWorkspaces` | Absolute directory paths agents are permitted to touch. Every tool call is validated against this list before any subprocess spawns — this is the entire security boundary. |
| `agents` | Map of agent id → `{ name, command, args, transport, env, description }` |
| `security.sanitizeEnv` | Strip env vars matching secret/password/token patterns before spawning agents (default `true`) |
| `security.maxConcurrentSessions` | Cap on simultaneously running background sessions (default `5`) |
| `security.defaultTimeoutSeconds` | Default execution timeout per run, in seconds (default `600`) |

## CLI commands

Running `agent-rack` with no subcommand at all is shorthand for `agent-rack start`.

### `start`

```sh
agent-rack start [-c, --config <path>] [-t, --transport stdio|sse] [-p, --port <number>]
```

Starts the MCP server. `--transport` defaults to `stdio` (or `config.transport`); `--port`
defaults to `8765` (or `config.port`) and only applies to `sse`. This is what your MCP client
actually runs in the background — you won't normally invoke it by hand.

### `install`

```sh
agent-rack install --target claude|desktop   # default: claude
```

- `--target claude` — runs `claude mcp add agent-rack -- node <resolved-bin-path> start`,
  registering the server with the Claude Code CLI.
- `--target desktop` — merges an `mcpServers.agent-rack` entry into your Claude Desktop
  config.

```
Registering agent-rack with Claude Code CLI...
✓ Successfully added agent-rack to Claude Code CLI!
```

### `uninstall`

```sh
agent-rack uninstall --target claude|desktop   # default: claude
```

The inverse of `install`: `--target claude` runs `claude mcp remove agent-rack`;
`--target desktop` backs up `claude_desktop_config.json` to a `.bak` file alongside it, then
removes the `agent-rack` entry. Safe to run even if it was never installed — it reports
"nothing to remove" instead of failing. See [Uninstall](#uninstall) below.

### `config init`

```sh
agent-rack config init [-p, --path ./agent-rack.config.json]
```

Writes a real config scoped to your current directory — all four default agents pre-filled
with their actual CLI flags, `allowedWorkspaces` set to `process.cwd()` (not a placeholder).
Only needed if you're customizing something (see [Configuration](#configuration)).

### `config-check`

```sh
agent-rack config-check [-c, --config <path>]
```

Resolves config through the same precedence order the server uses, and prints it — or exits
non-zero with the validation error if something's wrong.

```
✓ Configuration valid! Loaded from: /Users/you/project/agent-rack.config.json
{
  "transport": "stdio",
  "allowedWorkspaces": ["/Users/you/project"],
  ...
}
```

### `agents`

```sh
agent-rack agents [-c, --config <path>]
```

Lists every configured agent and probes `$PATH` to confirm its binary is actually reachable.

```
Registered Agents Status:

 ✓ [claude] Claude Code CLI (claude) -> AVAILABLE
   Transport: claude_stream_json
   Args: --dangerously-skip-permissions --output-format json

 ✗ [codex] Codex CLI (codex) -> MISSING BINARY
   Transport: codex_exec_json
   Args: exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
```

### `snippet`

```sh
agent-rack snippet <client>
```

Prints the `mcpServers` JSON block to paste into any MCP client's config by hand — for clients
`install` doesn't automate (Cursor, VS Code, Antigravity). `<client>` is just a label in the
printed message; the JSON itself is identical for every client.

## MCP tools

Two execution models, pick based on how long the task runs and whether you need to watch it:

- **Synchronous — `agent_run`** blocks until the sub-agent finishes and hands back its output
  directly. Simplest option for one-shot tasks.
- **Asynchronous — `agent_session_*`** starts a sub-agent in the background and returns a
  `sessionId` immediately. Poll `agent_session_status`, stream `agent_session_logs`, push
  follow-up input with `agent_session_send`, or stop it early with `agent_session_cancel`. Use
  this for anything long-running or that you want to monitor or steer mid-flight.

Every configured agent also gets a shorthand tool — `claude_run`, `codex_run`, `agy_run`,
`opencode_run` — identical to `agent_run` but with `agent` pre-filled.

### `agent_list_available`

No parameters. Lists every configured agent and whether its binary is on `$PATH`.

```json
[
  {
    "agentId": "claude",
    "name": "Claude Code CLI",
    "command": "claude",
    "transport": "claude_stream_json",
    "description": "Claude Code CLI streaming JSON agent",
    "status": "available"
  },
  { "agentId": "codex", "...": "...", "status": "missing_binary" }
]
```

### `agent_run`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `agent` | string | yes | — | Agent id (`claude`, `codex`, `opencode`, `agy`, or a custom one you've configured) |
| `prompt` | string | yes | — | Instruction for the sub-agent |
| `workspace` | string | no | first `allowedWorkspaces` entry | Directory the agent runs in (must be within `allowedWorkspaces`) |
| `timeoutSeconds` | number | no | `security.defaultTimeoutSeconds` (`600`) | Max execution time |
| `mode` | string | no | — | Execution mode forwarded to the agent (e.g. `plan`, `acceptEdits`, `auto` for claude) |

Returns the agent's response as plain text, with a `### Tool Calls Executed` manifest appended
if the agent used any tools while running.

### `agent_session_create`

Same parameters as `agent_run` (`agent`, `prompt` required; `workspace`, `mode` optional).
Returns session info immediately instead of blocking:

```json
{
  "sessionId": "3f9c2b7a-1e4d-4a2b-9c3e-8f7a6b5c4d3e",
  "agentId": "codex",
  "agentName": "Codex CLI",
  "status": "running",
  "createdAt": "2026-08-01T12:00:00.000Z",
  "workspace": "/Users/you/project",
  "eventCount": 0
}
```

### `agent_session_status`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | yes | Session to query |

Returns the same shape as `agent_session_create`, updated with current `status`
(`running` \| `idle` \| `completed` \| `failed` \| `cancelled`), `summary` once available, and
`review` if this was an `agent_review` background session.

### `agent_session_send`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | yes | Target session (must still be `running`) |
| `message` | string | yes | Text written to the sub-agent's stdin |

### `agent_session_logs`

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `sessionId` | string | yes | — | Session to read events from |
| `offset` | number | no | `0` | Skip this many events from the start |
| `limit` | number | no | all remaining | Max events to return |

Returns the raw `ParsedAgentEvent[]` stream (`text`, `tool_call`, `tool_result`, `thought`,
`status`, or `error` events), each with a timestamp — useful for tailing a long-running session.

### `agent_session_cancel`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | yes | Session to stop |

Sends `SIGINT`, then `SIGKILL` after a 3-second grace period if the process hasn't exited.

### Shortcut tools

`claude_run`, `codex_run`, `opencode_run`, `agy_run` — same as `agent_run` minus the `agent`
field, since it's already fixed:

```json
// codex_run → { "prompt": "Add input validation to the signup form", "workspace": "/Users/you/project" }
```

## Structured code review (`agent_review`)

`agent_review` runs a read-only code review over your working tree or a branch diff, using any
configured agent, and returns a **validated JSON object** instead of free text. The agent
inspects the diff itself (`git status` / `git diff` inside the workspace), so large diffs never
have to be stuffed into the prompt.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `agent` | string | — (required) | Agent to review with (`claude`, `codex`, `opencode`, `agy`, …). |
| `workspace` | string | first allowed workspace | Directory to review. |
| `scope` | `working-tree` \| `branch` | `working-tree` | Review uncommitted changes, or a branch diff against `baseRef`. |
| `baseRef` | string | — | Base ref to diff against; required when `scope` is `branch`. |
| `adversarial` | boolean | `false` | Skeptical, ship/no-ship stance that actively tries to break confidence in the change. |
| `focus` | string | — | Steering text for the adversarial review. |
| `background` | boolean | `false` | Run as a background session; poll `agent_session_status` for the parsed result. |
| `timeoutSeconds` | number | `600` | Maximum execution time. |

```json
{
  "verdict": "approve | needs-attention",
  "summary": "…",
  "findings": [
    {
      "severity": "critical | high | medium | low",
      "title": "…",
      "body": "…",
      "file": "src/example.ts",
      "line_start": 10,
      "line_end": 12,
      "confidence": 0.8,
      "recommendation": "…"
    }
  ],
  "next_steps": ["…"]
}
```

- `line_start`/`line_end` may be `0` for whole-file, deleted-file, or architectural findings.
- If the agent's output can't be validated against the schema, the tool returns the same shape
  with `parseError: true` and the raw text in `raw`, rather than failing.
- If there is nothing to review, it short-circuits with `verdict: "approve"` and
  `"Nothing to review."` without spawning the agent.
- Read-only is enforced natively where the transport supports it (`--sandbox read-only` for
  codex, `--permission-mode plan` for claude, with the agent's configured escape-hatch flags
  stripped for the run) and always reinforced by an explicit instruction in the prompt.

## How it works

Claude Code, Cursor, and other MCP clients speak a common protocol for tool discovery and
invocation. `agent-rack` implements that protocol server-side and translates each tool call
into a real CLI subprocess:

1. **Adapters** (`src/adapters/`) normalize each agent's transport into one interface — JSON
   event streams for `claude` and `codex`, Antigravity's own stream format for `agy`, and a
   real pseudo-terminal (via `node-pty`) for `opencode`, which only works interactively.
2. **Engine** (`src/engine/`) spawns the subprocess, enforces the workspace sandbox and
   timeout, and — for `agent_session_*` — tracks background lifecycle so you can poll status,
   stream logs, send follow-up input, or cancel.
3. **Tools** (`src/tools/`) expose all of the above as MCP tool definitions with JSON-schema
   inputs, registered onto the MCP `Server` in `src/server.ts`.

Every tool call resolves `workspace` against `allowedWorkspaces` (with symlink/realpath
resolution to block traversal) before anything spawns, and strips sensitive-looking env vars
(`SECRET`, `PASSWORD`, `AUTH_TOKEN`, `PRIVATE_KEY` patterns) from the child's environment by
default.

## Troubleshooting

**`command not found: agent-rack`** — if you installed globally, confirm npm's global bin
directory is on `$PATH` (`npm config get prefix`, then check `<prefix>/bin` is in `$PATH`), or
just use `npx agent-rack <command>` instead — it never needs a global install.

**Agent binary missing** — `agent-rack agents` prints `MISSING BINARY` next to any agent id
whose `command` isn't installed. Install that CLI (`claude`, `codex`, `opencode`, `agy`), or
point `agents.<id>.command` in your config at wherever it actually lives.

**Tools don't show up in my client** — most MCP clients fetch the tool list once, at session
start. Restart the client (or reconnect the MCP server) after running `install`.

**`SecurityError: Workspace path ... is not within allowedWorkspaces`** — the directory a tool
call targets isn't in your resolved `allowedWorkspaces`. Run `agent-rack config-check` to
see what's actually resolved, and `agent-rack config init` from the directory you want
allowed.

**`node-pty` fails to build during install** — it ships prebuilt binaries for common platforms;
if none match yours, npm falls back to compiling from source, which needs a working C++
toolchain (Xcode Command Line Tools on macOS, `build-essential` on Debian/Ubuntu). Confirm
you're on Node 20+ first.

## Uninstall

```sh
agent-rack uninstall --target claude|desktop   # default: claude
```

- `--target claude` — runs `claude mcp remove agent-rack`.
- `--target desktop` — backs up `claude_desktop_config.json` to a `.bak` file alongside it, then
  removes the `agent-rack` entry.

Safe to run even if it was never registered — it reports "nothing to remove" rather than
failing. This only unregisters the MCP server; it doesn't uninstall the npm package itself
(`npm uninstall -g agent-rack` if you installed it globally).

## Connecting your own CLI agent

There are two ways to wire in a CLI agent that isn't one of the four built-ins, depending on
how it behaves.

### Option A — config only, no code changes

If your CLI is any ordinary **interactive terminal program** (it prompts, prints, maybe asks
for confirmation) — not necessarily one that emits structured JSON — you can drive it as-is
using the built-in `pty_interactive` transport, the same one `opencode` uses. It runs your CLI
in a real pseudo-terminal, strips ANSI escape codes, and treats each line of output as plain
text. Add an entry to your config's `agents` map (see [Configuration](#configuration)) —
no source changes, no rebuild:

```json
{
  "agents": {
    "my-agent": {
      "name": "My Custom Agent",
      "command": "my-agent-cli",
      "args": ["--non-interactive"],
      "transport": "pty_interactive",
      "env": {},
      "description": "My custom CLI coding agent"
    }
  }
}
```

It's immediately usable as `agent_run` with `agent: "my-agent"`, and gets its own shorthand
tool, `my-agent_run`. The tradeoff: everything the CLI prints comes back as plain `text` events
— no structured `tool_call`/`tool_result` breakdown, since the adapter doesn't know your CLI's
output format.

### Option B — a real adapter, for structured output

If your CLI emits a JSON event stream (or another parseable structured format) and you want
`agent_run`'s output broken into proper `tool_call`/`tool_result` events (like `claude` and
`codex` get), you implement the `AgentAdapter` interface (`src/adapters/base.ts`):

```typescript
export interface AgentAdapter {
  readonly transportType: string;
  getCLIArgs(prompt: string, mode?: string): string[];
  parseChunk(chunk: string): ParsedAgentEvent[];
  formatResponse(events: ParsedAgentEvent[], exitCode?: number): FormattedResult;
}
```

- `getCLIArgs` builds the argv for a single run, given the prompt and an optional mode.
- `parseChunk` is called on every stdout/stderr chunk as it streams in; return zero or more
  `ParsedAgentEvent`s (`type: 'text' | 'tool_call' | 'tool_result' | 'thought' | 'status' | 'error'`).
- `formatResponse` runs once the process exits, reducing all accumulated events into a
  `FormattedResult` (`summary`, `rawText`, `toolCalls`, `events`, `exitCode`).

`src/adapters/agy.ts` is the shortest real example to copy from. Since transports are compiled
in rather than dynamically loaded, this path requires a local clone (there's no runtime plugin
API yet):

1. Add a case to `AgentTransportTypeSchema` in `src/config/schema.ts`.
2. Implement `AgentAdapter` in `src/adapters/`.
3. Wire it into `createAdapter` in `src/adapters/index.ts`.
4. If the CLI has a permission-skip / sandbox-bypass flag, add it to `ESCAPE_HATCH_ARGS` and
   `getReadOnlyMode` in `src/engine/review.ts` so `agent_review` can strip it and enforce
   read-only reviews natively.
5. Add a default entry in `getDefaultConfig` (`src/config/loader.ts`) and
   `agent-rack.config.example.json`, or just add one to your own config's `agents` map.
6. `pnpm build` and run from your local checkout, or open a PR to get it merged upstream.

## Documentation index

| Document | Description |
| --- | --- |
| 📋 [Product Requirements (PRD)](docs/PRD.md) | Problem statement, goals/non-goals, architecture overview, MCP tool specifications, safety model, and roadmap. |
| 📖 [User Stories & Epics](docs/USER_STORIES.md) | Detailed user stories, acceptance criteria, epic organization, and prioritization matrix. |
| 🗺️ [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) | Step-by-step technical implementation roadmap divided into 6 distinct phases. |
| 🎨 [Draw.io Diagram](docs/diagrams/architecture.drawio) | Edit-ready Draw.io XML diagram showing system layers, MCP routers, session managers, adapters, and target CLIs. |
| 🧪 [`agent_review` Design Spec](docs/specs/2026-08-01-agent-review-design.md) | Design decisions behind the structured review tool: JSON contract, read-only enforcement, adversarial stance. |
| 🔧 [`agent_review` Implementation Plan](docs/plans/2026-08-01-agent-review-implementation.md) | Task-by-task build plan and test fixtures for `agent_review`. |

## Contributing

```sh
git clone https://github.com/lakpriya1s/agent-rack.git
cd agent-rack
pnpm install && pnpm build
pnpm test && pnpm typecheck
```

See [`CLAUDE.md`](./CLAUDE.md) for the architecture. Issues and PRs welcome.

## License

[MIT](./LICENSE) © Lakpriya Senevirathna
