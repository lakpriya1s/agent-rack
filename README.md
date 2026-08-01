# Agent-MCP

> Model Context Protocol (MCP) Server for running `agy`, `claude`, `opencode`, `codex`, and any CLI AI coding agent as MCP tools.

`agent-mcp` bridges command-line AI coding tools with any MCP-compliant client (Antigravity IDE, Claude Desktop, Cursor, VS Code, or custom multi-agent orchestrators).

---

## 📚 Documentation Index

The following documentation sets out the vision, design, requirements, user stories, and architecture of `agent-mcp`:

| Document | Description |
| --- | --- |
| 📋 [Product Requirements (PRD)](docs/PRD.md) | Problem statement, goals/non-goals, architecture overview, MCP tool specifications, safety model, and roadmap. |
| 📖 [User Stories & Epics](docs/USER_STORIES.md) | Detailed user stories, acceptance criteria, epic organization, and prioritization matrix. |
| 🗺️ [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) | Step-by-step technical implementation roadmap divided into 6 distinct phases. |
| 🎨 [Draw.io Diagram](docs/diagrams/architecture.drawio) | Edit-ready Draw.io XML diagram showing system layers, MCP routers, session managers, adapters, and target CLIs. |

---

## 🛠️ Key Architectural Highlights

1. **Universal Adapter Layer**: Supports JSON-stream framing (`claude`, `agy`) and PTY terminal fallback (`opencode`, `aider`).
2. **Dual Transport Modes**: Supports `stdio` (for local MCP IDE integration) and `HTTP-SSE` (for remote network access & mobile tethering).
3. **Dual Execution Models**:
   - **Synchronous (`agent_run`)**: Blocks until task completion, returning markdown diffs and summaries.
   - **Asynchronous (`agent_session_*`)**: Runs sub-agents in background tasks with progress tracking, stdout log streaming, follow-up prompts, and cancellation.
4. **Workspace Security**: Strict path allowlist validation (`allowedWorkspaces`) and credential sanitization.

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
