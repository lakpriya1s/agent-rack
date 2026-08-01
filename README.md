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
(`agent_review`) that runs read-only and returns validated JSON instead of free text, plus
[9 packaged commands and 2 auto-activated guidance skills](#skills) for Claude Code, Cursor, and
Antigravity.

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

For every other MCP client, no cloning, no config file to write by hand — just register it.
Not sure which targets apply to you? Run the interactive wizard instead — it detects what's
actually installed (including project-local `.claude`/`.cursor` folders, offering
project-vs-global registration for those two) and asks before registering with each:

```sh
npx agent-rack setup
```

Or register with a specific target directly:

```sh
npx agent-rack install --target claude       # Claude Code CLI
npx agent-rack install --target codex        # Codex CLI
npx agent-rack install --target desktop      # Claude Desktop
npx agent-rack install --target cursor       # Cursor
npx agent-rack install --target antigravity  # Antigravity
npx agent-rack install --target opencode     # OpenCode
npx agent-rack snippet vscode                # print a snippet to paste anywhere else
```

### Copying skills to any project or agent

You can also copy agent-rack's skill set directly to any project or agent skills directory using `agent-rack cp` (or `agent-rack copy-skills`):

```sh
agent-rack cp                                # auto-detects client folders in current directory and copies skills
agent-rack cp --target cursor                # copies skills to .cursor/skills in current project
agent-rack cp --target antigravity           # copies skills to .gemini/skills in current project
agent-rack cp --target claude --scope user   # copies skills to ~/.claude/skills (global)
agent-rack cp ./my-project                   # copies skills to ./my-project
agent-rack cp ./my-project --target codex    # copies skills to ./my-project/.agents/skills
```

`claude` and `cursor` also accept `--scope project` to register only for the current project
(a git-shareable `.mcp.json`/`.cursor/mcp.json` in the project root) instead of globally for
every project — see [`install`](#install) below for details.

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

## Skills

Everything above is reachable as raw MCP tool calls from any client. If you're on Claude Code,
Cursor, or Antigravity specifically, agent-rack also ships **skills** — packaged, documented
entry points on top of those same tools, so you don't have to remember exact parameter names.

### Claude Code plugin — 9 commands

Installed via the [Claude Code plugin](plugins/agent-rack/README.md)
(`/plugin install agent-rack@agent-rack`). Each command is a thin wrapper around exactly one MCP
tool — see [plugins/agent-rack/README.md](plugins/agent-rack/README.md) for full parameter docs
and examples.

| Command | Wraps | What it does |
| --- | --- | --- |
| `/agent-rack:run` | `agent_run` | Run a one-shot task synchronously with a named sub-agent |
| `/agent-rack:review` | `agent_review` | Structured, read-only code review (normal or adversarial) |
| `/agent-rack:session-start` | `agent_session_create` | Start a background sub-agent session |
| `/agent-rack:session-status` | `agent_session_status` | Check a background session's status/summary |
| `/agent-rack:session-send` | `agent_session_send` | Send follow-up input to a running session |
| `/agent-rack:session-logs` | `agent_session_logs` | Read a session's raw event stream |
| `/agent-rack:session-cancel` | `agent_session_cancel` | Stop a running session |
| `/agent-rack:agents` | `agent_list_available` | List configured agents and `$PATH` availability |
| `/agent-rack:setup` | — | Verify the MCP server is actually connected; troubleshoot if not |

### Guidance skills — 2, auto-activated

These aren't slash commands — they're model-invoked (`user-invocable: false`), meaning Claude
reads them automatically based on context rather than you typing anything:

| Skill | Activates when | What it teaches |
| --- | --- | --- |
| `agent-rack-tool-selection` | Delegating any task to a sub-agent through agent-rack | When to use synchronous `agent_run` vs. background `agent_session_create`; prefer the `<agentId>_run` shortcuts when the agent is already fixed |
| `agent-rack-review-handling` | An `agent_review` call returns | How to present findings (severity order, `parseError` handling) and — critically — never auto-fix findings without asking first |

Unlike the 9 commands (Claude Code plugin only), these two guidance skills also get **copied
into other tools' own skill directories** when you register with them:

| Target | Skills copied to |
| --- | --- |
| `agent-rack install --target cursor` | `~/.cursor/skills/agent-rack-{tool-selection,review-handling}/` (or `<project>/.cursor/skills/` with `--scope project`) |
| `agent-rack install --target antigravity` | `~/.gemini/config/skills/agent-rack-{tool-selection,review-handling}/` |

So a Cursor or Antigravity user gets the same "don't auto-fix review findings" guidance a Claude
Code plugin user gets — just delivered as a plain copied skill file instead of a bundled plugin,
since neither tool has a marketplace-style plugin format agent-rack can install through.

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

### `setup`

```sh
agent-rack setup
```

Interactive wizard. First prints anything it detects in the **current project** — a `.claude`,
`.cursor`, `.gemini`, `.agents`, or `.opencode` folder, mirroring what each of those tools itself
looks for. Then, for each supported target, checks whether it's actually present (binary on
`$PATH` for `claude`/`codex`/`opencode`, config directory existing for `desktop`/`cursor`/
`antigravity`) and asks (y/n, default yes) before registering. For `claude` and `cursor`
specifically — the two with a verified project-vs-global distinction — it asks a follow-up
"just for this project?", defaulting to yes if that tool's project folder was detected, no
otherwise. Everything else registers globally only. Clients it doesn't detect (VS Code, GitHub
Copilot, etc.) get a pointer to `agent-rack snippet <client>` at the end.

