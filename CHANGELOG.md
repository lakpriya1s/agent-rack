# Changelog

All notable changes to agent-rack are documented here.

This project is pre-1.0: minor versions may contain breaking changes, and they are called out
explicitly below.

## 0.9.0

### Changed

- **`enableSseSidecar` now defaults to `true`.** A stdio-transport process (the default —
  including the one Claude Code itself spawns) now opens the loopback SSE sidecar introduced in
  0.8.0 automatically, with no config change required. It is bearer-token gated the same way the
  standalone `sse` transport is (`security.requireSseAuth`, default `true`), so the marginal
  exposure over plain stdio is a loopback-only, token-protected listener — not an open port. Set
  `enableSseSidecar: false` to opt back out to pre-0.9.0 behavior.

### Added

- **The Claude Code plugin ships a `PostToolUse` hook** (`plugins/agent-rack/hooks/`) that fires
  whenever `agent_session_create` or a `*_run` shortcut launches a background session, nudging
  the model to start watching its status/tail live instead of relying on it to remember. Anyone
  with the plugin installed gets this automatically — no `.claude/settings.json` editing required.

## 0.8.0

### Added

- **Opt-in SSE sidecar for the stdio transport.** Setting `enableSseSidecar: true` makes a
  stdio-transport process (the default — e.g. the process Claude Code itself spawns) also open a
  loopback SSE listener on the exact same shared `SessionManager`, best-effort and non-fatal if
  the port is already taken. Sessions created over the stdio connection are then visible to any
  other local client — the dashboard, `agent-rack session status/tail`, or a polling shell
  loop — with no separate server to run and no change to the stdio client's own MCP registration.
  Defaults to `false`; existing configs and behavior are unchanged unless you opt in.

## 0.7.1

Two honesty/correctness fixes found by actually running 0.7.0 through the Claude Code plugin.

### Fixed

- **`supportsStreaming` no longer claims streaming the config doesn't provide.** It was hardcoded
  `true` for the `claude_stream_json` transport, but Claude Code only emits incremental events
  under `--output-format stream-json`. With the default `--output-format json` it buffers the whole
  run and emits one JSON object at exit — so a five-turn task produced a single event and
  `agent_session_logs` stayed empty the entire time it was working. The flag is now derived from
  the configured args (both `--output-format stream-json` and `--output-format=stream-json` are
  recognized). The default output format is unchanged: `stream-json` additionally requires
  `--verbose` and alters the event shape that `agent_review`'s JSON extraction depends on, so
  switching it is not a patch-level change.
- **The session log byte budget now measures the whole event.** `security.maxSessionOutputBytes`
  was computed from `content.length` alone, ignoring `metadata`, `input`, and `output`. Claude
  Code's final result event carries several KB of token/cost metadata against a few hundred
  characters of content, and tool events hold entire command payloads — so a session's real
  retained footprint could exceed the configured cap by roughly an order of magnitude. Sizes are
  now computed once per event and remembered, so eviction cannot drift from what was added, and a
  circular payload is accounted for rather than throwing mid-stream.

### Note

Version-pinning `plugins/agent-rack/.mcp.json` does not fully guarantee which build runs: `npx`
prefers an `agent-rack` already on `$PATH`, so a stale global install shadows the pin. If you have
one, upgrade it (`npm i -g agent-rack@latest`) or point the plugin at an absolute path.

## 0.7.0

A security and correctness release. Several previously-advertised capabilities did not match
runtime behaviour; this release makes the promises true, and changes some defaults to safer ones.

### Breaking changes

- **Sub-agents are no longer unsandboxed by default.** The default and example configs shipped
  `--dangerously-skip-permissions` (claude) and `--dangerously-bypass-approvals-and-sandbox`
  (codex), so every sub-agent ran with full authority before anyone chose that. Authority is now
  governed by the new `security.executionPolicy`, defaulting to `workspace-write`. To restore the
  previous behaviour explicitly, set:

  ```json
  { "security": { "executionPolicy": "danger-full-access" } }
  ```

  A per-call `mode` may narrow authority but is now **rejected** if it grants more than the
  configured policy, so the policy is a real ceiling rather than a default.

- **SSE transport now requires authentication.** `transport: "sse"` servers require a bearer
  token in addition to binding to loopback. agent-rack's own dashboard and `session` commands
  discover the token automatically; other clients must send it. Disable with
  `security.requireSseAuth: false` (the server warns loudly when you do). See
  [SECURITY.md](SECURITY.md).

- **`agent_session_create` no longer accepts `kind`.** Passing `kind: "review"` used to produce a
  session the dashboard *labelled* a review while it ran with ordinary write authority and none
  of a review's read-only protections. Only `agent_review` creates review sessions now.

