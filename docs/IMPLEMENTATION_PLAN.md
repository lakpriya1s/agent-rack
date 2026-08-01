# Implementation Plan — Agent-MCP

**Project Name**: Agent-MCP (`agent-mcp`)  
**Document Version**: 1.0.0  
**Status**: Approved / In-Progress  
**Target Architecture**: Node.js + TypeScript + `@modelcontextprotocol/sdk`  

---

## Overview

This document defines the step-by-step technical implementation roadmap for `agent-mcp`. Each phase is divided into granular, actionable tasks with clear completion criteria to ensure steady, verifiable progress.

---

## 🏁 Phase Breakdown Summary

```
  Phase 1: Project Setup & Config Engine
     └── Initializing TypeScript project, Zod validation, Security/Workspace Guard
  Phase 2: Agent Transport Adapters
     └── ClaudeStreamJsonAdapter, AgyStreamAdapter, PtyTerminalAdapter
  Phase 3: Session Manager & Background Process Engine
     └── Process spawning, timeout handling, background session store, log buffering
  Phase 4: MCP Tool Registration & Server Core
     └── Stdio Server, Unified Tools (agent_run, agent_session_*), Dynamic Shortcuts
  Phase 5: CLI Executable & Client Integration
     └── `agent-mcp` CLI binary, Claude Desktop config generator, Antigravity integration
  Phase 6: Testing, Verification & Final Delivery
     └── Unit tests, mock CLI integration tests, end-to-end tool call validation
```

---

## Phase 1: Project Setup & Core Configuration Engine

### 📌 Step 1.1: Project Initialization & Build System
- [x] Initialize `package.json` with ESM module setup (`"type": "module"`).
- [x] Configure `tsconfig.json` for modern Node.js ES2022+ target.
- [x] Add core dependencies:
  - `@modelcontextprotocol/sdk` (Official MCP SDK)
  - `zod` (Runtime schema validation)
  - `node-pty` (Terminal PTY emulation)
  - `commander` (CLI binary framework)
  - `execa` / `cross-spawn` (Child process handling)
- [x] Set up build & dev scripts (`pnpm build`, `pnpm dev`, `pnpm test`).

### 📌 Step 1.2: Configuration Engine & Schema (`src/config/`)
- [x] Create `src/config/schema.ts` with Zod validation for `agent-mcp.config.json`.
- [x] Implement `src/config/loader.ts` to locate, parse, and validate config files.
- [x] Provide sensible defaults and config generator utility (`agent-mcp config init`).

### 📌 Step 1.3: Security & Workspace Guard (`src/security/`)
- [x] Create `src/security/workspace.ts` to normalize paths (`path.resolve`, `path.normalize`).
- [x] Enforce strict checking against `allowedWorkspaces` (prevents path traversal attacks like `../..`).
- [x] Create `src/security/env.ts` to sanitize sensitive environment variables before passing to sub-agents.

---

## Phase 2: Agent Transport Adapters Layer

### 📌 Step 2.1: Base Adapter Interface (`src/adapters/base.ts`)
- [x] Define `AgentAdapter` abstract interface:
  - `spawn(options: SpawnOptions): Promise<AgentProcess>`
  - `parseStreamEvent(chunk: string): ParsedAgentEvent`
  - `formatToolResponse(events: ParsedAgentEvent[]): MCPToolResult`

### 📌 Step 2.2: Claude Stream JSON Adapter (`src/adapters/claude.ts`)
- [x] Implement newline-delimited JSON stream parser for `claude --output-format json`.
- [x] Extract tool calls (`Edit`, `Bash`, `View`, `Grep`), git diffs, cost metrics, and final answers.
- [x] Transform parsed JSON stream into human-readable markdown tool responses.

### 📌 Step 2.3: AGY Stream Adapter (`src/adapters/agy.ts`)
- [x] Implement event handler for Antigravity CLI (`agy --mode headless`).
- [x] Parse AGY step outputs, tool executions, and progress events.

### 📌 Step 2.4: Terminal PTY Adapter (`src/adapters/pty.ts`)
- [x] Implement `PtyTerminalAdapter` using `node-pty` for raw interactive CLI fallback (`opencode`, `aider`).
- [x] Strip ANSI escape sequences for text outputs.
- [x] Implement prompt detection and automated input response handling.

---

## Phase 3: Session Manager & Background Process Engine

