---
name: review-handling
description: Internal guidance for presenting agent-rack's agent_review output back to the user. Use whenever an agent_review call (foreground or via agent_session_status) returns a result.
user-invocable: false
---

# Presenting agent_review output

`agent_review` (and background review sessions surfaced via `agent_session_status`'s `review`
field) return a structured object, not free text. Handle it consistently:

- Present `verdict` and `summary` first, then `findings` ordered by `severity`
  (critical → high → medium → low), then `next_steps`.
- Use the `file`/`line_start`/`line_end` fields exactly as returned. `0` means whole-file,
  deleted-file, or architectural — not a real line number; don't imply otherwise.
- If `parseError: true`, the sub-agent's reply couldn't be validated against the review schema.
  Say so explicitly and show the `raw` text rather than inventing a verdict from it.
- If `verdict: "approve"` and `summary` is exactly `"Nothing to review."`, that means agent-rack
  short-circuited before even spawning an agent (no diff existed) — say there was nothing to
  review, don't imply a review actually ran.
- Read-only means read-only: agent_review never modifies files, regardless of `adversarial`.

## Critical: never auto-fix

After presenting findings, stop. Do not make any code changes, apply patches, or treat findings
as an implicit task list. Explicitly ask the user which findings, if any, they want addressed
before touching a single file — even when a fix looks obvious or trivial. This applies whether
the review ran via `/agent-rack:review` or was triggered as part of a larger task.
