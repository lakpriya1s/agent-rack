# Product Requirement Document (PRD) — Agent-MCP

**Project Name**: Agent-MCP (`agent-mcp`)  
**Document Version**: 1.0.0  
**Status**: Draft / Proposed  
**Author**: Antigravity Engineering Team & User  
**Target Audience**: Developers, AI System Architects, Multi-Agent Tool Developers  

---

## 1. Executive Summary

`Agent-MCP` is an open-source, high-performance Model Context Protocol (MCP) server that wraps CLI-based AI coding agents (such as `agy` [Antigravity CLI], `claude` [Claude Code], `opencode`, `aider`, and custom CLI agents) into standard MCP tools. 

By running `agent-mcp`, any MCP-compliant AI client (e.g. Antigravity IDE, Claude Desktop, Cursor, VS Code Copilot, or custom multi-agent orchestrators) can dynamically discover, spawn, monitor, interact with, and delegate subtasks to local CLI agents as structured tool calls.

---

## 2. Problem Statement

### 2.1 The Multi-Agent Isolation & Interoperability Deficit
1. **Isolated Tool Ecosystems**: Advanced AI CLI agents (`agy`, `claude`, `opencode`) excel at deep codebase exploration, file editing, terminal execution, and git operations. However, invoking them from another primary AI interface currently requires manual shell execution or complex ad-hoc scripting.
2. **Lack of Standard Protocol for Agent Delegation**: Standard MCP allows AI models to call atomic tools (file reads, SQL queries, HTTP fetches), but lacks a standardized bridge to delegate high-level complex tasks to specialized sub-agent CLI runtimes.
3. **Interruption & Control Overhead**: Sub-agents require workspace safety boundaries, stream parsing (JSON stream vs PTY text), output filtering, permission auto-handling, and lifecycle management (cancellation, timeouts, background execution).

### 2.2 Core Objective
To establish a lightweight, secure, and standardized MCP server that turns any local CLI coding agent into a plug-and-play MCP tool, enabling hierarchical multi-agent collaboration, task delegation, and automated background execution.

---

## 3. Goals & Non-Goals

### 3.1 Goals
1. **Universal CLI Agent Adapter**: Support heterogeneous agent interfaces:
   - `claude_stream_json` / JSON-stream transport (e.g. `claude --dangerously-skip-permissions --output-format json`)
   - `agy_stream` / AGY CLI events (e.g. `agy --mode headless --json`)
   - `pty_interactive` / Terminal PTY transport (fallback for raw interactive CLIs like `opencode`, `aider`, or custom shell scripts).
2. **Dual Execution Models**:
   - **Synchronous Delegation (`agent_run`)**: Execute a task to completion within an MCP call timeout, returning formatted markdown summary, diffs, and execution logs.
   - **Asynchronous Task Management (`agent_session_*`)**: Start long-running agent tasks in background sessions, check status (`agent_session_status`), stream incremental events (`agent_session_logs`), send follow-up inputs (`agent_session_send`), or cancel (`agent_session_cancel`).
3. **Dynamic & Generic Tool Registration**:
   - Expose generic tools (`agent_run`, `agent_session_create`) for any registered agent.
   - Dynamically register dedicated top-level MCP tools per configured agent (e.g. `agy_run`, `claude_run`, `opencode_run`).
4. **Workspace & Security Boundary**:
   - Restrict agent execution strictly to allowed workspaces (`allowedWorkspaces`).
   - Sanitize environment variables and credentials passed to child agent runtimes.
   - Configurable permission policy (e.g., auto-accept file edits, read-only mode, or delegate approvals).
5. **Session Output Retention & Parsing**:
   - Structured parsing of child agent outputs into standard tool call events, git diffs, file modifications, and final text summaries.

### 3.2 Non-Goals
1. **Replacing MCP Clients**: `agent-mcp` is an MCP server, not a standalone GUI app. Client user interfaces (Antigravity IDE, Claude Desktop, iOS Tether) connect to `agent-mcp` as standard MCP clients.
2. **Cloud Orchestration / Remote Multi-Tenant Hosting**: `agent-mcp` runs locally on the user's host machine. Cross-network transport can be handled via SSH tunnel or Tailscale if needed, but the server assumes local process ownership.
3. **Custom Model Training**: `agent-mcp` orchestrates existing binary CLIs; it does not host or train local LLMs directly.

