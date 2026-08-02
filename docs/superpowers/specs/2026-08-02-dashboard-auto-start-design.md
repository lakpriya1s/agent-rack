# One-command shared dashboard design

**Date:** 2026-08-02

## Goal

Make `npx agent-rack@latest dashboard` the complete shared-session workflow. After the existing TTY guard, the command loads configuration unchanged, connects to a valid loopback SSE server on the configured port (default 8987), or starts an in-process loopback SSE server when none is reachable. Explicit `--connect` remains external-only.

## Architecture

### Loaded-config server API

Refactor server startup around an exported API that accepts an already-validated `AgentMCPConfig`. It constructs the existing shared `SessionManager` and MCP tool handlers once, starts SSE only on `127.0.0.1`, and returns an owned handle containing the effective URL plus an async close operation. Existing `startAgentMCPServer` keeps loading configuration and preserves stdio and explicit start behavior.

The owned handle tracks active sockets. Closing it first closes the dashboard MCP client, destroys active HTTP connections, and then awaits HTTP server close. Listen errors reject the startup promise and clean partial state.

### Dashboard server coordinator

A focused coordinator receives the loaded config, optional explicit URL, and injectable client/server factories. With `--connect`, it connects once and never starts or owns a server. Without it, it derives `http://127.0.0.1:<configured-port-or-8987>/sse`, probes by opening a real dashboard MCP client, and returns `EXISTING` on success. On connection failure it starts an in-process SSE server from the exact loaded config, connects a fresh client, and returns `AUTO-STARTED` plus an idempotent cleanup function. Startup failures become concise, actionable errors.

No workspace paths are rewritten: the already-loaded `allowedWorkspaces` array passes directly into the existing server context, so all existing `validateWorkspacePath` calls remain authoritative.

### One-time Claude Code setup

After the server is reachable and before Ink renders, a focused setup module invokes Claude Code with argv arrays only. It parses `claude mcp get agent-rack` output into effective scope and SSE URL. A matching URL is a no-op. Otherwise it asks for terminal confirmation, preserving the parsed local/project/user scope (default local), removes an effective old registration when present, and adds the new SSE registration. Missing Claude, decline, parse/command failures, and a test-only skip flag return warnings rather than blocking the dashboard. Successful mutation returns a one-time restart/reconnect notice.

All process execution and confirmation are injected for tests; tests never touch real Claude configuration.

### TUI lifecycle

`DashboardApp` receives server mode, startup warning/notice, and an exit callback. The header/footer displays `AUTO-STARTED` or `EXISTING`; owned mode also states that the server stops when the dashboard closes.

Exit policy is a pure state transition. Existing/external mode exits immediately and never cancels sessions. Owned mode exits immediately if no sessions run. If sessions run, the first `q` displays a warning and arms exit; a second `q` cancels only the currently running sessions through the owned remote client, then exits. Other interaction clears or safely preserves the arm state as defined by the reducer.

The launcher awaits Ink completion, then always closes the MCP client and, only for owned mode, the owned server. Setup, render, and connection failures use the same cleanup path.

## Errors and security

- TTY failure happens before config loading, probing, subprocess inspection, or server startup.
- Explicit `--connect` never falls back to auto-start and is never stopped.
- Only loopback `127.0.0.1` is used for an owned listener.
- Port conflicts or listener failures reject promptly with friendly messages.
- Claude setup warnings do not prevent dashboard use.
- No daemon, persistence, authentication, dependency, shell command string, or permission relaxation is introduced.
- Workspace validation, review read-only enforcement, and `rawText` review parsing remain unchanged.

## Testing

Use TDD with focused tests:

- Real coordinator/server tests cover auto-start, existing connection, explicit external failure, cleanup releasing the port, preserving an existing server, and prompt listen rejection.
- Claude setup tests use injected command/confirmation fakes for scope parsing, matching URL, decline, remove/add argv, missing binary, and command failure warnings.
- Pure exit-decision tests cover first/second `q` behavior and external-session non-cancellation.
- Existing guidance/security tests stay green or are updated only where the new UX intentionally replaces obsolete guidance.
- Full verification: `pnpm test`, `pnpm typecheck`, `pnpm build`, CLI version, and a PTY dashboard smoke without a separately started server. The smoke uses an internal test-only environment flag to skip real Claude configuration.

## Documentation and release

Lead README usage with `npx agent-rack@latest dashboard`. Explain the one-time Claude confirmation and restart/reconnect, owned server lifetime, session visibility through the shared SSE registration, and advanced external `--connect`. Bump repository metadata from 0.4.0 to 0.5.0 using the existing package/lockfile convention.
