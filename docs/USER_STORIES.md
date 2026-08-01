# User Stories & Epics — Agent-MCP

**Project Name**: Agent-MCP (`agent-mcp`)  
**Document Version**: 1.0.0  
**Status**: Approved / Ready for Implementation  

---

## Overview

This document outlines the User Stories, Epics, Acceptance Criteria, and Priority Breakdown for `Agent-MCP`. These stories guide the development of the MCP server, CLI adapters, session lifecycle engine, and client integrations.

---

## Epic 1: Multi-Agent Registration & CLI Discovery

### US-1.1: Automatic Discovery of Local Agent CLIs
- **As an** AI Developer or Master Agent,
- **I want** `agent-mcp` to list all available local CLI coding agents (`agy`, `claude`, `opencode`, etc.) on the host machine,
- **So that** I know which sub-agents are available for task delegation without manual setup.

**Acceptance Criteria**:
- Calling `agent_list_available` returns a list of registered agents, their transport types, binary locations, and execution status (`available` vs `missing_binary`).
- If an agent binary is not installed on `$PATH`, it is flagged with `missing_binary` and helpful installation hints.
- Output includes supported features (e.g. streaming, file editing, execution modes).

### US-1.2: Dynamic MCP Tool Generation for Configured Agents
- **As an** MCP Client user (e.g. Cursor, Antigravity IDE, Claude Desktop),
- **I want** `agent-mcp` to automatically register individual MCP tools for each configured agent (e.g. `agy_run`, `claude_run`, `opencode_run`),
- **So that** I can invoke specific agents directly with dedicated schema autocomplete.

**Acceptance Criteria**:
- `agent-mcp` reads `agent-mcp.config.json` at startup.
- Dynamically creates top-level MCP tools corresponding to configured keys in `agents`.
- Tool descriptions clearly indicate the underlying agent's capabilities and expected inputs.

---

## Epic 2: Synchronous & Asynchronous Agent Execution

### US-2.1: Synchronous Sub-Task Delegation (`agent_run`)
- **As a** Master AI Agent,
- **I want** to execute a sub-agent task synchronously via `agent_run` and wait for the result,
- **So that** I can delegate atomic subtasks (e.g. "refactor module X", "write unit tests for file Y") inline during my reasoning cycle.

**Acceptance Criteria**:
- `agent_run` accepts `agent`, `prompt`, `workspace`, `timeoutSeconds`, and `mode`.
- Blocks execution until the sub-agent completes or timeout is reached.
- Returns a structured payload containing:
  - Text answer / summary from the sub-agent.
  - Formatted file diffs and tool invocation summary.
  - Final exit code and duration.
- Enforces timeout cleanly with process termination if exceeded.

### US-2.2: Asynchronous Background Session Creation (`agent_session_create`)
- **As a** Developer using an AI interface,
- **I want** to launch long-running agent tasks in background sessions,
- **So that** my primary chat interface isn't blocked while the sub-agent performs extensive research or builds.

**Acceptance Criteria**:
- `agent_session_create` spawns a background sub-agent process and immediately returns a `sessionId`.
- Session state is tracked in the `SessionManager` (`running`, `idle`, `completed`, `failed`).
- Process runs independently in the background while logging stdout/stderr events.

### US-2.3: Session Status & Log Inspection (`agent_session_status` & `agent_session_logs`)
- **As a** Master AI Agent or User,
- **I want** to check the status and retrieve recent logs/events of an ongoing background session,
- **So that** I can monitor progress, evaluate sub-agent output, and report status.

**Acceptance Criteria**:
- `agent_session_status` returns current lifecycle state, runtime metrics, and high-level summary.
- Supports offset-based log polling or limit parameters (e.g., last 50 events or last 10KB of stdout).

### US-2.4: Interactive Session Steering & Cancellation (`agent_session_send` & `agent_session_cancel`)
- **As a** User or Master Agent,
- **I want** to send follow-up prompts to a background session or cancel it if it goes off-track,
- **So that** I maintain complete control over sub-agent execution.

**Acceptance Criteria**:
- `agent_session_send` writes prompt input directly to the running agent session stream/stdin.
- `agent_session_cancel` sends `SIGINT`/`SIGTERM` to gracefully stop the sub-process, followed by `SIGKILL` if unresponsive after 5 seconds.
- Session status updates to `cancelled`.

---

## Epic 3: Process Adapters & Transports

