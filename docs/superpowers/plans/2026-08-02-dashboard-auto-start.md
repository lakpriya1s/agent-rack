# One-Command Shared Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npx agent-rack@latest dashboard` discover or own a loopback shared SSE server, safely configure Claude Code once, and manage owned shutdown without separate setup commands.

**Architecture:** Add a loaded-config server factory returning an explicit closeable handle, then place a focused dashboard coordinator between config loading and Ink. Isolate Claude CLI inspection/mutation behind injected argv execution and confirmation, and isolate quit semantics in a pure decision helper consumed by the TUI.

**Tech Stack:** TypeScript ESM, Node HTTP/Express, MCP SDK SSE transports, Ink/React, execa, Vitest, pnpm.

## Global Constraints

- Preserve the TTY guard as the first operation.
- Owned SSE listens on `127.0.0.1` only; explicit `--connect` is external-only.
- Pass the loaded `AgentMCPConfig` unchanged, especially `allowedWorkspaces`.
- No daemon, persistence, auth change, dependency, shell string, or security relaxation.
- Existing stdio/start behavior, workspace validation, review read-only enforcement, and `rawText` parsing remain unchanged.
- Tests never mutate real Claude configuration; PTY smoke sets the internal test-only setup-skip environment flag.
- Version moves from 0.4.0 to 0.5.0 using package and lockfile metadata.

---

### Task 1: Closeable loaded-config SSE server

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

**Interfaces:**
- Produces: `createServerContextFromConfig(config: AgentMCPConfig, filePath?: string | null): AgentMCPServerContext`
- Produces: `startSSEServer(ctx: AgentMCPServerContext, port: number): Promise<AgentMCPHTTPServer>`
- Produces: `AgentMCPHTTPServer { server: http.Server; url: string; close(): Promise<void> }`
- Preserves: `createServerContext(configPath?)`, `createAgentMCPServer(configPath?)`, and `startAgentMCPServer(options)` behavior.

- [ ] Write failing tests that construct config in memory, bind port 0 on loopback, connect a real `SSEClientTransport`, assert the exact config workspace is retained, close the handle, and rebind the released port.
- [ ] Add a failing occupied-port test using a real `net.Server`; race startup against a short timeout and assert prompt `EADDRINUSE` rejection.
- [ ] Run `pnpm vitest run src/server.test.ts` and record RED output.
- [ ] Extract context construction so loaded config is accepted without reloading or cloning:

```ts
export function createServerContextFromConfig(
  config: AgentMCPConfig,
  filePath: string | null = null
): AgentMCPServerContext
```

- [ ] Extract SSE startup into a promise that subscribes to both `listening` and `error` before `listen`, tracks sockets on `connection`, and exposes idempotent cleanup that destroys sockets and awaits `server.close`.
- [ ] Keep `startAgentMCPServer` as the compatibility wrapper and return its existing `http.Server | undefined` shape.
- [ ] Run the focused test and commit:

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(server): add closeable loaded-config SSE API" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2: Dashboard server coordinator

**Files:**
- Create: `src/cli/dashboard/serverCoordinator.ts`
- Create: `src/cli/dashboard/serverCoordinator.test.ts`
- Modify: `src/cli/dashboard/connection.ts`
- Modify: `src/cli/dashboard/connection.test.ts`

**Interfaces:**
- Consumes: `startSSEServer(createServerContextFromConfig(config), port)` and `DashboardRemoteClient`.
- Produces:

```ts
export type DashboardServerMode = 'auto-started' | 'existing';
export interface DashboardConnection {
  url: string;
  mode: DashboardServerMode;
  client: DashboardRemoteClient;
  close(): Promise<void>;
}
export async function coordinateDashboardServer(
  config: AgentMCPConfig,
  connectUrl?: string,
  deps?: DashboardCoordinatorDependencies
): Promise<DashboardConnection>
```