---

## 4. System Architecture & Component Overview

```
 +-------------------------------------------------------------------------+
 |                            MCP Client                                   |
 |    (Antigravity IDE / Claude Desktop / Cursor / Master Agent)           |
 +-------------------------------------------------------------------------+
                                    |
                                    | Standard MCP (JSON-RPC over stdio / SSE)
                                    v
 +-------------------------------------------------------------------------+
 |                               Agent-MCP                                 |
 |                                                                         |
 |  +--------------------+  +--------------------+  +-------------------+  |
 |  |    MCP Protocol    |  |  Session Manager   |  | Config & Security |  |
 |  |    Handler Layer   |  |   & Task Store     |  |   Workspace Check |  |
 |  +--------------------+  +--------------------+  +-------------------+  |
 |                            |            |                               |
 |     +----------------------+            +----------------------+        |
 |     v                                                          v        |
 |  +-----------------------------------+  +----------------------------+  |
 |  |    Stream JSON Adapter            |  |    PTY / Terminal Adapter  |  |
 |  |    (Claude / AGY JSON Stream)     |  |    (node-pty / Stdio)     |  |
 |  +-----------------------------------+  +----------------------------+  |
 +-------------------------------------------------------------------------+
                   |                                      |
                   v                                      v
      +------------------------+             +------------------------+
      |  agy CLI / Claude Code |             | opencode / Aider / CLI |
      +------------------------+             +------------------------+
```

### 4.1 Key Architecture Modules
1. **MCP Transport Handler**: Implements official `@modelcontextprotocol/sdk` supporting `stdio` transport (for local CLI integration) and `HTTP-SSE` transport (for network access).
2. **Agent Transport Layer**:
   - `ClaudeStreamJsonAdapter`: Handles line-delimited JSON stream protocols from `claude`, parsing tool use, input/output frames, cost metrics, and completion events.
   - `AgyStreamAdapter`: Handles Antigravity CLI headless output and tool call events.
   - `PtyTerminalAdapter`: Spawns terminal PTYs via `node-pty`, handling ANSI escape codes, terminal sizing, prompt detection, and text buffer capture.
3. **Session & Process Lifecycle Engine**: Manages running sub-agent processes, active task buffers, stdout/stderr retention, timeouts, process signals (`SIGINT`, `SIGTERM`, `SIGKILL`), and workspace validation.
4. **Tool Schema Registry**: Converts agent configurations (`config.json`) into MCP `Tool` declarations with strict JSON Schema definitions for parameters.

---

## 5. MCP Tool Interface Specifications

`agent-mcp` exposes two classes of tools: **Unified Multi-Agent Tools** and **Dynamic Per-Agent Tools**.

### 5.1 Unified Tools

#### `agent_list_available`
Lists all registered agent CLIs on the host, their capabilities, transport types, and default workspace restrictions.
- **Parameters**: None
- **Returns**: `Array<{ agentId: string, name: string, transport: string, description: string, status: "available" | "missing_binary" }>`

#### `agent_run` (Synchronous Execution)
Executes a specified sub-agent CLI synchronously for a prompt and returns the result once complete.
- **Parameters**:
  - `agent` (string, required): ID of the agent (e.g., `"agy"`, `"claude"`, `"opencode"`).
  - `prompt` (string, required): Detailed prompt/instruction for the sub-agent.
  - `workspace` (string, optional): Directory path where the sub-agent should run. Must match `allowedWorkspaces`.
  - `timeoutSeconds` (number, default: 300): Maximum execution time before aborting.
  - `mode` (string, default: `"auto"`): Execution mode (`"auto"`, `"plan"`, `"accept_edits"`, `"manual"`).
- **Returns**: Formatted text containing agent reasoning, summary of file edits/tool calls, git diff summary, and exit code.

#### `agent_session_create` (Asynchronous Execution)
Spawns a background session with a sub-agent.
- **Parameters**:
  - `agent` (string, required): ID of the agent to spawn.
  - `prompt` (string, required): Initial instruction/task prompt.
  - `workspace` (string, optional): Target workspace path.
  - `mode` (string, default: `"auto"`): Safety/permission mode.
