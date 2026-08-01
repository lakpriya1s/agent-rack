# Design: `agent_review` — structured code review tool

**Date**: 2026-08-01
**Status**: Approved for implementation

## Context

`openai/codex-plugin-cc` is a Claude Code plugin that wraps the Codex CLI with
slash commands for review (`/codex:review`, `/codex:adversarial-review`),
session continuation (`/codex:rescue`), session handoff (`/codex:transfer`),
and job control (`/codex:status`, `/codex:result`, `/codex:cancel`), plus a
`Stop` hook that can gate session end on a pending review.

`agent-mcp` is a different kind of tool: a generic MCP server exposing
`agent_run` / `agent_session_*` / per-agent shortcut tools (`claude_run`,
`codex_run`, `opencode_run`, `agy_run`) to *any* MCP client — not just Claude
Code. The goal is to bring comparable capability to agent-mcp, starting with
the highest-value, most self-contained piece: **structured code review**.

This spec covers review only. Two further features were identified and
deliberately deferred to their own design/plan cycles so this slice stays
focused:

- **Session rescue/resume** — continuing or restarting a background session
  against the same task, building on `agent_session_*`.
- **Session transfer (handoff)** and a **Claude Code plugin + skills layer**
  on top of the MCP server (slash commands, hooks, a prompting-guide skill
  per agent) — this should be designed last, once the core tool surface
  (review, rescue) it wraps actually exists.

## Goals

- Any configured agent (claude, codex, opencode, agy) can run a read-only
  code review over either the working tree or a branch diff against a base
  ref.
- Review output is a validated, structured JSON object (verdict, findings
  with severity/file/line, next steps) — not just free text — so callers can
  filter, sort, and render it programmatically.
- Support an "adversarial" mode that reframes the review as a skeptical,
  ship/no-ship challenge of the design, with optional steering text.
- Support both synchronous (blocks until done) and background (via the
  existing session manager) execution.

## Non-goals

- Rescue/resume, session transfer, job-control UX polish, and the Claude
  Code plugin/skills layer (deferred — see Context).
- Guaranteed read-only enforcement for every transport. `codex_exec_json`
  and `claude_stream_json` have native read-only/plan modes; `agy_stream`
  and `pty_interactive` do not, and get best-effort prompt-level enforcement
  only (see Read-only enforcement below).
