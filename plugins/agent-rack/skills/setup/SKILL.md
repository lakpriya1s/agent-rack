---
name: setup
description: Verify the agent-rack MCP server is connected and configured agents are usable
allowed-tools: mcp__agent-rack__agent_list_available, Bash(claude mcp:*), Bash(npx agent-rack:*)
disable-model-invocation: true
---

Verify agent-rack is actually connected and usable from this Claude Code session.

## Execution

1. Try calling `mcp__agent-rack__agent_list_available`.
   - If it succeeds: agent-rack's MCP server is connected. Report the returned agent list
     (same presentation as `/agent-rack:agents`) and stop — no further checks needed.
   - If the tool isn't available at all (not listed among your tools): the plugin's `.mcp.json`
     hasn't started the server yet, or it isn't registered in this project. Continue to step 2.
2. Run `claude mcp list` via Bash to see whether `agent-rack` shows up as a registered server.
   - If it's missing, the plugin's `.mcp.json` may not have loaded — tell the user to confirm
     the plugin is installed and enabled, then start a new Claude Code session (MCP servers from
     plugins connect at session start).
3. If `agent-rack` is listed but tools still aren't available, run
   `npx agent-rack config-check` via Bash to confirm the resolved config is valid and
   `allowedWorkspaces` includes the current project directory.

## Output

Report what you found at each step you actually ran — don't claim success past the point where
a check failed. If everything checks out, confirm agent-rack is ready and mention
`/agent-rack:run`, `/agent-rack:review`, and `/agent-rack:session-start` as the next things to
try.
