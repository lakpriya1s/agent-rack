# agent-rack plugin for Claude Code

Use [agent-rack](https://github.com/lakpriya1s/agent-rack) from inside Claude Code without a
separate install step — this plugin registers agent-rack as an MCP server automatically and
adds slash commands for every capability it exposes.

## What You Get

- **Auto-registered MCP server** — installing this plugin wires up agent-rack via `npx`, no
  `agent-rack install --target claude` needed.
- `/agent-rack:run` — run a one-shot task synchronously with a named sub-agent
  (`claude`, `codex`, `opencode`, `agy` for Antigravity, or any custom agent you've configured).
- `/agent-rack:review` — structured, read-only code review (normal or adversarial), foreground
  or background.
- `/agent-rack:session-start`, `/agent-rack:session-status`, `/agent-rack:session-send`,
  `/agent-rack:session-logs`, `/agent-rack:session-cancel` — full background session lifecycle:
  start a long-running task, poll it, send follow-up input, tail its raw event log, or cancel it.
- `/agent-rack:agents` — list configured agents and whether each binary is on `$PATH`.
- `/agent-rack:setup` — verify the MCP server is actually connected and troubleshoot if not.
- **Automatic progress monitoring** — every time a background session is launched
  (`agent_session_create`, or a `*_run` shortcut called with `background: true`), a bundled hook
  nudges Claude to start watching its status/tail live, so you see progress in the chat without
  having to ask.

Every command is a thin wrapper over agent-rack's own MCP tools (`agent_run`, `agent_review`,
`agent_session_*`, `agent_list_available`) — this plugin doesn't duplicate any logic, it just
gives Claude Code convenient, well-documented entry points into them.

## Requirements

- **Node.js 20+** and `npx` on `$PATH` (the MCP server itself runs via `npx -y agent-rack start`).
- Whichever underlying CLI(s) you intend to run must be installed: `claude`, `codex`,
  `opencode`, and/or `agy`. Check with `/agent-rack:agents` once installed.

## Install

Add the marketplace in Claude Code:

```
/plugin marketplace add lakpriya1s/agent-rack
```

Install the plugin:

```
/plugin install agent-rack@agent-rack
```

Reload plugins:

```
/reload-plugins
```

Then verify it's connected:

```
/agent-rack:setup
```

## Configuration

By default, agent-rack scopes `allowedWorkspaces` to whichever directory the MCP server starts
in — normally your open project's root, so most people need zero configuration. If you need to
customize timeouts, allow multiple workspaces, or add a custom agent, see the
[Configuration section](../../README.md#configuration) of the main agent-rack README; the same
`agent-rack.config.json` resolution applies regardless of whether agent-rack is running via this
plugin or a standalone install.

## Usage examples

```
/agent-rack:run codex Add input validation to the signup form
/agent-rack:review claude --adversarial --focus "challenge the retry logic"
/agent-rack:session-start codex Refactor the auth module to use the new session store
/agent-rack:session-status 3f9c2b7a-1e4d-4a2b-9c3e-8f7a6b5c4d3e
/agent-rack:agents
```
