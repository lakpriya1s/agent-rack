# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`agent-rack` is an MCP (Model Context Protocol) server, published to npm, that exposes local CLI
AI coding agents (`claude`, `codex`, `opencode`, `agy`) as MCP tools, so any MCP client (Claude
Desktop, Cursor, Antigravity, VS Code) can spawn and drive them as sub-agents. The same package
also ships a Commander CLI, an ink/React terminal dashboard, and a Claude Code plugin
(`plugins/agent-rack`) with skills that wrap the tools.

## Commands

```bash
pnpm install
pnpm build          # tsc: compiles src/ -> dist/ (bin/agent-rack.js runs the compiled output)
pnpm dev            # tsx watch src/index.ts, for iterating without a build step
pnpm start          # tsx src/index.ts, one-shot run without a build

pnpm test           # vitest run — src/**/*.test.ts only (see vitest.config.ts)
pnpm test:watch     # vitest watch mode
pnpm typecheck       # tsc -p tsconfig.test.json — typechecks sources AND tests

# Run a single test file or test:
pnpm vitest run src/engine/review.test.ts
pnpm vitest run -t "extractAndValidateReview"

# Drive the thing you just changed:
node bin/agent-rack.js agents          # after a build; probes each configured binary on $PATH
node bin/agent-rack.js config-check    # prints the fully resolved effective config
node bin/agent-rack.js dashboard       # TUI; needs a real TTY
```

`pnpm build` (tsconfig.json) excludes `**/*.test.ts`, `docs`, and `src/test-helpers` from the
compiled output — tests never ship in `dist/`. `pnpm typecheck` (tsconfig.test.json) includes
everything under `src/**/*` so test files are still typechecked. Any ad-hoc demo/e2e script
must be excluded from `tsconfig.json` explicitly or it will break `pnpm build`.

`vitest.config.ts` deliberately pins `include: ['src/**/*.test.ts']` — without it, leftover
compiled `dist/**/*.test.js` from an earlier build runs every suite a second time. Consequence:
a test file named `*.test.tsx` is silently never run. Dashboard component tests are therefore
`.ts` files that import the `.tsx` components (see `src/cli/dashboard/App.test.ts`).

There is no lint script configured.

## Architecture

Layered, dependency direction flows one way: `config` → `security` → `adapters` → `engine` →
`tools` → `server` → `cli`. `src/index.ts` re-exports everything as the package's public API.

