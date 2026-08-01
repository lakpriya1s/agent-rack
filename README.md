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