### US-3.1: Claude Stream JSON Transport Adapter
- **As a** Developer using Claude Code CLI,
- **I want** `agent-mcp` to support Claude Code's native JSON stream interface (`--output-format json`),
- **So that** tool calls, diffs, cost tokens, and responses are parsed cleanly into structured MCP outputs.

**Acceptance Criteria**:
- Parses newline-delimited JSON messages from `claude`.
- Captures tool calls (`Edit`, `Bash`, `Grep`, `View`), file changes, and standard output.
- Formats parsed JSON into human-readable markdown summaries for MCP tool responses.

### US-3.2: AGY (Antigravity CLI) Transport Adapter
- **As an** Antigravity user,
- **I want** `agent-mcp` to drive `agy` in headless/event stream mode,
- **So that** I can leverage AGY autonomous workflows inside other MCP clients.

**Acceptance Criteria**:
- Spawns `agy` with headless/stream flags.
- Translates AGY event streams into standard MCP progress notifications and final results.

### US-3.3: Terminal PTY Transport Adapter (Interactive CLI Fallback)
- **As a** Developer using arbitrary CLI tools (`opencode`, `aider`, custom scripts),
- **I want** `agent-mcp` to spawn interactive terminal processes via `node-pty`,
- **So that** any command-line agent can be wrapped as an MCP tool even if it lacks a structured JSON API.

**Acceptance Criteria**:
- Uses `node-pty` to simulate pseudo-terminal environment.
- Strips ANSI color/escape codes for text responses while retaining formatted output.
- Handles interactive prompt detection and automated responses.

---

## Epic 4: Workspace Security & Environment Isolation

### US-4.1: Workspace Path Allowlist Validation
- **As a** Security-conscious Developer,
- **I want** `agent-mcp` to restrict agent execution strictly to pre-approved workspace directories,
- **So that** a sub-agent cannot read or modify files outside authorized project boundaries.

**Acceptance Criteria**:
- `allowedWorkspaces` is enforced on every tool call (`agent_run`, `agent_session_create`).
- Path normalization protects against directory traversal attacks (e.g. `../../etc/passwd`).
- Rejects unauthorized paths with explicit security error: `Workspace '/path' is not in allowedWorkspaces`.

### US-4.2: Environment Variable Sanitization
- **As an** Enterprise Developer,
- **I want** `agent-mcp` to sanitize sensitive host credentials before spawning child agents,
- **So that** host secrets are not leaked or overridden inadvertently.

**Acceptance Criteria**:
- Child processes inherit a clean, sanitized environment by default.
- Configurable `env` block in `agent-mcp.config.json` allows explicit inclusion/exclusion of environment variables.

---

## Epic 5: Draw.io Diagram & Architecture Visualization

### US-5.1: Draw.io Diagram File Creation
- **As an** Architect or Technical Lead,
- **I want** a dedicated Draw.io diagram file (`.drawio`) describing system flow and architecture,
- **So that** team members can visualize and edit system designs in Draw.io or VS Code Draw.io extensions.

**Acceptance Criteria**:
- Valid Draw.io XML schema file saved at `docs/diagrams/architecture.drawio`.
- Renders System Architecture, Sequence Flow of MCP Tool Invocation, and Adapter Layer.

---

## Prioritization Matrix

| Story ID | Epic | Feature Summary | Priority | Complexity |
| --- | --- | --- | --- | --- |
| **US-1.1** | Discovery | List available local CLI agents | **P0 (Must)** | Low |
| **US-1.2** | Discovery | Dynamic per-agent MCP tools (`agy_run`, `claude_run`) | **P0 (Must)** | Medium |
| **US-2.1** | Execution | Synchronous tool execution (`agent_run`) | **P0 (Must)** | Medium |
| **US-2.2** | Execution | Async background sessions (`agent_session_create`) | **P0 (Must)** | High |
| **US-2.3** | Execution | Session status & logs (`agent_session_status`) | **P1 (Should)** | Medium |
| **US-2.4** | Execution | Session send input & cancel | **P1 (Should)** | Medium |
| **US-3.1** | Adapters | Claude JSON stream adapter | **P0 (Must)** | High |
| **US-3.2** | Adapters | AGY event stream adapter | **P0 (Must)** | Medium |
| **US-3.3** | Adapters | PTY terminal fallback adapter | **P1 (Should)** | High |
| **US-4.1** | Security | Workspace allowlist validation | **P0 (Must)** | Low |
| **US-4.2** | Security | Env variable sanitization | **P1 (Should)** | Low |
| **US-5.1** | Diagrams | Draw.io architecture diagram generation | **P0 (Must)** | Medium |
