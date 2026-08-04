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

# Placeholders rather than direct interpolation: the template is a quoted heredoc so that the
# loop's own $cur/$prev survive into the instruction instead of being expanded here.
#
# `read -d ''` rather than `$(cat <<'EOF')`: bash 3.2 (still /bin/bash on macOS) re-parses a
# heredoc inside command substitution, where a stray apostrophe reads as an unterminated quote
# and the whole hook dies with a syntax error. `read` returns non-zero at EOF, hence `|| true`.
read -r -d '' template <<'TEMPLATE' || true
A background agent-rack session was just created via __TOOL__ (sessionId=__SID__,
status=running). You MUST start a Monitor on it now, before anything else, so the user sees live
progress in this chat.

Emit BOTH the status line and the session's recent output on every change. Status alone is just a
rising event count, which tells the user nothing about what the sub-agent is actually doing:

prev=""
while :; do
  # Truncated: the status line embeds the session summary, which on completion is the agent's
  # entire reply. The diffable fields (status, event count) are at the front.
  cur=$(agent-rack session status __SID__ 2>&1)
  cur=${cur:0:200}
  if [ "$cur" != "$prev" ]; then
    echo "$cur"
    agent-rack session tail --count 3 __SID__ 2>&1
    prev="$cur"
  fi
  case "$cur" in *status=completed*|*status=failed*|*status=cancelled*|*rror*) break ;; esac
  sleep 2
done

Poll every ~2s and stop once status is completed/failed/cancelled (the loop above already does).
If `agent-rack` is not on PATH, use `npx -y agent-rack` or a local `node bin/agent-rack.js`.
TEMPLATE

ctx=${template//__SID__/$sid}
ctx=${ctx//__TOOL__/$tool}

jq -n --arg ctx "$ctx" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