- Hardening against adversarial *input*. `baseRef` and `focus` are
  interpolated into the review prompt verbatim. This is not a shell-injection
  risk — git is always invoked via `execa` argv arrays, never through a shell —
  but it is a prompt-injection surface (a crafted `focus` can restate the
  agent's instructions). Named here for a future adversarial-input pass.

## Architecture

New files:
- `src/engine/review.ts` — prompt construction, the `ReviewOutputSchema`
  (zod), read-only mode mapping per transport, the git pre-check, and output
  parsing/validation. Kept separate from `unified.ts` so that file doesn't
  keep growing and this logic is independently testable.
- `src/tools/review.ts` — the `agent_review` MCPToolDefinition, following the
  same shape as `registerUnifiedTools`/`registerShortcutTools`.

Modified files:
- `src/server.ts` — register the new tool alongside the existing two.
- `src/engine/session.ts` — `AgentSession` gets an optional `kind: 'task' |
  'review'` tag and an optional `reviewResult` field; `SessionManager.
  createSession` accepts an optional `kind` and, when `kind === 'review'`,
  parses/validates the result once the underlying process resolves.
  `AgentSessionInfo` gets an optional `review` field. This is additive —
  existing task sessions are unaffected (`kind` defaults to `'task'`,
  `review` is absent).

## Tool contract: `agent_review`

| param | type | default | notes |
|---|---|---|---|
| `agent` | string | — (required) | target agent id |
| `workspace` | string | first allowed workspace | |
| `scope` | `'working-tree' \| 'branch'` | `'working-tree'` | |
| `baseRef` | string | — | required when `scope === 'branch'` |
| `adversarial` | boolean | `false` | switches prompt framing |
| `focus` | string | — | steering text; only meaningful when `adversarial` is true |
| `background` | boolean | `false` | `false` → sync via `AgentProcessController.runSync`; `true` → via `SessionManager` |
| `timeoutSeconds` | number | server default (600) | |

## Data flow

1. **Git pre-check** (server-side, cheap, no agent spawn): via `execa` in the
   workspace —
   - `scope: 'working-tree'` → `git status --short --untracked-files=all`
     (this alone already covers staged, unstaged, and untracked changes).
   - `scope: 'branch'` → `git diff --shortstat <baseRef>...HEAD`.
   - If everything is empty, short-circuit: return
     `{verdict: 'approve', summary: 'Nothing to review.', findings: [],
     next_steps: []}` without spawning the agent.
2. **Prompt construction**: instruct the agent to inspect the diff *itself*
   (it already has shell/tool access in its workspace) rather than embedding
   the diff text in the prompt — avoids blowing the context window on large
   diffs and avoids duplicating diff logic per adapter. The prompt states
   the scope (working tree, or branch vs. `baseRef`), the read-only
   constraint, and the JSON output contract (schema below, embedded as
   text — MCP has no native structured-output enforcement across arbitrary
   CLI agents). Adversarial mode swaps in a skepticism/attack-surface
   framing (challenge the design, prioritize auth/data-loss/race-condition/
   rollback-safety classes of issues) and appends `focus` text if present.
3. **Read-only enforcement**, mapped per adapter transport:
   - `codex_exec_json` → `mode: 'read-only'` (native `--sandbox` flag,
     `src/adapters/codex.ts:19`).
   - `claude_stream_json` → `mode: 'plan'` (native `--permission-mode` flag,
     `src/adapters/claude.ts`; note the adapter originally emitted `--mode`,
     which Claude Code rejects outright).
   - `agy_stream` / `pty_interactive` → no native flag; rely on an explicit
     "you must not modify any files" instruction in the prompt. Documented
     as a known limitation, not silently assumed safe.

   **Escape-hatch stripping.** The default agent configs carry unconditional
   escape-hatch flags (`--dangerously-skip-permissions` for claude,
   `--dangerously-bypass-approvals-and-sandbox` for codex) so ordinary
   `agent_run` tasks can edit files. Left in place, those flags nullify the
   read-only flag `agent_review` adds — the CLIs accept both without a parser
   error and the bypass wins. `stripEscapeHatchArgs` (`src/engine/review.ts`)
   therefore removes the transport's escape-hatch flag from a *copy* of the
   agent config whenever a native read-only mode is requested, so enforcement
   is actually effective rather than silently nullified. The configured agent
   entry is never mutated, and the override applies to that review run only
   (sync via the adapter/controller, background via
   `SessionManager.createSession`'s `agentConfigOverride` option).

   The explicit "MUST be read-only" prompt instruction is *always* included,
   even when a native mode is in play — native enforcement varies by transport
   and CLI version, so prompt-level enforcement is never dropped.
4. **Execution**:
   - `background: false` → fresh `AgentProcessController.runSync`, same
     pattern as `agent_run`. Parse/validate synchronously, return the
     structured result.
   - `background: true` → `sessionManager.createSession(agentId, prompt,
     workspace, mode, { kind: 'review', timeoutSeconds, agentConfigOverride })`.
     When the session's process resolves, `SessionManager` parses/validates
     `result.rawText` and stores it on `session.reviewResult`.
     `agent_session_status` surfaces it via `getInfo().review`.
5. **Output validation**: `ReviewOutputSchema` (zod) —
   ```
   verdict: 'approve' | 'needs-attention'
   summary: string (non-empty)
   findings: Array<{
     severity: 'critical' | 'high' | 'medium' | 'low'
     title: string
     body: string
     file: string
     line_start: number (>= 0; 0 = whole-file / no specific line)
     line_end: number (>= 0; 0 = whole-file / no specific line)
     confidence: number (0-1)
     recommendation: string
   }>
   next_steps: string[]
   ```
   Extraction runs against `result.rawText`, **not** `result.summary`: the
   claude and codex adapters append a `### Tool Calls Executed` block (with
   JSON-stringified tool inputs) to `summary`, and the review prompt
   guarantees the agent runs git commands, so `summary` always carries that
   trailing block. `rawText` is built purely from `text` events in all four
   adapters.

   Extraction itself is tolerant rather than a single first-`{`/last-`}`
   slice: every markdown-fenced block is tried as a candidate first, then the
   whole raw text; within each candidate the closing brace is walked backwards
   from the last `}`, and the first substring that both `JSON.parse`s and
   passes `ReviewOutputSchema.safeParse` wins. This recovers the payload from
   leading/trailing prose, multiple fenced blocks, and appended tool-call
   noise. If nothing validates, the parse-error fallback applies.

## Error handling

- Schema validation failure does **not** throw. Return
  `{verdict: 'needs-attention', summary: <raw text>, findings: [],
  next_steps: [], parseError: true, raw: <raw text>}` — the caller still
  gets the review content and an explicit signal that structured fields
  aren't reliable this run, instead of a silent empty result or a crash.
- Timeout/cancellation reuse `AgentProcessController`'s existing behavior
  unchanged.
- Git pre-check failures (e.g., not a git repo, bad `baseRef`) surface as a
  normal tool error via the existing `try/catch` in `server.ts`'s
  `CallToolRequestSchema` handler.
- Session-manager concurrency limits (`maxConcurrentSessions`) apply to
  review sessions exactly as they do to task sessions — no special-casing.

## Testing

- `src/engine/review.test.ts`: prompt construction (normal vs. adversarial
  vs. focus text present/absent), read-only mode mapping per transport,
  schema validation (valid JSON, invalid JSON → parse-failure fallback),
  git pre-check short-circuit (mocked `execa`).
- `src/tools/review.test.ts`: fake CLI fixture emitting a valid review JSON
  blob (mirroring `adapters.test.ts` conventions) verifying the tool returns
  structured content for both sync and background paths; a background-mode
  test verifying `agent_session_status` includes the parsed `review` field
  once the session completes.

## Roadmap (not in this slice)

1. **This spec** — `agent_review` (sync + background, structured output).
2. **Session rescue/resume** — own design cycle, building on
   `agent_session_*` and the `kind` tagging pattern introduced here.
3. **Session transfer + Claude Code plugin/skills layer** — a companion
   Claude Code plugin (marketplace.json, slash commands like
   `/agent-mcp:review`, `/agent-mcp:rescue`, hooks, a prompting-guide skill
   per agent) that wraps whatever core MCP tools exist by then. Designed
   last, once rescue exists, so the plugin has a stable surface to wrap.
