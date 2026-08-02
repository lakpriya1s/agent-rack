# Simpler Shared-Dashboard Guidance Design

**Date:** 2026-08-02

## Goal

Keep agent-rack's current runtime architecture and make the optional shared dashboard easy to understand when a user runs `agent-rack dashboard` from the normal stdio setup.

The normal Claude Code experience remains zero-maintenance: Claude Code launches its private agent-rack stdio process automatically. Users can inspect sessions in that process by asking Claude Code to call the existing `agent_session_list`, `agent_session_status`, and `agent_session_logs` MCP tools.

Users who explicitly want the terminal dashboard continue to run one shared SSE server and connect the dashboard—and any participating MCP clients—to that server.

## Non-goals

This change will not:

- Auto-start or daemonize an agent-rack server.
- Prompt for or persist a port.
- Rewrite Claude Code or other MCP client configuration.
- Add a hybrid stdio/SSE transport or proxy.
- Change server ownership, lifecycle, authentication, or workspace validation.
- Make sessions from an existing private stdio process visible to an unrelated SSE server.

## User Experience

When the loaded config uses `transport: "stdio"` and no explicit `--connect` URL is supplied, the dashboard exits with concise copy-paste instructions:

```text
The dashboard is optional and requires a shared SSE server.

Terminal 1:
  npx agent-rack@latest start --transport sse --port 8987

Terminal 2:
  npx agent-rack@latest dashboard --connect http://localhost:8987/sse

Only sessions created through that SSE server—or by MCP clients configured to
http://localhost:8987/sse—appear in the dashboard.

For sessions in your normal private stdio setup, ask Claude Code to use
agent_session_list, agent_session_status, or agent_session_logs.
```

When an explicit URL is supplied but cannot be reached, the error uses the same command block with the supplied URL and includes the underlying connection error. It must not imply that starting an SSE server automatically exposes sessions from an already-running stdio process.

## Code Structure

A small exported formatter in the dashboard connection module will own the shared-server help text. Both failure paths consume it:

1. `resolveDashboardServerUrl` uses it when config is stdio and `--connect` is absent.
2. `startDashboard` uses it when connection preflight fails.

Centralizing the text prevents the two errors from drifting and keeps connection resolution separate from rendering and server lifecycle.

No new files or dependencies are required unless implementation reveals that a focused helper file materially improves test isolation.

## Error Handling

- Preserve the existing non-zero exit behavior.
- Preserve the TTY guard; non-TTY invocations still report the TTY-specific error before connection guidance.
- Preserve `--connect` precedence over config.
- Use port `8987` in the default copy-paste commands.
- For a custom `--connect` URL, show that URL rather than silently replacing it with the default.
- Include the original connection error after the actionable guidance.

## Testing

Focused unit tests will verify that:

- Stdio config without `--connect` returns both exact `npx agent-rack@latest` commands.
- The guidance mentions that private stdio sessions are separate and identifies the session-list/status/log MCP tools.
- Custom connection failures preserve the requested URL in their guidance.
- Existing explicit-URL precedence and SSE config resolution remain unchanged.

The full test suite and typecheck must pass. Since this is pre-render CLI guidance rather than an Ink layout change, no new component-render harness or PTY smoke test is required; an optional direct CLI smoke may verify the complete emitted message.

## Documentation

Update the README dashboard section to distinguish clearly between:

- Normal stdio usage: no manual server; inspect sessions through MCP calls in Claude Code.
- Optional shared dashboard usage: run the two explicit SSE/dashboard commands and point participating clients at the same SSE URL.

This keeps the dashboard available without making the default agent-rack setup operationally complex.