- **`agent_session_logs` returns a page object, not an array.** The response is now
  `{ events, nextCursor, oldestCursor, totalEvents, droppedCount }`, and the `offset` parameter is
  replaced by `cursor` (monotonic) plus `tail`.

- **`sanitizeEnvironment()` takes an options object** instead of `(customEnv, sanitize)`. Only
  affects direct API consumers.

- **Session status `idle` removed** (it was never assigned) and `cancelling` added.

### Fixed

- **`agent_session_send` no longer fails for most agents.** It was advertised as a general
  capability, but non-PTY agents are spawned with `stdin: 'ignore'` and take their prompt as a
  command-line argument, so there was never a second turn to send to — every call failed with a
  misleading "stdin is unavailable". Transports now declare `supportsFollowUp`, and unsupported
  ones refuse up front with an explanation. Exposed via `agent_list_available`, session info, and
  `agent-rack agents`.
- **Session event counts no longer plateau.** `eventCount` was the retained buffer length, which
  pinned at 512 forever — so any watcher diffing it (including the `session status` polling flow)
  concluded the agent had gone idle exactly when it was busiest. It is now a monotonic total.
- **Sessions are no longer retained forever.** Every run, including synchronous `agent_run`, was
  kept in memory for the life of the process — an unbounded leak for a long-lived SSE server. Now
  pruned per `security.sessionRetentionMinutes` / `maxRetainedSessions`, with a new
  `agent_session_delete`.
- **The concurrency limit can no longer be overshot during cancellation.** A cancelled session
  reported `cancelled` immediately while its child lived on for up to 3s, and only `running`
  sessions counted toward the cap.
- **`agent_session_create` accepts `timeoutSeconds`**, which the README documented but the schema
  omitted.
- **A final unterminated output line is no longer lost.** Adapters now `flush()` at exit; for
  `claude --output-format json` that line was the entire response.
- **stderr no longer pollutes agent output.** It was parsed as protocol, so a warning could
  surface as agent text or corrupt a review's JSON. It is now recorded separately and surfaces
  only when there is no parseable output to explain a failure.
- **Codex tool results attach to the correct command.** Results were attributed to the most recent
  tool call, which is wrong when commands interleave; they now correlate by item id.
- **PTY output is no longer fragmented.** Chunks were split without buffering, so one logical line
  could arrive as several events with words cut in half.
- **Installer failures no longer report success.** Registration now returns a structured result and
  `install`/`setup` exit non-zero; the setup wizard previously printed "Done. Restart the
  client(s)" even when every registration had failed.
- **Registrations no longer point into an npx cache.** That path is evictable, producing a
  registration that works today and breaks later. Such installs now register a version-pinned
  `npx` invocation, and `process.execPath` replaces a bare `node` so GUI clients with a minimal
  PATH can find Node.
- **Plugin and marketplace versions matched neither each other's reality nor the package** (0.1.3
  vs 0.6.1). Now synced, with a test preventing drift, and the plugin's `npx` invocation pinned.
- **`isLoopbackHost`** correctly accepts bare IPv6 (`::1`) and the whole `127.0.0.0/8` range.

### Added

- `security.executionPolicy`: `read-only` | `workspace-write` | `danger-full-access`, translated
  into each CLI's real flags, with escape-hatch flags stripped under any lesser policy.
- Honest enforcement reporting: only codex ships a real OS-level sandbox, so
  `agent_list_available` and `agent-rack agents` report `policyWarning` where a policy is
  prompt-level best-effort rather than enforced.
- Per-agent `inheritEnv` allowlist, the only reliable way to keep a credential from a sub-agent.
  The denylist fallback now covers `*_API_KEY`, `*TOKEN*`, `AWS_*`, `GITHUB_*`, `NPM_*`, cookies,
  `DATABASE_URL`, `KUBECONFIG`, and more. Values are redacted from `config-check`.
- SSE bearer-token auth with `Origin` rejection and loopback-`Host` enforcement (DNS-rebinding
  defence); token published at mode `0600` and removed on shutdown.
- `agent_session_delete`, and byte-bounded session logs (`security.maxSessionOutputBytes`).
- Review hardening: `baseRef` is pattern-validated then resolved to a commit SHA before reaching
  the prompt; contradictory reviews (reversed line ranges, `approve` over critical findings) are
  normalized rather than discarded; untracked files are explicitly in scope.
- Atomic config writes (temp file + fsync + rename, with `.bak`).
- [SECURITY.md](SECURITY.md) with an explicit threat model, including what agent-rack does *not*
  defend against.

## 0.6.1 and earlier

See the [commit history](https://github.com/lakpriya1s/agent-rack/commits/main) and
[releases](https://github.com/lakpriya1s/agent-rack/releases).
