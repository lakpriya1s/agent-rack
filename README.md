# Agent-MCP

> Model Context Protocol (MCP) Server for running `agy`, `claude`, `opencode`, `codex`, and any CLI AI coding agent as MCP tools.

`agent-mcp` bridges command-line AI coding tools with any MCP-compliant client (Antigravity IDE, Claude Desktop, Cursor, VS Code, or custom multi-agent orchestrators).

---

## 🚀 Getting Started

```bash
pnpm install
pnpm build          # compiles src/ -> dist/ (bin/agent-mcp.js runs the compiled output)
```

Create your local config from the checked-in template, then point `allowedWorkspaces` at the
directories agents are permitted to touch:

```bash
cp agent-mcp.config.example.json agent-mcp.config.json
```

`agent-mcp.config.json` is gitignored — it holds machine-specific absolute paths. Config is
resolved in this order (`src/config/loader.ts`): `$AGENT_MCP_CONFIG`, then
`./agent-mcp.config.json`, then `~/.config/agent-mcp/config.json`, then a built-in default
scoped to the current directory.

Register the server with a client:

```bash
node bin/agent-mcp.js install --target claude     # Claude Code CLI
node bin/agent-mcp.js install --target desktop    # Claude Desktop
node bin/agent-mcp.js snippet cursor              # print a snippet to paste anywhere else
```

### CLI Commands

| Command | Description |
| --- | --- |
| `start` | Run the MCP server. `--transport stdio\|sse`, `--port`, `--config`. |
| `install` | Register with Claude Code CLI (`--target claude`) or Claude Desktop (`--target desktop`). |
| `config init` | Write a starter `agent-mcp.config.json`. |
| `config-check` | Validate the resolved config and print it. |
| `agents` | List configured agents and check each binary against `$PATH`. |
| `snippet <client>` | Print an `mcpServers` JSON block for a given MCP client. |

### Development

```bash
pnpm test          # vitest, src/**/*.test.ts only
pnpm typecheck     # typechecks sources AND tests (tests are excluded from the build)
pnpm dev           # tsx watch
```

---

## 📚 Documentation Index

The following documentation sets out the vision, design, requirements, user stories, and architecture of `agent-mcp`:

| Document | Description |
| --- | --- |
| 📋 [Product Requirements (PRD)](docs/PRD.md) | Problem statement, goals/non-goals, architecture overview, MCP tool specifications, safety model, and roadmap. |
| 📖 [User Stories & Epics](docs/USER_STORIES.md) | Detailed user stories, acceptance criteria, epic organization, and prioritization matrix. |
| 🗺️ [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) | Step-by-step technical implementation roadmap divided into 6 distinct phases. |
| 🎨 [Draw.io Diagram](docs/diagrams/architecture.drawio) | Edit-ready Draw.io XML diagram showing system layers, MCP routers, session managers, adapters, and target CLIs. |
| 🧪 [`agent_review` Design Spec](docs/superpowers/specs/2026-08-01-agent-review-design.md) | Design decisions behind the structured review tool: JSON contract, read-only enforcement, adversarial stance. |
| 🔧 [`agent_review` Implementation Plan](docs/superpowers/plans/2026-08-01-agent-review-implementation.md) | Task-by-task build plan and test fixtures for `agent_review`. |

---

## 🛠️ Key Architectural Highlights

1. **Universal Adapter Layer**: JSON-stream framing (`claude`, `codex`, `agy`) and a PTY terminal fallback (`opencode`) behind one `AgentAdapter` interface.
2. **Dual Transport Modes**: Supports `stdio` (for local MCP IDE integration) and `HTTP-SSE` (for remote network access & mobile tethering).
3. **Dual Execution Models**:
   - **Synchronous (`agent_run`)**: Blocks until task completion, returning the agent's summary plus a manifest of the tool calls it made.
   - **Asynchronous (`agent_session_*`)**: Runs sub-agents in background tasks with progress tracking, stdout log streaming, follow-up prompts, and cancellation.
4. **Workspace Security**: Strict path allowlist validation (`allowedWorkspaces`) and credential sanitization.

---

## 🧰 MCP Tools

| Tool | Description |
| --- | --- |
| `agent_list_available` | List configured agents and whether each binary is on `$PATH`. |
| `agent_run` | Run a task synchronously and return the agent's summary. |
| `agent_review` | Read-only structured code review returning validated JSON — see below. |
| `agent_session_create` | Start a background session, returns a `sessionId`. |
| `agent_session_status` | Status and summary for a session (plus `review` for review sessions). |
| `agent_session_send` | Send follow-up input to a running session. |
| `agent_session_logs` | Paginated stdout/stderr events for a session. |
| `agent_session_cancel` | Terminate a running session. |

Every configured agent also gets a shorthand tool — `claude_run`, `codex_run`, `agy_run`,
`opencode_run` — which forwards to `agent_run` with `agent` pre-filled.

---

## 🔍 Structured Code Review (`agent_review`)

`agent_review` runs a read-only code review over your working tree or a branch diff, using any configured agent, and returns a **validated JSON object** instead of free text.

The agent inspects the diff itself (it runs `git status` / `git diff` in the workspace), so large diffs never have to be stuffed into the prompt.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `agent` | string | — (required) | ID of the agent to review with (`claude`, `codex`, `opencode`, `agy`, …). |
| `workspace` | string | first allowed workspace | Directory to review (must be within `allowedWorkspaces`). |
| `scope` | `working-tree` \| `branch` | `working-tree` | Review uncommitted changes, or the branch diff against `baseRef`. |
| `baseRef` | string | — | Base ref to diff against. Required when `scope` is `branch`. |
| `adversarial` | boolean | `false` | Switches to a skeptical, ship/no-ship stance that actively tries to break confidence in the change. |
| `focus` | string | — | Steering text for the adversarial review (e.g. `"challenge the retry logic"`). |
| `background` | boolean | `false` | Run as a background session; poll `agent_session_status` for the parsed result. |
| `timeoutSeconds` | number | `600` | Maximum execution time. |

**Returns** a JSON payload:

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

Notes:

- `line_start`/`line_end` may be `0` for whole-file, deleted-file, or architectural findings.
- If the agent's output can't be validated against the schema, the tool returns the same shape with `parseError: true` and the raw text in `raw`, rather than failing.
- If there is nothing to review, it short-circuits with `verdict: "approve"` and `"Nothing to review."` without spawning the agent.
- With `background: true` the tool returns session info immediately; the parsed review appears on `agent_session_status` as the `review` field once the session completes.
- Read-only is enforced natively where the transport supports it (`--sandbox read-only` for codex, `--permission-mode plan` for claude, with the agent's configured `--dangerously-*` escape-hatch flags stripped for the run) and always reinforced by an explicit instruction in the prompt.
