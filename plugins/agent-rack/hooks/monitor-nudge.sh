#!/usr/bin/env bash
# PostToolUse hook: when an agent-rack MCP tool call spawns a background sub-agent session
# (agent_session_create, a *_run shortcut, or agent_review — the latter two only when called
# with background:true), inject a reminder to start a Monitor watching its status/tail — so a
# human sees live progress without depending on the model remembering to do it on its own.
#
# Stays silent (exit 0, no output) for anything that isn't a fresh, still-running session: a
# synchronous agent_run call, an unrelated tool, or malformed input all fall through harmlessly.

input=$(cat)
tool=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null)
inner=$(echo "$input" | jq -r '.tool_response[0].text // empty' 2>/dev/null)

if [ -z "$inner" ]; then
  exit 0
fi

sid=$(echo "$inner" | jq -r '.sessionId // empty' 2>/dev/null)
status=$(echo "$inner" | jq -r '.status // empty' 2>/dev/null)

if [ -z "$sid" ] || [ "$status" != "running" ]; then
  exit 0
fi

ctx="A background agent-rack session was just created via ${tool} (sessionId=${sid}, status=running). You MUST immediately start a Monitor watching agent-rack session status/tail for this sessionId (poll every ~2s, diff-based; stop once status is completed/failed/cancelled) so the user sees live progress in this chat. Do this now before anything else."

jq -n --arg ctx "$ctx" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
