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

**security/** — `workspace.ts` (`validateWorkspacePath`) is the sandboxing boundary: every tool
call resolves symlinks/realpaths and confirms the target is inside `allowedWorkspaces` before
any subprocess spawns. `env.ts` (`sanitizeEnvironment`) strips env vars matching
secret/password/token patterns before they reach a child process, and force-sets `PAGER=cat`
and `CI=1` so agent CLIs behave non-interactively.

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

**engine/** — `process.ts` (`AgentProcessController`) spawns the child (execa for stdio
transports, node-pty for `pty_interactive`), pipes chunks through the adapter, and enforces the
timeout. `buffer.ts` (`EventRingBuffer`, 512 events) is what every session retains — session
logs are a bounded tail, not a full transcript. `availability.ts` (`isBinaryAvailable`,
`listAgentAvailability`) probes configured binaries on `$PATH` and backs both the
`agent_list_available` tool and the `agent-rack agents` command, which differ only in rendering.
`session.ts` (`SessionManager`) owns session lifecycle for the async
`agent_session_*` tools: concurrency limits (`security.maxConcurrentSessions`), workspace
validation, and background promise tracking (session status flips as the underlying process
settles). Sessions carry a `kind` of `task` or `review`; a `review` session parses its result
into `ReviewOutput` on completion, which is how the dashboard's review view gets structured
data for background reviews. `shutdown()` cancels running sessions and awaits their promises —
`startSSEServer`'s `close()` calls it, so killing the server never leaves orphaned children.
`review.ts` holds the `agent_review` logic:
  - `buildReviewPrompt` composes scope (working-tree vs branch diff), stance (standard vs
    adversarial), and a fixed JSON contract instructing the agent to self-inspect via `git`
    rather than have the diff stuffed into the prompt.
  - `getReadOnlyMode` / `stripEscapeHatchArgs`: native read-only enforcement is transport-
    specific (`--sandbox read-only` for codex via mode, `--permission-mode plan` for claude);
    since the default agent configs include escape-hatch flags that would otherwise nullify
    this, those flags are stripped for review runs specifically. The prompt-level read-only
    instruction is always included regardless, since native enforcement varies by CLI version.
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

- Every code path that spawns a subprocess must go through `validateWorkspacePath` first —
  this is the entire security boundary against a client pointing an agent outside
  `allowedWorkspaces`.
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
  implementing `AgentAdapter`, a `case` in `createAdapter`, and (if it has a permission-skip
  flag) an entry in `ESCAPE_HATCH_ARGS` and `getReadOnlyMode` in `engine/review.ts`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
