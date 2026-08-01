---
name: agents
description: List agent-rack's configured CLI agents and whether each binary is available
allowed-tools: mcp__agent-rack__agent_list_available
disable-model-invocation: true
---

List every agent configured in agent-rack and probe `$PATH` for its binary, via the
`mcp__agent-rack__agent_list_available` MCP tool.

## Execution

Call `mcp__agent-rack__agent_list_available` with no arguments.

## Output

Present each entry as `agentId` → `name` (`command`) → `status`
(`available` or `missing_binary`). If any agent shows `missing_binary`, mention that the user
needs to install that CLI for it to be usable via `/agent-rack:run` or `/agent-rack:review`
before suggesting anything further.