- [ ] Write real coordinator tests for no-server auto-start, cleanup releasing the port, existing-server connection without ownership, explicit URL external-only failure, and occupied/invalid listen failures.
- [ ] Assert tests use config with a sentinel `allowedWorkspaces` array and that the coordinator passes the same config object to the server factory.
- [ ] Run the focused test and record RED output.
- [ ] Replace obsolete “stdio requires separate SSE start” resolution with pure URL derivation: explicit URL or `http://127.0.0.1:${config.port ?? 8987}/sse` regardless of configured transport.
- [ ] Implement coordinator dependencies (`createClient`, `startServer`) with production defaults and deterministic cleanup on every partial failure.
- [ ] Format explicit connection failures without auto-start guidance; format owned listen failures as friendly port/listen messages.
- [ ] Run focused tests and commit:

```bash
git add src/cli/dashboard/connection.ts src/cli/dashboard/connection.test.ts src/cli/dashboard/serverCoordinator.ts src/cli/dashboard/serverCoordinator.test.ts
git commit -m "feat(dashboard): coordinate shared SSE server" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3: Safe one-time Claude Code setup

**Files:**
- Create: `src/cli/dashboard/claudeSetup.ts`
- Create: `src/cli/dashboard/claudeSetup.test.ts`

**Interfaces:**
- Produces:

```ts
export type ClaudeScope = 'local' | 'project' | 'user';
export interface ClaudeRegistration { exists: boolean; scope: ClaudeScope; url?: string }
export function parseClaudeMcpGet(stdout: string, stderr?: string): ClaudeRegistration;
export async function ensureClaudeDashboardRegistration(
  url: string,
  deps?: ClaudeSetupDependencies
): Promise<{ warning?: string; notice?: string }>;
```

- [ ] Write parser tests using representative text and JSON-ish `claude mcp get agent-rack` output for local/project/user scopes and SSE URLs, including missing registration and default-local fallback.
- [ ] Write orchestration tests with injected executor/confirm fakes for matching SSE no-op, decline, old registration removal, exact add argv, missing `claude`, remove failure, and add failure warnings.
- [ ] Assert exact mutation argv:

```ts
['mcp', 'remove', '--scope', scope, 'agent-rack']
['mcp', 'add', '--transport', 'sse', '--scope', scope, 'agent-rack', url]
```

- [ ] Run the focused test and record RED output.
- [ ] Implement argv-only execa execution, readline confirmation before Ink, and `AGENT_RACK_TEST_SKIP_CLAUDE_SETUP=1` as an internal no-mutation path.
- [ ] Return warnings on decline/missing/failure and a single restart/reconnect notice on successful replacement.
- [ ] Run focused tests and commit:

```bash
git add src/cli/dashboard/claudeSetup.ts src/cli/dashboard/claudeSetup.test.ts
git commit -m "feat(dashboard): configure Claude shared SSE access" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 4: Owned exit policy and visible lifecycle

**Files:**
- Create: `src/cli/dashboard/exitDecision.ts`
- Create: `src/cli/dashboard/exitDecision.test.ts`
- Modify: `src/cli/dashboard/App.tsx`
- Modify: `src/cli/dashboard/Footer.tsx`
- Modify: `src/cli/dashboard/Header.tsx` if status placement fits the existing header better.

**Interfaces:**
- Consumes: `DashboardServerMode` and `DashboardRemoteClient.cancelSession`.
- Produces a pure helper whose result is one of `exit`, `warn`, or `cancel-and-exit`, based on mode, whether exit is armed, and running session IDs.

- [ ] Write pure tests: existing mode exits immediately with no cancellation; owned/no-running exits; owned/first-q warns; owned/second-q returns all running IDs for cancellation.
- [ ] Run the focused test and record RED output.
- [ ] Implement the helper and wire `App.tsx` input handling so first `q` uses the existing status banner and second `q` awaits `Promise.allSettled(cancelSession(...))` before Ink exit.
- [ ] Add mode props and render uppercase `AUTO-STARTED` or `EXISTING`; owned mode visibly warns that the server stops when the dashboard closes.
- [ ] Preserve explicit `c` cancellation behavior and ensure external/existing dashboard shutdown never bulk-cancels.
- [ ] Run focused tests plus `pnpm typecheck`, then commit:

```bash
git add src/cli/dashboard/exitDecision.ts src/cli/dashboard/exitDecision.test.ts src/cli/dashboard/App.tsx src/cli/dashboard/Footer.tsx src/cli/dashboard/Header.tsx
git commit -m "feat(dashboard): guard owned server shutdown" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 5: Startup orchestration and failure cleanup

**Files:**
- Modify: `src/cli/dashboard/index.tsx`
- Add or modify: `src/cli/dashboard/index.test.ts`
- Modify: `src/cli/dashboard/tty.test.ts` only if guidance coverage requires injection hooks.

**Interfaces:**
- Consumes: `coordinateDashboardServer`, `ensureClaudeDashboardRegistration`, and `DashboardApp` lifecycle props.
- Preserves: `startDashboard(customConfigPath?, connectFlag?)` public API.

- [ ] Write startup tests with injected dependencies proving TTY check happens before config/setup/coordinator, setup runs only after reachability, warning/notice reaches render, and any setup/render failure closes owned client/server.
- [ ] Run the focused test and record RED output.
- [ ] Refactor `startDashboard` around one `try/finally`: TTY guard, exact config load, coordinate, setup, render/wait, then close connection.
- [ ] Ensure explicit `--connect` failures set non-zero exit and never invoke server start/stop; owned listen errors are friendly and prompt.
- [ ] Run dashboard-focused tests and commit:

```bash
git add src/cli/dashboard/index.tsx src/cli/dashboard/index.test.ts src/cli/dashboard/tty.test.ts
git commit -m "feat(dashboard): launch shared server in one command" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 6: README and 0.5.0 metadata

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify guidance tests that intentionally assert obsolete two-terminal instructions.

- [ ] Rewrite the README lead to show `npx agent-rack@latest dashboard` first.
- [ ] Document the one-time Claude confirmation and required restart/reconnect, owned lifetime, shared session visibility, and advanced `--connect` external mode.
- [ ] Remove obsolete primary instructions requiring separate `start`, manual port selection, config editing, or manual Claude MCP commands.
- [ ] Run `pnpm version 0.5.0 --no-git-tag-version` or make the exact package/lockfile metadata edits following the repository convention.
- [ ] Run guidance tests and commit:

```bash
git add README.md package.json pnpm-lock.yaml src/**/*.test.ts
git commit -m "docs: lead with one-command dashboard flow" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 7: Verification, PTY smoke, review, and report

**Files:**
- Create as required by the user: `/tmp/agent-rack-dashboard-auto-start-report.md`
- Modify production/tests only if verification reveals a defect; commit each correction conventionally.

- [ ] Run exact verification and capture unabridged summaries/exit codes:

```bash
pnpm test
pnpm typecheck
pnpm build
node bin/agent-rack.js --version
```

- [ ] Run a real PTY smoke without a separate server, setting only `AGENT_RACK_TEST_SKIP_CLAUDE_SETUP=1`; confirm `AUTO-STARTED`, send `q`, and verify process exit.
- [ ] Verify the smoke released port 8987 and no child process/server remains.
- [ ] Inspect `git diff main...HEAD`, confirm no changes to workspace validation, review read-only enforcement, review `rawText` parsing, dependencies, or non-dashboard stdio behavior.
- [ ] Run a skeptical code review, apply confirmed fixes, and rerun every affected focused/full command.
- [ ] Write `/tmp/agent-rack-dashboard-auto-start-report.md` with architecture, RED/GREEN evidence, exact verification/smoke outputs, changed files, self-review, and concerns.
- [ ] Confirm `git status --short` is clean and list commits since the task began.