```
Detected in this project (/Users/you/project):
  Claude Code CLI  .claude
  Cursor           .cursor

Let's set up agent-rack.

Register with Claude Code CLI? [Y/n] y
  Just for this project (not globally)? [Y/n] y
Registering agent-rack with Claude Code CLI (scope: project)...
✓ Successfully added agent-rack to Claude Code CLI!
Register with Codex CLI? [Y/n] y
Registering agent-rack with Codex CLI...
✓ Successfully added agent-rack to Codex CLI!
- Claude Desktop not found, skipping.

Done. Restart the client(s) above to pick up the new tools.
```

Needs a real interactive terminal (it asks yes/no questions on stdin) — over some SSH sessions,
certain IDE-embedded terminals, or when output is piped/redirected, stdin isn't a TTY and this
command exits with an error pointing you at the explicit `install --target` commands instead of
silently doing nothing.

### `install`

```sh
agent-rack install --target <target> [--scope project|user]   # default target: claude
```

| Target | What happens |
| --- | --- |
| `claude` | `claude mcp add agent-rack -- node <resolved-bin-path> start`. `--scope` maps directly to Claude Code's own `-s local\|user\|project` flag; omitted, it uses Claude Code's own default (`local` — tied to this exact directory, not shared). `project` writes a git-shareable `.mcp.json` in the project root; `user` is available in every project. |
| `codex` | `codex mcp add agent-rack -- node <resolved-bin-path> start` (global only — codex has no project-scope flag). |
| `desktop` | Merges an `mcpServers.agent-rack` entry into Claude Desktop's config (macOS only). |
| `cursor` | Merges an `mcpServers.agent-rack` entry into Cursor's `mcp.json`, plus copies agent-rack's two guidance skills into Cursor's `skills/` directory. `--scope user` (default) writes to `~/.cursor/`; `--scope project` writes to `<project>/.cursor/` instead. |
| `antigravity` (alias `agy`) | Merges an `mcpServers.agent-rack` entry into `~/.gemini/config/mcp_config.json` (Antigravity shares Gemini's config namespace) and copies the same two guidance skills into `~/.gemini/config/skills/`. Global only. |
| `opencode` | Merges an `mcp.agent-rack` entry into opencode's config (`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`) — note this target uses a different config shape (`{ type: "local", command: [...] }`) than the others. Global only. |
| anything else | Prints a pointer to `agent-rack snippet <target>` instead of silently doing nothing. |

```
Registering agent-rack with Claude Code CLI...
✓ Successfully added agent-rack to Claude Code CLI!
```

### `uninstall`

```sh
agent-rack uninstall --target <target> [--scope project|user]   # default target: claude
```

The inverse of `install`, target-for-target, with the same `--scope` semantics for `claude`/
`cursor`. `desktop`/`cursor`/`antigravity`/`opencode` all back up their config file to a `.bak`
alongside it before removing the `agent-rack` entry. Safe to run even if it was never
installed — it reports "nothing to remove"/"no automatic removal" instead of failing. See
[Uninstall](#uninstall) below.

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
`install` doesn't automate (VS Code, GitHub Copilot, and anything else not listed in
[`install`](#install)). `<client>` is just a label in the printed message; the JSON itself is
identical for every client.

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
agent-rack uninstall --target <target> [--scope project|user]   # default target: claude
```

- `--target claude` — runs `claude mcp remove agent-rack` (add `--scope` to match how it was
  installed).
- `--target codex` — runs `codex mcp remove agent-rack`.
- `--target desktop|cursor|antigravity|opencode` — backs up that client's config file to a
  `.bak` file alongside it, then removes the `agent-rack` entry (`--scope project` for `cursor`
  if it was registered per-project).

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