### 📌 Step 3.1: Process Manager & Lifecycle (`src/engine/process.ts`)
- [x] Create process spawn wrapper with timeout enforcement.
- [x] Implement signal handling (`SIGINT` graceful stop $\rightarrow$ 5s grace period $\rightarrow$ `SIGKILL`).
- [x] Prevent orphaned sub-processes on server exit via process group cleanup hooks.

### 📌 Step 3.2: Session Store & Task State Machine (`src/engine/session.ts`)
- [x] Implement `SessionManager` in-memory store tracking active sessions.
- [x] Manage session states (`running`, `idle`, `completed`, `failed`, `cancelled`).
- [x] Support concurrent session limit (`maxConcurrentSessions`).

### 📌 Step 3.3: Event & Output Buffer (`src/engine/buffer.ts`)
- [x] Implement ring buffer per session (e.g. max 512 events / 1MB stdout).
- [x] Provide log extraction method for `agent_session_logs` polling.

---

## Phase 4: MCP Server Core & Tool Registration

### 📌 Step 4.1: Stdio MCP Server Setup (`src/server.ts`)
- [x] Initialize `@modelcontextprotocol/sdk/server/index.js` with `Server` instance.
- [x] Attach `StdioServerTransport` for standard MCP client connections.

### 📌 Step 4.2: Implement Unified Tools (`src/tools/unified.ts`)
- [x] `agent_list_available`: Returns list of configured and available agent CLIs.
- [x] `agent_run`: Synchronously executes sub-agent task and returns formatted markdown.
- [x] `agent_session_create`: Spawns background session and returns `sessionId`.
- [x] `agent_session_status`: Returns current status & summary of background session.
- [x] `agent_session_send`: Sends follow-up text to active background session.
- [x] `agent_session_cancel`: Gracefully terminates background session.
- [x] `agent_session_logs`: Retrieves recent stdout/stderr event logs.

### 📌 Step 4.3: Implement Dynamic Per-Agent Tool Shortcuts (`src/tools/shortcuts.ts`)
- [x] Dynamically generate shortcut MCP tools (`agy_run`, `claude_run`, `opencode_run`) based on `config.agents`.

---

## Phase 5: CLI Executable & Integration Tooling

### 📌 Step 5.1: Executable CLI Binary (`src/cli/index.ts`)
- [x] Build `bin/agent-mcp.js` CLI entry point.
- [x] Implement commands:
  - `agent-mcp start` (Starts MCP server)
  - `agent-mcp config check` (Validates configuration file)
  - `agent-mcp config init` (Generates sample config)
  - `agent-mcp agents list` (Checks local binary installations)

### 📌 Step 5.2: Client Configuration Generators (`src/cli/install.ts`)
- [x] Generate standard MCP server config snippets for:
  - Claude Desktop (`claude_desktop_config.json`)
  - Antigravity IDE (`.gemini/mcp.json`)
  - Cursor / VS Code (`mcp.json`)

---

## Phase 6: Testing, Verification & Final Delivery

### 📌 Step 6.1: Unit & Integration Testing
- [x] Write unit tests for workspace path validation (`src/security/workspace.test.ts`).
- [x] Write unit tests for JSON stream parsers (`src/adapters/claude.test.ts`).
- [x] Test process cancellation and cleanup.

### 📌 Step 6.2: Real-World E2E Verification
- [x] Verify `claude_run` execution using local `claude` CLI.
- [x] Verify `agy_run` execution using local `agy` CLI.
- [x] Test calling `agent-mcp` from Antigravity IDE as a live MCP tool server.

---

## 📅 Step-by-Step Execution Matrix

| Step | Task Summary | Output Artifact | Est. Effort |
| --- | --- | --- | --- |
| **Phase 1** | Project Setup & Security Guard | `package.json`, `src/config/`, `src/security/` | Step 1 |
| **Phase 2** | Agent Transport Adapters | `src/adapters/` (Claude, AGY, PTY) | Step 2 |
| **Phase 3** | Session Engine & Process Lifecycle | `src/engine/` (Process, Session, Buffer) | Step 3 |
| **Phase 4** | MCP Protocol & Tool Registration | `src/server.ts`, `src/tools/` | Step 4 |
| **Phase 5** | CLI Executable & Client Integrations | `bin/agent-mcp.js`, `src/cli/` | Step 5 |
| **Phase 6** | End-to-End Testing & Verification | Test suites & verification logs | Step 6 |
