# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`agent-rack` is an MCP (Model Context Protocol) server, published to npm, that exposes local CLI
AI coding agents (`claude`, `codex`, `opencode`, `agy`) as MCP tools, so any MCP client (Claude
Desktop, Cursor, Antigravity, VS Code) can spawn and drive them as sub-agents.

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
```

`pnpm build` (tsconfig.json) excludes `**/*.test.ts`, `docs`, and `src/test-helpers` from the
compiled output — tests never ship in `dist/`. `pnpm typecheck` (tsconfig.test.json) includes
everything under `src/**/*` so test files are still typechecked. Any ad-hoc demo/e2e script
must be excluded from `tsconfig.json` explicitly or it will break `pnpm build`.

There is no lint script configured.

## Architecture

Layered, dependency direction flows one way: `config` → `security` → `adapters` → `engine` →
`tools` → `server`. `src/index.ts` re-exports everything as the package's public API.

**config/** — `schema.ts` defines the zod schema for `agent-rack.config.json` (agents,
`allowedWorkspaces`, security settings). `loader.ts` resolves config in this precedence order:
`$AGENT_RACK_CONFIG` env var → `./agent-rack.config.json` →
`~/.config/agent-rack/config.json` → a built-in default scoped to `process.cwd()` (this is
the zero-config path most end users hit — no file needed at all). The default config wires up
all four agents
(`agy`, `claude`, `opencode`, `codex`) with their real CLI flags, including each agent's
"escape hatch" flag that skips its own permission/sandbox prompts
(`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`).

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
timeout. `session.ts` (`SessionManager`) owns session lifecycle for the async
`agent_session_*` tools: concurrency limits (`security.maxConcurrentSessions`), workspace
validation, and background promise tracking (session status flips as the underlying process
settles). `review.ts` holds the `agent_review` logic:
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
`agent_session_*`) against `SessionManager`. `review.ts` registers `agent_review` (short-
circuits to `verdict: "approve"` via `hasChangesToReview` if there's nothing to diff, before
ever spawning an agent). `shortcuts.ts` auto-generates a `<agentId>_run` tool per configured
agent (`claude_run`, `codex_run`, etc.) that forwards into the `agent_run` handler with `agent`
pre-filled. `args.ts` centralizes the arg-coercion helpers (`resolveWorkspace`,
`resolveTimeoutSeconds`, `requireAgentConfig`) shared across tool handlers.

**server.ts** — Wires config + `SessionManager` into an MCP `Server`, merges all three tool
groups into one dispatch map, and serves over stdio or HTTP-SSE (`config.transport`).

**cli/index.ts** — Commander-based CLI (`bin/agent-rack.js` entry point): `start`, `install`
(registers agent-rack with Claude Code CLI or Claude Desktop via their respective config
mechanisms), `config init`/`config-check`, `agents` (checks each configured binary against
`$PATH`), `snippet`. `resolveBinPath()` resolves from `process.argv[1]` (the script Node
actually ran), so `install` and `snippet` produce correct paths under a local checkout, a global
npm install, or `npx` alike — regardless of cwd.

## Key invariants to preserve

- Every code path that spawns a subprocess must go through `validateWorkspacePath` first —
  this is the entire security boundary against a client pointing an agent outside
  `allowedWorkspaces`.
- `agent_review` must stay read-only both natively (transport mode + stripped escape-hatch
  flags) and via the explicit prompt instruction — never rely on just one.
- JSON review parsing reads `FormattedResult.rawText`, not `.summary`.
- New agent transports need: a schema entry in `AgentTransportTypeSchema`, an adapter
  implementing `AgentAdapter`, a `case` in `createAdapter`, and (if it has a permission-skip
  flag) an entry in `ESCAPE_HATCH_ARGS` and `getReadOnlyMode` in `engine/review.ts`.