- **Returns**: `{ sessionId: string, agent: string, status: "running" | "idle", createdAt: string }`

#### `agent_session_status`
Retrieves current status, metrics, and last output summary of a background session.
- **Parameters**:
  - `sessionId` (string, required): ID returned by `agent_session_create`.
- **Returns**: `{ sessionId: string, status: "running" | "completed" | "failed" | "waiting_for_input", lastEvent: object, summary: string }`

#### `agent_session_send`
Sends follow-up text or user input to an active background session.
- **Parameters**:
  - `sessionId` (string, required)
  - `message` (string, required)
- **Returns**: `{ sessionId: string, status: "sent" }`

#### `agent_session_cancel`
Terminates a running background session process cleanly.
- **Parameters**:
  - `sessionId` (string, required)
- **Returns**: `{ sessionId: string, status: "cancelled" }`

### 5.2 Dynamic Per-Agent Shortcuts
When configured, `agent-mcp` automatically registers shorthand tools:
- `agy_run` (shorthand for `agent_run` with `agent: "agy"`)
- `claude_run` (shorthand for `agent_run` with `agent: "claude"`)
- `opencode_run` (shorthand for `agent_run` with `agent: "opencode"`)

---

## 6. Configuration & Safety Model

### 6.1 Configuration File (`agent-mcp.config.json`)

```json
{
  "$schema": "./schema/config.schema.json",
  "port": 8987,
  "transport": "stdio",
  "allowedWorkspaces": [
    "/Volumes/External/agent-mcp",
    "/Users/developer/projects"
  ],
  "agents": {
    "agy": {
      "name": "Antigravity CLI",
      "command": "agy",
      "args": ["--mode", "headless"],
      "transport": "agy_stream",
      "env": {
        "PAGER": "cat"
      }
    },
    "claude": {
      "name": "Claude Code CLI",
      "command": "claude",
      "args": ["--dangerously-skip-permissions", "--output-format", "json"],
      "transport": "claude_stream_json",
      "env": {}
    },
    "opencode": {
      "name": "OpenCode Interpreter CLI",
      "command": "opencode",
      "args": ["--non-interactive"],
      "transport": "pty_interactive",
      "env": {}
    }
  },
  "security": {
    "sanitizeEnv": true,
    "maxConcurrentSessions": 5,
    "defaultTimeoutSeconds": 600
  }
}
```

### 6.2 Security & Isolation Boundary
1. **Workspace Restriction**: Any attempt to set `workspace` outside `allowedWorkspaces` immediately rejects the tool call with an MCP error.
2. **Environment Variable Sanitization**: Sensitive host keys (`AWS_SECRET_ACCESS_KEY`, master tokens) can be filtered out unless explicitly permitted in agent configuration.
3. **Process Sandboxing & Resource Limits**: Enforce execution time limits and process cleanup hooks to avoid orphaned process leaks.

---

## 7. Performance & System Requirements

- **Supported Platforms**: macOS 13+, Linux (Ubuntu 22.04+), Windows Subsystem for Linux (WSL2).
- **Runtime Environment**: Node.js 20.11+ / Node.js 22 LTS, pnpm 10+.
- **Process Memory Overhead**: < 50MB RSS for the `agent-mcp` host core (excluding spawned sub-agent CLI binaries).
- **Latency**: < 15ms overhead per MCP tool call translation.

---

## 8. Success Criteria & Metrics

1. **Protocol Compliance**: 100% adherence to MCP standard JSON-RPC 2.0 specifications.
2. **Agent Interoperability**: Successfully drive `agy`, `claude`, `opencode` concurrently from Antigravity IDE or Claude Desktop.
3. **Session Reliability**: Zero orphaned sub-processes on cancellation or server shutdown; 100% clean process cleanup.
4. **Developer Experience**: One-command initialization via `npx agent-mcp` or `pnpm start`.

---

## 9. Future Extensions / Roadmap
- **Phase 1 (MVP)**: Core MCP stdio server, `claude_stream_json` and `pty_interactive` adapters, `agent_run` sync & `agent_session_*` async tools.
- **Phase 2**: SSE transport support, dynamic tool output streaming via MCP progress notifications, Draw.io visualization generation integration.
- **Phase 3**: Webhook events & integration with remote monitoring dashboards (iOS Tether integration).
