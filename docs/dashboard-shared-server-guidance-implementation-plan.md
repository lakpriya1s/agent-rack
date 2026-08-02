# Simpler Shared-Dashboard Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's vague shared-server errors with accurate copy-paste commands and explain how to inspect private stdio sessions through existing MCP tools.

**Architecture:** Keep the current stdio and SSE lifecycles unchanged. Centralize actionable shared-dashboard help in `connection.ts`, consume it from both startup failure paths, and update README guidance.

**Tech Stack:** TypeScript, Commander CLI, Ink dashboard startup, Vitest, Markdown.

## Global Constraints

- Keep normal Claude Code stdio setup automatic and unchanged.
- Do not auto-start servers, write configuration, register MCP clients, or add dependencies.
- Use the shared SSE default port `8987`.
- Preserve `--connect` precedence, the TTY guard, workspace validation, and non-zero failure exits.
- New relative imports use ESM `.js` extensions.

---

### Task 1: Centralize and display actionable shared-dashboard guidance

**Files:**
- Modify: `src/cli/dashboard/connection.ts`
- Modify: `src/cli/dashboard/connection.test.ts`
- Modify: `src/cli/dashboard/index.tsx`
- Modify: `README.md`

**Interfaces:**
- Produces: `formatSharedDashboardHelp(serverUrl?: string): string`.
- Consumes: `DEFAULT_SSE_PORT`, `resolveDashboardServerUrl`, and existing startup preflight.

- [ ] **Step 1: Write failing guidance tests**

Extend the connection import and stdio test, then add a custom-URL test:

```typescript
import { formatSharedDashboardHelp, resolveDashboardServerUrl } from './connection.js';

it('returns copy-paste shared-server commands and private-stdio MCP guidance', () => {
  const config = getDefaultConfig();
  config.transport = 'stdio';
  const result = resolveDashboardServerUrl(config, undefined);

  expect('error' in result).toBe(true);
  if ('error' in result) {
    expect(result.error).toContain(
      'npx agent-rack@latest start --transport sse --port 8987'
    );
    expect(result.error).toContain(
      'npx agent-rack@latest dashboard --connect http://localhost:8987/sse'
    );
    expect(result.error).toContain('agent_session_list');
    expect(result.error).toContain('private stdio');
  }
});

it('preserves a custom URL in connection guidance', () => {
  const help = formatSharedDashboardHelp('http://localhost:9999/sse');
  expect(help).toContain('npx agent-rack@latest start --transport sse --port 9999');
  expect(help).toContain(
    'npx agent-rack@latest dashboard --connect http://localhost:9999/sse'
  );
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm vitest run src/cli/dashboard/connection.test.ts`

Expected: FAIL because `formatSharedDashboardHelp` does not exist and the current stdio error lacks the commands and MCP guidance.

- [ ] **Step 3: Implement the shared formatter**

In `connection.ts`, export a formatter that defaults to the loopback URL and derives the local port safely:

```typescript
const DEFAULT_DASHBOARD_URL = `http://localhost:${DEFAULT_SSE_PORT}/sse`;

export function formatSharedDashboardHelp(
  serverUrl: string = DEFAULT_DASHBOARD_URL
): string {
  let startInstruction = `Ensure the shared MCP server at ${serverUrl} is running.`;

  try {
    const parsed = new URL(serverUrl);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
      const port = parsed.port || String(DEFAULT_SSE_PORT);
      startInstruction = [
        'Terminal 1:',
        `  npx agent-rack@latest start --transport sse --port ${port}`,
      ].join('\n');
    }
  } catch {
    // The MCP client reports malformed URLs during connection; preserve the value in guidance.
  }

  return [
    'The dashboard is optional and requires a shared SSE server.',
    '',
    startInstruction,
    '',
    'Terminal 2:',
    `  npx agent-rack@latest dashboard --connect ${serverUrl}`,
    '',
    'Only sessions created through that SSE server—or by MCP clients configured to its URL—appear in the dashboard.',
    '',
    'For sessions in your normal private stdio setup, ask Claude Code to use',
    'agent_session_list, agent_session_status, or agent_session_logs.',
  ].join('\n');
}
```

Use `formatSharedDashboardHelp()` as the stdio resolution error.

- [ ] **Step 4: Reuse the formatter for connection failures**

In `dashboard/index.tsx`, import the formatter and replace the current generic startup instruction with:

```typescript
console.error(
  `Could not reach the agent-rack server at ${resolution.url}.\n\n` +
    `${formatSharedDashboardHelp(resolution.url)}\n\n` +
    `Connection error: ${err instanceof Error ? err.message : String(err)}`
);
```

Keep the existing exit code and `remoteClient.close()` behavior.

- [ ] **Step 5: Update README**

In the dashboard section, add a normal-stdio paragraph before the shared workflow:

```markdown
For normal Claude Code usage, no server command is required: Claude Code starts its private
agent-rack stdio process automatically. Ask Claude Code to use `agent_session_list`,
`agent_session_status`, or `agent_session_logs` to inspect those sessions.

The terminal dashboard is optional. To use it, start shared mode with these copy-paste commands:

```sh
# Terminal 1
npx agent-rack@latest start --transport sse --port 8987

# Terminal 2
npx agent-rack@latest dashboard --connect http://localhost:8987/sse
```
```

Retain the warning that only clients configured to the same SSE URL share sessions.

- [ ] **Step 6: Verify focused and full checks**

Run:

```bash
pnpm vitest run src/cli/dashboard/connection.test.ts
pnpm test
pnpm typecheck
pnpm build
```

Expected: all checks pass with no warnings.

- [ ] **Step 7: Commit**

```bash
git add src/cli/dashboard/connection.ts src/cli/dashboard/connection.test.ts src/cli/dashboard/index.tsx README.md
git commit -m "fix(dashboard): show actionable shared-server guidance"
```