**config/** — `schema.ts` defines the zod schema for `agent-rack.config.json` (agents,
`allowedWorkspaces`, security settings) plus `DEFAULT_SSE_PORT`. `loader.ts` resolves config in
this precedence order: `$AGENT_RACK_CONFIG` env var → `./agent-rack.config.json` →
`~/.config/agent-rack/config.json` → a built-in default scoped to `process.cwd()` (this is
the zero-config path most end users hit — no file needed at all). The default config wires up
all four agents
(`agy`, `claude`, `opencode`, `codex`) with their real CLI flags, including each agent's
"escape hatch" flag that skips its own permission/sandbox prompts
(`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`).
`fingerprint.ts` hashes the canonicalized effective config (sorted keys, port defaulted) into
`sha256:<hex>` — the identity two processes compare to decide whether they are running the same
agent-rack (see the dashboard section).

**security/** — `workspace.ts` (`validateWorkspacePath`) is the *launch-directory* boundary:
every tool call resolves symlinks/realpaths and confirms the target is inside
`allowedWorkspaces` before any subprocess spawns, and callers spawn in the returned
`canonicalPath` so the child's cwd is exactly what was validated. It is not an OS sandbox — it
constrains where an agent starts, not what it can then reach; that is `policy.ts`'s job.
`policy.ts` owns `ExecutionPolicy` (`read-only` | `workspace-write` | `danger-full-access`) and
translates it per transport: `resolvePolicySupport` returns both the mode to pass *and*
`isNativelyEnforced` (true only for codex's real `--sandbox`, and claude's `plan`), so no caller
can accidentally promise enforcement a CLI does not provide; `resolveExecutionMode` rejects a
per-call `mode` that escalates past the policy (otherwise the policy would be advisory);
`applyExecutionPolicy` strips `ESCAPE_HATCH_ARGS` under any policy but `danger-full-access`.
`env.ts` (`sanitizeEnvironment`) takes an options object: a per-agent `inheritEnv` allowlist
wins when present (the only way to guarantee a secret never leaks), otherwise a broad pattern
denylist applies; it force-sets `PAGER=cat` and `CI=1`. `redactSensitiveEnv` is used wherever
config is rendered for a human. `auth.ts` is the SSE bearer-token layer: a per-process random
token published to `~/.config/agent-rack/runtime/sse-<port>.json` at mode 0600, plus
Origin-rejection and loopback-`Host` checks (the DNS-rebinding defence). It protects against
browser-origin and unauthenticated local requests; it explicitly does not isolate same-user
processes, and the docs must not claim otherwise.

**adapters/** — One `AgentAdapter` interface (`base.ts`), one implementation per transport
family, selected in `adapters/index.ts::createAdapter` by `AgentConfig.transport`:
- `claude.ts` (`claude_stream_json`) and `codex.ts` (`codex_exec_json`) parse newline-delimited
  JSON event streams from stdout.
- `agy.ts` (`agy_stream`) parses Antigravity's stream format.
- `pty.ts` (`pty_interactive`) drives a real pseudo-terminal via `node-pty` for CLIs
  (`opencode`) that only work interactively.

Every adapter turns a raw stream into `ParsedAgentEvent[]`, then `formatResponse` reduces those
into a `FormattedResult` with two distinct text fields that matter: `summary` (human-readable,
includes an appended "### Tool Calls Executed" block) and `rawText` (the agent's actual text
output, with nothing appended). `agent_review`'s JSON extraction always parses `rawText`, never
`summary` — the appended block would corrupt JSON parsing.

Each adapter also declares `capabilities` (`AgentCapabilities`) and implements `flush()`:
- `capabilities.followUp` is `'live' | 'resume' | 'none'`, and `supportsFollowUp` is just
  `followUp !== 'none'`. Only `pty_interactive` is `live` — the one transport with an open input
  channel. Do not "fix" the others by switching `stdin` to `'pipe'`: they take the prompt as argv,
  so nothing would read it.
  `claude_stream_json` and `codex_exec_json` are `resume`: their CLIs can rejoin a *specific*
  conversation in a fresh process (`claude --resume <session_id>`, `codex exec resume <thread_id>`),
  so a follow-up is a new turn, not a write. Both learn the id by **parsing it out of their own
  event stream** (`session_id` / `thread.started`) rather than assigning one up front — a
  transport name describes a protocol, not a binary, so a configured command may be a wrapper that
  rejects flags we invent (`node -e '…' --session-id <uuid>` fails with "bad option"). Never add a
  flag to the *first* turn's argv for this; only the follow-up may add one.
  `agy_stream` is `none`: its output never reveals a per-run conversation id, and `--continue`
  resumes the most recent conversation machine-wide, which misroutes follow-ups under concurrency.
- The two follow-up modes have **opposite status preconditions**, which `sendToSession` enforces:
  `live` requires the session still `running`; `resume` requires the current turn *finished*
  (a resume spawns a second child, and two must not run against one conversation). A `resume`
  follow-up calls `reopenForNextTurn()` — which clears `finishedAt`, since retention pruning
  measures age from it and a stale one could delete a session mid-turn — and counts against
  `maxConcurrentSessions` like any other spawn.
- `AgentProcessController.finalizeResult` formats only the events from that turn's start cursor.
  The ring buffer spans the whole session, so on a resumed conversation formatting `getAll()`
  would make each follow-up's result a growing concatenation of every previous turn.
- `flush()` drains the adapter's held-back line buffer at exit. A CLI that exits without a
  trailing newline would otherwise lose its final line — which for `claude --output-format json`
  is the entire response. `AgentProcessController.finalizeResult` must call it before formatting.
- stderr never goes through `parseChunk`. It is recorded as `status` events tagged
  `stream: 'stderr'` (so a warning line cannot surface as agent text or corrupt review JSON) and
  surfaces only via `describeEmptyResult` when there is no parseable output to explain a failure.
- Codex correlates `tool_result` back to its `tool_call` by `item.id`, not by "most recent call" —
  concurrent commands interleave, and last-wins attributed output to the wrong command.

**engine/** — `process.ts` (`AgentProcessController`) spawns the child (execa for stdio
transports, node-pty for `pty_interactive`), pipes chunks through the adapter, and enforces the
timeout. `isProcessLive()` tracks whether a child is actually alive, which is deliberately
*not* the same as the session's reported status (see the `cancelling` note below).
`buffer.ts` (`EventRingBuffer`) is what every session retains — a bounded tail, not a full
transcript — bounded by both an event count (512) and a byte budget, since one `tool_result` can
carry megabytes. It is addressed by **monotonic cursors**, not array offsets: `totalEvents()`
counts everything ever pushed and never plateaus, `getSince(cursor)` returns only what is new,
and `BufferedEventPage.droppedCount` reports a gap. This matters because `eventCount` used to be
the retained array length, which pinned at 512 forever — so any watcher diffing it concluded the
agent had gone idle exactly when it was busiest. `availability.ts` (`isBinaryAvailable`,
`listAgentAvailability`) probes configured binaries on `$PATH` and backs both the
`agent_list_available` tool and the `agent-rack agents` command, which differ only in rendering.
`session.ts` (`SessionManager`) owns session lifecycle for the async
`agent_session_*` tools: concurrency limits (`security.maxConcurrentSessions`), workspace
validation, and background promise tracking (session status flips as the underlying process
settles). Three subtleties:
- Status includes `cancelling` (running → cancelling → cancelled). Cancellation signals SIGINT
  and escalates to SIGKILL after 3s, so a "cancelled" child is not immediately gone;
  `activeProcessCount()` counts `cancelling` sessions and any with a live controller, otherwise
  the concurrency cap could be exceeded during that grace window. The previously-declared `idle`
  status was never assigned and has been removed.
- `pruneSessions()` runs on every `createSession`, dropping terminal sessions past
  `security.sessionRetentionMinutes` and trimming oldest-first to `maxRetainedSessions`. Every
  `agent_run` lands in this map too, so without pruning a long-lived SSE server leaks
  indefinitely. Running/cancelling sessions are never pruned.
- Sessions carry a `kind` of `task` or `review`, but **only `agent_review` may create a `review`**.
  `agent_session_create` no longer accepts `kind` at all: it used to, which produced a session the
  dashboard *labelled* a review while it ran with ordinary write authority and none of the
  read-only protections. The dashboard's review launcher now calls `agent_review` with
  `background: true` instead.

`shutdown()` cancels running sessions and awaits their promises —
`startSSEServer`'s `close()` calls it, so killing the server never leaves orphaned children.
`review.ts` holds the `agent_review` logic:
  - `buildReviewPrompt` composes scope (working-tree vs branch diff), stance (standard vs
    adversarial), and a fixed JSON contract instructing the agent to self-inspect via `git`
    rather than have the diff stuffed into the prompt.
  - Read-only enforcement now comes from `security/policy.ts` (the review always resolves at
    policy `read-only`), not from review-specific helpers. The prompt-level read-only
    instruction is always included regardless, and when the transport cannot enforce it the
    prompt says so explicitly rather than implying a guarantee.
  - `assertSafeGitRef` / `resolveBaseRefToSha`: `baseRef` is interpolated into a command the
    sub-agent is told to run, and that agent will likely run it through a shell — so the ref is
    pattern-validated and then resolved to a 40-hex commit SHA via `git rev-parse`, and only the
    SHA reaches the prompt. Never put a caller-supplied ref string in the prompt directly.
  - `normalizeReview` repairs self-contradictory output (reversed line ranges; an `approve`
    verdict above critical/high findings) instead of failing validation — rejecting would discard
    every finding and fall back to raw text, which is strictly worse.
  - `extractAndValidateReview` / `findValidReviewObject`: agents wrap their JSON reply in
    prose and/or markdown fences unpredictably, so extraction tries every fenced block plus
    the raw text, and within each candidate walks the last `}` backwards looking for a valid
    parse — this survives trailing prose after the JSON. Falls back to
    `{ parseError: true, raw: <text> }` rather than throwing, so a malformed reply never
    fails the tool outright.

**tools/** — `unified.ts` registers the core tools (`agent_list_available`, `agent_run`,
`agent_session_create|list|status|send|cancel|logs`, `agent_server_identity`) against
`SessionManager`. `agent_run` is just `createSession` + `waitForSession`, so foreground and
background runs share one code path. `review.ts` registers `agent_review` (short-circuits to
`verdict: "approve"` via `hasChangesToReview` if there's nothing to diff, before ever spawning
an agent). `shortcuts.ts` auto-generates a `<agentId>_run` tool per configured agent
(`claude_run`, `codex_run`, etc.) that forwards into the `agent_run` handler with `agent`
pre-filled. `args.ts` centralizes the arg-coercion helpers (`resolveWorkspace`,
`resolveTimeoutSeconds`, `requireAgentConfig`, `resolveModel`, `applyModelOverride`) shared
across tool handlers.

**server.ts** — The shared-state split is the important part. `createServerContextFromConfig`
builds the transport-independent `AgentMCPServerContext` **once**: the config, the single
`SessionManager`, and the merged tool registry (unified + shortcuts + review). `buildServer(ctx)`
then mints a fresh MCP `Server` per connection — one for stdio, one per SSE connection — all
sharing that one context. That is precisely why a session started by Claude Code is visible to
the dashboard and to `agent-rack session status` at the same time. `startSSEServer` returns a
closeable handle (`{ server, url, close }`) bound to `127.0.0.1`; `startAgentMCPServer` is the
CLI-facing entry that picks stdio vs sse and warns loudly on stderr when no config file was
found (because `allowedWorkspaces` then silently defaults to cwd).

**cli/index.ts** — Commander-based CLI (`bin/agent-rack.js` entry point): `start`, `setup`
(interactive wizard that detects installed clients and registers into each), `install` /
`uninstall` (`--target claude|codex|desktop|cursor|antigravity|opencode`, `--scope
project|user`), `config init`/`config-check`, `agents`, `snippet`, `cp` (alias `copy-skills`),
`session`, and `dashboard` (alias `ui`). Each client target has its own verified config shape and
path — Claude Code/Codex are registered by shelling out to their own `mcp add` CLIs, Claude
Desktop/Cursor/Antigravity share the `{ mcpServers: { name: { command, args } } }` shape at
different paths, and opencode uses `{ mcp: { name: { type, command: [argv...] } } }`.
`resolveBinPath()` resolves from `process.argv[1]` (the script Node actually ran), so `install`
and `snippet` produce correct paths under a local checkout, a global npm install, or `npx`
alike — regardless of cwd. `cli/version.ts` reads the version from `package.json` at runtime so
it can't drift from what's published.

**cli/skills.ts** — `agent-rack cp`: copies `plugins/agent-rack/skills/*` into another tool's
skills directory (per-client project/user paths in `KNOWN_TARGETS`), prefixing each with
`agent-rack-` to avoid collisions. `install --target cursor|antigravity` also calls this,
best-effort. So `plugins/agent-rack/skills/` is the single source of truth for skill content in
both the Claude Code plugin and every copied-out client.

**cli/session.ts** — `agent-rack session status|tail|list`: connect-only CLI commands (no
auto-start, unlike the dashboard) that poll an already-running `sse`-transport server via
`DashboardRemoteClient`, for driving background-session visibility from a plain shell script
(e.g. a Claude Code Monitor loop) that can't make MCP tool calls itself. `status` prints one
diffable line (status/eventCount/summary) to drive change detection; `tail` prints the most
recent event content (what the sub-agent is actually generating) once a change is detected —
deliberately two separate calls rather than one combined command, since polling should stay
cheap and only fetch content when something changed.

**cli/dashboard/** — An ink/React TUI (`.tsx` components, `jsx: react-jsx`). Its defining
property: the dashboard is an MCP **client**, never an owner of session state. It holds no
`SessionManager`; `remoteClient.ts` (`DashboardRemoteClient`) wraps an SSE MCP client and turns
every action into a tool call (`agent_session_create`, `..._logs`, `..._send`, `..._cancel`), so
what it displays is exactly what other clients see.
- `serverCoordinator.ts` decides where that client points. With `--connect <url>` it attaches to
  an external server and treats its config as authoritative. Without it, it probes the
  configured port: if something answers MCP, has all `REQUIRED_DASHBOARD_TOOLS`, and reports a
  matching `configFingerprint` via `agent_server_identity`, the dashboard reuses it; a mismatch
  is a hard error (rather than silently driving a differently-configured server); nothing
  listening means the dashboard auto-starts and owns an SSE server itself.
- `claudeSetup.ts` then offers to repoint Claude Code's own `agent-rack` MCP registration at
  that SSE URL (`claude mcp get` → parse → remove → `add --transport sse`), so Claude and the
  dashboard land on one shared server. It parses the existing registration first so it can
  restore it if the add fails, and refuses to touch registrations with settings it cannot
  safely reproduce.
- `exitDecision.ts` — quitting an auto-started dashboard with sessions still running requires
  pressing `q` twice (first press warns, second cancels and exits); an `existing` server is
  someone else's, so quitting just detaches.
- `tty.ts` guards on `stdin.isTTY` before any side effect, because ink's raw-mode requirement
  throws an unhelpful exception under pipes/CI/SSH-without-pty.
- Startup and coordination take injected dependency objects (`DashboardStartupDependencies`,
  `DashboardCoordinatorDependencies`) — that's how this is unit-tested without a terminal or a
  real server, and new logic should follow the same shape.

**plugins/agent-rack/** — The Claude Code plugin: `.mcp.json` points at `npx -y agent-rack
start`, and `skills/` holds nine command skills (`setup`, `agents`, `run`, `review`,
`session-start|status|logs|send|cancel`) plus two auto-activated guidance skills
(`tool-selection`, `review-handling`). `.claude-plugin/marketplace.json` at the repo root lists
it. Plugin/marketplace versions are their own thing, independent of `package.json`'s version,
but must match each other.

## Key invariants to preserve

- Every code path that spawns a subprocess must go through `validateWorkspacePath` first, and
  spawn in the `canonicalPath` it returns. This stops a client pointing an agent at a directory
  outside `allowedWorkspaces`; it is *not* an OS sandbox, and no doc may describe it as one.
- Authority is decided in one place. Tools must resolve an agent config through
  `tools/args.ts::resolveExecution`, never by reading `config.agents[id]` and spawning directly —
  that is what let escape-hatch flags be stripped in `agent_review` and honoured in `agent_run`.
  A per-call `mode` may narrow authority but never exceed `security.executionPolicy`.
- `danger-full-access` is the only policy under which an escape-hatch flag reaches a CLI. Never
  add a `--dangerously-*` flag to a default or example config; the policy layer supplies it.
- Never claim enforcement a CLI does not provide. If you add a transport, set
  `supportsNativeReadOnly`/`isNativelyEnforced` honestly and add a `describeUnenforcedPolicy`
  case; "we passed a flag" is not "the OS enforces it".
- `eventCount` in `AgentSessionInfo` is the monotonic total, never the retained buffer length.
  Anything used for change detection must not plateau.
- `agent_session_send` must branch on `adapter.capabilities.followUp` before touching anything —
  refusing `none` on capability (a permanent property) before status (a transient one), writing to
  the process only for `live`, and spawning a resumed turn only for `resume`. Never report a
  follow-up mode a CLI cannot actually honour: `resume` requires a way to rejoin *that specific*
  conversation, not merely a `--continue`-style flag.
- Only `agent_review` may create a session with `kind: 'review'`.
- One `AgentMCPServerContext` (and therefore one `SessionManager`) per process, shared by every
  connection. Anything that constructs its own `SessionManager` for a live server breaks
  cross-client session visibility — the dashboard and `session` CLI both depend on it.
- `agent_review` must stay read-only both natively (transport mode + stripped escape-hatch
  flags) and via the explicit prompt instruction — never rely on just one.
- JSON review parsing reads `FormattedResult.rawText`, not `.summary`.
- `agent_server_identity`'s shape is versioned (`identityVersion: 1`) and validated strictly by
  `DashboardRemoteClient.validateDashboardServer`. Changing the config schema changes every
  fingerprint, which is intended; changing the identity payload shape requires updating both
  sides together.
- Test files must be `*.test.ts` (never `.test.tsx`) or vitest will not pick them up.
- Skill content lives only in `plugins/agent-rack/skills/` — it is consumed by the plugin, by
  `agent-rack cp`, and by `install`, and is listed in `package.json#files`.
- New agent transports need: a schema entry in `AgentTransportTypeSchema`, an adapter
  implementing `AgentAdapter` (including `capabilities` and `flush()`), a `case` in
  `createAdapter`, a branch in `security/policy.ts::resolvePolicySupport`, and — if it has a
  permission-skip flag — an entry in `ESCAPE_HATCH_ARGS`.
- Plugin and marketplace versions must equal `package.json`'s; `src/cli/versionSync.test.ts`
  enforces it (they had silently drifted 0.1.3 vs 0.6.1 before it existed).
- Client config files are written via `writeJsonFileAtomic` (temp file + fsync + rename, with a
  `.bak`), never `writeFileSync` — a partial write leaves a client unable to start.
- Installer functions return `InstallationResult`; `install`/`setup` set a non-zero exit code on
  failure. Never print an error and return success.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
