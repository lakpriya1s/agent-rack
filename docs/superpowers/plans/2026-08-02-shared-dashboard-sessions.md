# Shared Dashboard Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agent-rack dashboard` observe sessions created by any MCP client (Claude Code, Codex CLI, etc.) by turning it into a client of one persistent shared server, instead of each process owning disconnected in-memory session state.

**Architecture:** One persistent `agent-rack start --transport sse --port <p>` process holds the single `SessionManager`. The dashboard drops its local `SessionManager` and becomes an MCP client of that same server (via the SDK's `Client` + `SSEClientTransport`), polling a new `agent_session_list` tool plus the existing per-session tools. The SSE server itself is upgraded from single-client to multi-client (one `Server` instance per connection, sharing the one `SessionManager`).

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (server + client transports, already a dependency), Ink/React (dashboard TUI), vitest, execa.

## Global Constraints

- Node >=20, ESM (`"type": "module"`) — every new file uses `.js` extensions in relative imports, matching the rest of `src/`.
- No new npm dependencies — `SSEClientTransport` ships in the already-installed `@modelcontextprotocol/sdk`.
- Follow this repo's existing test style: prefer real subprocesses/real servers over mocks (see `review.test.ts`, `engine.test.ts`), one behavior per test, vitest via `pnpm vitest run <path>`.
- No ink-testing-library / component render tests — this project doesn't have that harness; Ink-only changes are covered by typecheck plus a manual pty smoke test.
- Every task ends green: `pnpm test` and `pnpm typecheck` must pass before moving to the next task.
- Commit after every task with a conventional commit message.

---

### Task 1: Expose session `kind` remotely + list all sessions

**Files:**
- Modify: `src/engine/session.ts`
- Test: `src/engine/engine.test.ts`

**Interfaces:**
- Produces: `AgentSessionInfo.kind: SessionKind` (new field). `SessionManager.listSessions(): AgentSession[]` (new method, sorted by `createdAt` descending).
- Consumes: existing `SessionKind`, `AgentSession`, `SessionManager` from the same file.

- [ ] **Step 1: Write the failing tests**

Add to `src/engine/engine.test.ts` (new `describe` block, alongside the existing `SessionManager`/`SessionManager review sessions` blocks):

```typescript
describe('SessionManager.listSessions', () => {
  it('returns an empty array when no sessions exist', () => {
    const config = getDefaultConfig();
    const manager = new SessionManager(config);
    expect(manager.listSessions()).toEqual([]);
  });

  it('returns sessions sorted by createdAt descending, and each includes its kind', async () => {
    const config = getDefaultConfig();
    config.agents['test_echo'] = {
      name: 'Echo Test',
      command: 'echo',
      args: [],
      transport: 'pty_interactive',
      env: {},
    };
    const manager = new SessionManager(config);

    const first = manager.createSession('test_echo', 'one');
    await waitForSessionCompletion(manager, first.id);
    const second = manager.createSession('test_echo', 'two', undefined, undefined, { kind: 'review' });
    await waitForSessionCompletion(manager, second.id);

    const listed = manager.listSessions();
    expect(listed.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(listed[0].getInfo().kind).toBe('review');
    expect(listed[1].getInfo().kind).toBe('task');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/engine/engine.test.ts`
Expected: FAIL — `manager.listSessions is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/session.ts`, add `kind` to the `AgentSessionInfo` interface:

```typescript
export interface AgentSessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  status: SessionStatus;
  createdAt: string;
  workspace: string;
  summary?: string;
  eventCount: number;
  review?: ReviewOutput;
  kind: SessionKind;
}
```

Update `AgentSession.getInfo()` to include it:

```typescript
  getInfo(): AgentSessionInfo {
    return {
      sessionId: this.id,
      agentId: this.agentId,
      agentName: this.agentConfig.name,
      status: this.status,
      createdAt: this.createdAt,
      workspace: this.workspace,
      summary: this.result?.summary || this.error,
      eventCount: this.controller.getBuffer().size(),
      review: this.reviewResult,
      kind: this.kind,
    };
  }
```

Add `listSessions()` to `SessionManager` (place it next to `getSession`):

```typescript
  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/engine/engine.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass (adding a required `kind` field to `AgentSessionInfo` is additive — nothing currently destructures it, so no other file breaks).

- [ ] **Step 6: Commit**

```bash
git add src/engine/session.ts src/engine/engine.test.ts
git commit -m "feat(engine): expose session kind in AgentSessionInfo, add SessionManager.listSessions"
```

---

### Task 2: Add `agent_session_list` tool, extend `agent_session_create` with `kind`

**Files:**
- Modify: `src/tools/unified.ts`
- Test: `src/tools/unified.test.ts`

**Interfaces:**
- Consumes: `SessionManager.listSessions()` (Task 1), `SessionKind` type from `../engine/session.js`.
- Produces: MCP tool `agent_session_list` (no params) returning `AgentSessionInfo[]` as JSON text. `agent_session_create` now accepts an optional `kind: 'task' | 'review'` param (default `'task'`).

- [ ] **Step 1: Write the failing tests**

Add to `src/tools/unified.test.ts`:

```typescript
describe('agent_session_list tool', () => {
  it('lists every session with its kind, most recent first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-unified-tool-'));
    try {
      const config = getDefaultConfig(dir);
      config.agents['echoer'] = echoArgsAgentConfig(dir);
      const sessionManager = new SessionManager(config);
      const tools = registerUnifiedTools(config, sessionManager);
      const sessionCreateTool = tools.find((t) => t.name === 'agent_session_create')!;
      const sessionListTool = tools.find((t) => t.name === 'agent_session_list')!;

      const created = await sessionCreateTool.handler({ agent: 'echoer', prompt: 'hello', workspace: dir });
      const sessionInfo = JSON.parse((created.content as any)[0].text);
      await waitForSessionCompletion(sessionManager, sessionInfo.sessionId);

      const listed = await sessionListTool.handler({});
      const sessions = JSON.parse((listed.content as any)[0].text);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(sessionInfo.sessionId);
      expect(sessions[0].kind).toBe('task');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent_session_create tool kind param', () => {
  it('creates a review-kind session when kind: "review" is passed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-unified-tool-'));
    try {
      const config = getDefaultConfig(dir);
      config.agents['echoer'] = echoArgsAgentConfig(dir);
      const sessionManager = new SessionManager(config);
      const tools = registerUnifiedTools(config, sessionManager);
      const sessionCreateTool = tools.find((t) => t.name === 'agent_session_create')!;

      const response = await sessionCreateTool.handler({
        agent: 'echoer',
        prompt: 'hello',
        workspace: dir,
        kind: 'review',
      });
      const sessionInfo = JSON.parse((response.content as any)[0].text);

      expect(sessionInfo.kind).toBe('review');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

This reuses `echoArgsAgentConfig`, `waitForSessionCompletion`, and the `fs`/`os`/`path`/`SessionManager` imports already present at the top of `src/tools/unified.test.ts` (added in the earlier model-override work) — no new imports needed in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/tools/unified.test.ts`
Expected: FAIL — `sessionListTool` is `undefined` (`agent_session_list` tool not found), and the kind test fails because `sessionInfo.kind` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/tools/unified.ts`, add `SessionKind` to the import from `../engine/session.js` (add this import line near the top, next to the existing `SessionManager` import):

```typescript
import { SessionKind } from '../engine/session.js';
```

In the `agent_session_create` tool definition, add a `kind` property to `inputSchema.properties` (after `model`):

```typescript
        kind: {
          type: 'string',
          enum: ['task', 'review'],
          description: "Session kind for dashboard categorization (default 'task')",
        },
```

And in its handler, compute `kind` and pass it through:

```typescript
    handler: async (args) => {
      const agentId = String(args.agent);
      const prompt = String(args.prompt);
      const workspace = args.workspace ? String(args.workspace) : undefined;
      const mode = args.mode ? String(args.mode) : undefined;
      const kind: SessionKind = args.kind === 'review' ? 'review' : 'task';

      const baseAgentConfig = requireAgentConfig(config, agentId);
      const agentConfigOverride = applyModelOverride(baseAgentConfig, resolveModel(args, baseAgentConfig));

      const session = sessionManager.createSession(agentId, prompt, workspace, mode, { kind, agentConfigOverride });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(session.getInfo(), null, 2),
          },
        ],
      };
    },
```

Add a new tool right after `agent_session_create`'s `tools.push({...})` block:

```typescript
  // Tool: agent_session_list
  tools.push({
    name: 'agent_session_list',
    description: 'Lists every background sub-agent session tracked by this server (running, completed, failed, or cancelled), most recent first',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const sessions = sessionManager.listSessions().map((s) => s.getInfo());
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sessions, null, 2),
          },
        ],
      };
    },
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/tools/unified.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/unified.ts src/tools/unified.test.ts
git commit -m "feat(tools): add agent_session_list, kind param on agent_session_create"
```

---

### Task 3: Multi-client SSE server

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts`

**Interfaces:**
- Produces: `createServerContext(configPath?): Promise<{ config, filePath, sessionManager, toolMap, allTools }>` (new, exported). `buildServer(ctx): Server` (new, exported, builds one fresh `Server` with handlers registered against a shared context). `createAgentMCPServer(configPath?)` keeps its existing return shape (`{ server, config, filePath, sessionManager }`) — existing callers/tests are unaffected. `startAgentMCPServer(options)` now returns `Promise<http.Server | undefined>` (the underlying Node HTTP server in `sse` mode, so callers/tests can `.close()` it; `undefined` in `stdio` mode) instead of `Promise<void>`.
- Consumes: `getPackageVersion()` from `./cli/version.js` (existing, from the earlier version-string fix).

- [ ] **Step 1: Write the failing test**

Add to `src/server.test.ts` (needs new imports — replace the top of the file):

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { createAgentMCPServer, startAgentMCPServer } from './server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { AddressInfo } from 'net';
import type http from 'http';

let runningServer: http.Server | undefined;

afterEach(() => {
  runningServer?.close();
  runningServer = undefined;
});
```

Then add a new `describe` block at the end of the file:

```typescript
describe('multi-client SSE support', () => {
  it('allows two independently connected clients to both call tools without clobbering each other', async () => {
    runningServer = await startAgentMCPServer({ transport: 'sse', port: 0 });
    const port = (runningServer!.address() as AddressInfo).port;
    const url = new URL(`http://localhost:${port}/sse`);

    const clientA = new Client({ name: 'client-a', version: '1.0.0' }, { capabilities: {} });
    const clientB = new Client({ name: 'client-b', version: '1.0.0' }, { capabilities: {} });

    await clientA.connect(new SSEClientTransport(url));
    await clientB.connect(new SSEClientTransport(url));

    const [toolsA, toolsB] = await Promise.all([clientA.listTools(), clientB.listTools()]);

    expect(toolsA.tools.map((t) => t.name)).toContain('agent_session_list');
    expect(toolsB.tools.map((t) => t.name)).toContain('agent_session_list');

    await clientA.close();
    await clientB.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server.test.ts`
Expected: FAIL. Either a type error (`startAgentMCPServer` currently returns `Promise<void>`, so `runningServer!.address()` doesn't typecheck) or, if run against the current single-transport implementation, the second client's `connect()` hangs/errors because the first `sseTransport` gets silently overwritten. Confirm it fails for one of these reasons before proceeding — not a typo in the test.

- [ ] **Step 3: Write minimal implementation**

Replace the whole content of `src/server.ts` with:

```typescript
import http from 'http';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config/loader.js';
import { SessionManager } from './engine/session.js';
import { registerUnifiedTools, MCPToolDefinition } from './tools/unified.js';
import { registerShortcutTools } from './tools/shortcuts.js';
import { registerReviewTools } from './tools/review.js';
import { getPackageVersion } from './cli/version.js';

export interface AgentMCPServerContext {
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  filePath: string | null;
  sessionManager: SessionManager;
  toolMap: Map<string, MCPToolDefinition>;
  allTools: MCPToolDefinition[];
}

/**
 * Builds the shared, transport-independent state once: config, the one SessionManager, and the
 * tool registry. Every connected client (stdio, or one-per-SSE-connection) gets its own `Server`
 * from `buildServer()` below, but all of them share this same context — that's what makes
 * sessions visible across every simultaneously connected client.
 */
export async function createServerContext(configPath?: string): Promise<AgentMCPServerContext> {
  const { config, filePath } = loadConfig(configPath);
  const sessionManager = new SessionManager(config);

  const unifiedTools = registerUnifiedTools(config, sessionManager);
  const agentRunHandler = unifiedTools.find((t) => t.name === 'agent_run')!.handler;
  const shortcutTools = registerShortcutTools(config, agentRunHandler);
  const reviewTools = registerReviewTools(config, sessionManager);

  const allTools = [...unifiedTools, ...shortcutTools, ...reviewTools];
  const toolMap = new Map<string, MCPToolDefinition>();
  for (const tool of allTools) {
    toolMap.set(tool.name, tool);
  }

  return { config, filePath, sessionManager, toolMap, allTools };
}

/** Builds one fresh `Server` instance wired to the given (shared) context. Safe to call many times. */
export function buildServer(ctx: AgentMCPServerContext): Server {
  const server = new Server(
    {
      name: 'agent-rack',
      version: getPackageVersion(),
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ctx.allTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = ctx.toolMap.get(name);

    if (!tool) {
      throw new Error(`Tool '${name}' is not registered on agent-rack server.`);
    }

    try {
      const result = await tool.handler(args || {});
      return result as any;
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool '${name}': ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function createAgentMCPServer(configPath?: string) {
  const ctx = await createServerContext(configPath);
  const server = buildServer(ctx);
  return { server, config: ctx.config, filePath: ctx.filePath, sessionManager: ctx.sessionManager };
}

export async function startAgentMCPServer(
  options: { configPath?: string; transport?: 'stdio' | 'sse'; port?: number } = {}
): Promise<http.Server | undefined> {
  const ctx = await createServerContext(options.configPath);
  const targetTransport = options.transport || ctx.config.transport || 'stdio';
  const targetPort = options.port ?? ctx.config.port ?? 8765;

  // No config file anywhere on the search path means `allowedWorkspaces` silently defaults
  // to the current directory. That is the whole security boundary, so say so out loud.
  if (!ctx.filePath) {
    console.error(
      `Warning: no agent-rack config file found. Falling back to built-in defaults with ` +
        `allowedWorkspaces=[${ctx.config.allowedWorkspaces.join(', ')}]. ` +
        `Copy agent-rack.config.example.json to agent-rack.config.json to pin this explicitly.`
    );
  }

  if (targetTransport === 'sse') {
    const app = express();
    app.use(express.json());

    const transports = new Map<string, SSEServerTransport>();

    app.get('/sse', async (req, res) => {
      const transport = new SSEServerTransport('/message', res);
      transports.set(transport.sessionId, transport);
      res.on('close', () => {
        transports.delete(transport.sessionId);
      });

      const server = buildServer(ctx);
      await server.connect(transport);
    });

    app.post('/message', async (req, res) => {
      const sessionId = String(req.query.sessionId || '');
      const transport = transports.get(sessionId);
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(400).send('No active SSE connection for this sessionId');
      }
    });

    const httpServer = http.createServer(app);
    return new Promise((resolve) => {
      httpServer.listen(targetPort, () => {
        const boundPort = (httpServer.address() as { port: number }).port;
        console.error(`Agent-MCP Server running on HTTP-SSE: http://localhost:${boundPort}/sse`);
        resolve(httpServer);
      });
    });
  } else {
    const server = buildServer(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Agent-MCP Server running on stdio');
    return undefined;
  }
}
```

Note: `targetPort` now uses `??` instead of `||` so `port: 0` (used by the test to get an OS-assigned ephemeral port) isn't treated as falsy and overridden by the `8765` default.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server.test.ts`
Expected: PASS — both clients see `agent_session_list` in their tool list.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass. (`createAgentMCPServer`'s return shape is unchanged, so the pre-existing `Server Initialization`/`agent_review tool registration` tests in `server.test.ts` keep passing untouched.)

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "fix(server): support multiple concurrent SSE clients, stop hardcoding server version"
```

---

### Task 4: Dashboard remote client

**Files:**
- Create: `src/cli/dashboard/remoteClient.ts`
- Test: `src/cli/dashboard/remoteClient.test.ts`

**Interfaces:**
- Consumes: `startAgentMCPServer` (Task 3, for the test's real server), `AgentSessionInfo`/`SessionKind` from `../../engine/session.js`, `ParsedAgentEvent` from `../../adapters/base.js`.
- Produces: `class DashboardRemoteClient` with `connect(): Promise<void>`, `listSessions(): Promise<AgentSessionInfo[]>`, `getSessionStatus(sessionId): Promise<AgentSessionInfo>`, `getSessionLogs(sessionId, offset?, limit?): Promise<ParsedAgentEvent[]>`, `sendInput(sessionId, message): Promise<void>`, `cancelSession(sessionId): Promise<void>`, `createSession(agent, prompt, workspace, kind, model?): Promise<AgentSessionInfo>`, constructed as `new DashboardRemoteClient(serverUrl: string)`.

- [ ] **Step 1: Write the failing test**

Create `src/cli/dashboard/remoteClient.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type http from 'http';
import { startAgentMCPServer } from '../../server.js';
import { DashboardRemoteClient } from './remoteClient.js';

let runningServer: http.Server | undefined;

afterEach(() => {
  runningServer?.close();
  runningServer = undefined;
});

async function startTestServer(configPath: string) {
  runningServer = await startAgentMCPServer({ transport: 'sse', port: 0, configPath });
  const port = (runningServer!.address() as AddressInfo).port;
  return `http://localhost:${port}/sse`;
}

describe('DashboardRemoteClient', () => {
  it('creates a session, lists it, and reads its logs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-remote-client-'));
    const echoScript = path.join(dir, 'echo.cjs');
    fs.writeFileSync(
      echoScript,
      "console.log(JSON.stringify({ type: 'assistant', text: 'pong' }));\n"
    );
    const configPath = path.join(dir, 'agent-rack.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        transport: 'sse',
        allowedWorkspaces: [dir],
        agents: {
          echoer: { name: 'Echoer', command: 'node', args: [echoScript], transport: 'claude_stream_json', env: {} },
        },
      })
    );

    try {
      const url = await startTestServer(configPath);
      const client = new DashboardRemoteClient(url);
      await client.connect();

      const created = await client.createSession('echoer', 'hello', dir, 'task');
      expect(created.agentId).toBe('echoer');
      expect(created.kind).toBe('task');

      let sessions = await client.listSessions();
      const deadline = Date.now() + 5000;
      while (sessions.find((s) => s.sessionId === created.sessionId)?.status === 'running' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        sessions = await client.listSessions();
      }

      const found = sessions.find((s) => s.sessionId === created.sessionId);
      expect(found?.status).toBe('completed');

      const logs = await client.getSessionLogs(created.sessionId);
      expect(logs.some((e) => e.content.includes('pong'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/dashboard/remoteClient.test.ts`
Expected: FAIL — `Cannot find module './remoteClient.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/dashboard/remoteClient.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { AgentSessionInfo, SessionKind } from '../../engine/session.js';
import { ParsedAgentEvent } from '../../adapters/base.js';

/** Thin MCP client wrapper the dashboard uses instead of owning a local SessionManager. */
export class DashboardRemoteClient {
  private readonly client: Client;
  private connected = false;

  constructor(private readonly serverUrl: string) {
    this.client = new Client({ name: 'agent-rack-dashboard', version: '1.0.0' }, { capabilities: {} });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const transport = new SSEClientTransport(new URL(this.serverUrl));
    await this.client.connect(transport);
    this.connected = true;
  }

  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content as Array<{ type: string; text?: string }>)?.[0];
    if (!content || content.type !== 'text' || typeof content.text !== 'string') {
      throw new Error(`Tool '${name}' returned no text content`);
    }
    return content.text;
  }

  async listSessions(): Promise<AgentSessionInfo[]> {
    return JSON.parse(await this.callTool('agent_session_list'));
  }

  async getSessionStatus(sessionId: string): Promise<AgentSessionInfo> {
    return JSON.parse(await this.callTool('agent_session_status', { sessionId }));
  }

  async getSessionLogs(sessionId: string, offset = 0, limit?: number): Promise<ParsedAgentEvent[]> {
    const args: Record<string, unknown> = { sessionId, offset };
    if (limit !== undefined) args.limit = limit;
    return JSON.parse(await this.callTool('agent_session_logs', args));
  }

  async sendInput(sessionId: string, message: string): Promise<void> {
    await this.callTool('agent_session_send', { sessionId, message });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.callTool('agent_session_cancel', { sessionId });
  }

  async createSession(
    agent: string,
    prompt: string,
    workspace: string,
    kind: SessionKind,
    model?: string
  ): Promise<AgentSessionInfo> {
    const args: Record<string, unknown> = { agent, prompt, workspace, kind };
    if (model) args.model = model;
    return JSON.parse(await this.callTool('agent_session_create', args));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/cli/dashboard/remoteClient.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/dashboard/remoteClient.ts src/cli/dashboard/remoteClient.test.ts
git commit -m "feat(dashboard): add DashboardRemoteClient, an MCP client wrapper for the shared server"
```

---

### Task 5: Connection resolution

**Files:**
- Create: `src/cli/dashboard/connection.ts`
- Test: `src/cli/dashboard/connection.test.ts`

**Interfaces:**
- Consumes: `AgentMCPConfig` from `../../config/schema.js`.
- Produces: `resolveDashboardServerUrl(config: AgentMCPConfig, connectFlag?: string): { url: string } | { error: string }` (exported).

- [ ] **Step 1: Write the failing test**

Create `src/cli/dashboard/connection.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../../config/loader.js';
import { resolveDashboardServerUrl } from './connection.js';

describe('resolveDashboardServerUrl', () => {
  it('uses the explicit --connect flag when given, regardless of config', () => {
    const config = getDefaultConfig();
    const result = resolveDashboardServerUrl(config, 'http://example.com:9999/sse');
    expect(result).toEqual({ url: 'http://example.com:9999/sse' });
  });

  it('derives the URL from config when transport is sse', () => {
    const config = getDefaultConfig();
    config.transport = 'sse';
    config.port = 8987;
    const result = resolveDashboardServerUrl(config, undefined);
    expect(result).toEqual({ url: 'http://localhost:8987/sse' });
  });

  it('defaults to port 8765 when transport is sse but no port is set', () => {
    const config = getDefaultConfig();
    config.transport = 'sse';
    config.port = undefined;
    const result = resolveDashboardServerUrl(config, undefined);
    expect(result).toEqual({ url: 'http://localhost:8765/sse' });
  });

  it('returns an error when transport is stdio and no --connect flag is given', () => {
    const config = getDefaultConfig();
    config.transport = 'stdio';
    const result = resolveDashboardServerUrl(config, undefined);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('shared');
      expect(result.error).toContain('sse');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/dashboard/connection.test.ts`
Expected: FAIL — `Cannot find module './connection.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/dashboard/connection.ts`:

```typescript
import { AgentMCPConfig } from '../../config/schema.js';

export type DashboardServerResolution = { url: string } | { error: string };

/**
 * The dashboard is always a client of a shared server (see the shared-dashboard-sessions
 * design) — it never falls back to a private local SessionManager. An explicit `--connect`
 * flag always wins; otherwise the URL is derived from the same config used everywhere else, so
 * `agent-rack start` and `agent-rack dashboard` agree on it without extra flags in the common
 * case.
 */
export function resolveDashboardServerUrl(
  config: AgentMCPConfig,
  connectFlag: string | undefined
): DashboardServerResolution {
  if (connectFlag) {
    return { url: connectFlag };
  }

  if (config.transport !== 'sse') {
    return {
      error: [
        'agent-rack dashboard needs a shared server to connect to, but the loaded config has',
        "transport: 'stdio'.",
        'Set "transport": "sse" and a "port" in agent-rack.config.json, start the server with',
        '`agent-rack start`, then run the dashboard again (or pass --connect <url> explicitly).',
      ].join('\n'),
    };
  }

  const port = config.port ?? 8765;
  return { url: `http://localhost:${port}/sse` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/cli/dashboard/connection.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/dashboard/connection.ts src/cli/dashboard/connection.test.ts
git commit -m "feat(dashboard): add resolveDashboardServerUrl for shared-server connection resolution"
```

---

### Task 6: Wire the dashboard as a remote client end-to-end

This is one atomic task: the CLI flag, `startDashboard`'s preflight, `App.tsx`'s data layer, and
the two view components it feeds all change together and only typecheck as a unit — splitting
them would leave intermediate commits red, which violates the "every task ends green" rule above.

**Files:**
- Modify: `src/cli/index.ts`
- Modify: `src/cli/dashboard/index.tsx`
- Modify: `src/cli/dashboard/App.tsx`
- Modify: `src/cli/dashboard/SessionsView.tsx`
- Modify: `src/cli/dashboard/ReviewView.tsx`

**Interfaces:**
- Consumes: `resolveDashboardServerUrl` (Task 5), `DashboardRemoteClient` (Task 4), `dashboardTTYError`/`getPackageVersion` (existing), `AgentSessionInfo` from `../../engine/session.js`, `ParsedAgentEvent` from `../../adapters/base.js`.
- Produces: `agent-rack dashboard --connect <url>` CLI flag. `startDashboard(customConfigPath?, connectFlag?)` connects and preflights (`listSessions()`) before rendering. `AppProps` gains a required `remoteClient: DashboardRemoteClient` field. `SessionsViewProps` becomes `{ sessions: AgentSessionInfo[]; selectedIndex: number; events: ParsedAgentEvent[] }`. `ReviewViewProps` becomes `{ sessions: AgentSessionInfo[] }`.

- [ ] **Step 1: Add the `--connect` flag**

In `src/cli/index.ts`, update the `dashboard` command:

```typescript
  program
    .command('dashboard')
    .alias('ui')
    .description('Launch the interactive CLI dashboard (TUI) for agent-rack')
    .option('-c, --config <path>', 'Path to agent-rack.config.json')
    .option('--connect <url>', 'URL of a running agent-rack SSE server (default: derived from config)')
    .action(async (options) => {
      const { startDashboard } = await import('./dashboard/index.js');
      await startDashboard(options.config, options.connect);
    });
```

- [ ] **Step 2: Rewrite `startDashboard` with connection resolution and preflight**

Replace `src/cli/dashboard/index.tsx` with:

```typescript
import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../../config/loader.js';
import { DashboardApp } from './App.js';
import { dashboardTTYError } from './tty.js';
import { getPackageVersion } from '../version.js';
import { resolveDashboardServerUrl } from './connection.js';
import { DashboardRemoteClient } from './remoteClient.js';

export async function startDashboard(customConfigPath?: string, connectFlag?: string): Promise<void> {
  const ttyError = dashboardTTYError(process.stdin);
  if (ttyError) {
    console.error(ttyError);
    process.exitCode = 1;
    return;
  }

  const { config, filePath } = loadConfig(customConfigPath);
  const resolution = resolveDashboardServerUrl(config, connectFlag);
  if ('error' in resolution) {
    console.error(resolution.error);
    process.exitCode = 1;
    return;
  }

  const remoteClient = new DashboardRemoteClient(resolution.url);
  try {
    await remoteClient.connect();
    await remoteClient.listSessions();
  } catch (err) {
    console.error(
      `Could not reach the agent-rack server at ${resolution.url}.\n` +
        `Start it first with: agent-rack start --transport sse --port <port>\n` +
        `(${err instanceof Error ? err.message : String(err)})`
    );
    process.exitCode = 1;
    return;
  }

  const { waitUntilExit } = render(
    <DashboardApp config={config} configPath={filePath || undefined} version={getPackageVersion()} remoteClient={remoteClient} />
  );
  await waitUntilExit();
}
```

- [ ] **Step 3: Replace `src/cli/dashboard/App.tsx`**

```typescript
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { AgentMCPConfig } from '../../config/schema.js';
import { AgentSessionInfo } from '../../engine/session.js';
import { ParsedAgentEvent } from '../../adapters/base.js';
import { DashboardRemoteClient } from './remoteClient.js';
import { Header } from './Header.js';
import { Footer } from './Footer.js';
import { SessionsView } from './SessionsView.js';
import { SystemView } from './SystemView.js';
import { ReviewView } from './ReviewView.js';
import { LauncherModal } from './LauncherModal.js';
import { SendInputModal } from './SendInputModal.js';

interface AppProps {
  config: AgentMCPConfig;
  configPath?: string;
  version?: string;
  remoteClient: DashboardRemoteClient;
}

const SESSION_LIST_POLL_MS = 1500;
const SESSION_LOGS_POLL_MS = 750;

export const DashboardApp: React.FC<AppProps> = ({ config, configPath, version, remoteClient }) => {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [events, setEvents] = useState<ParsedAgentEvent[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<'sessions' | 'launcher' | 'system' | 'reviews'>('sessions');
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined);
  const [showSendInputModal, setShowSendInputModal] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const eventsOffsetRef = useRef(0);
  const selectedSessionIdRef = useRef<string | undefined>(undefined);

  const availableAgents = Object.keys(config.agents);

  // Poll the session list.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await remoteClient.listSessions();
        if (!cancelled) {
          setSessions(list);
          setConnectionLost(false);
        }
      } catch {
        if (!cancelled) setConnectionLost(true);
      }
    };
    poll();
    const interval = setInterval(poll, SESSION_LIST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [remoteClient]);

  // Poll logs for whichever session is currently selected, resetting the cursor when the
  // selection changes to a different session.
  useEffect(() => {
    const selected = sessions[selectedIndex];
    if (!selected) {
      setEvents([]);
      return;
    }
    if (selectedSessionIdRef.current !== selected.sessionId) {
      selectedSessionIdRef.current = selected.sessionId;
      eventsOffsetRef.current = 0;
      setEvents([]);
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const newEvents = await remoteClient.getSessionLogs(selected.sessionId, eventsOffsetRef.current);
        if (!cancelled && newEvents.length > 0) {
          eventsOffsetRef.current += newEvents.length;
          setEvents((prev) => [...prev, ...newEvents]);
        }
      } catch {
        // Connection issues are already surfaced by the session-list poll above.
      }
    };
    poll();
    const interval = setInterval(poll, SESSION_LOGS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [remoteClient, sessions, selectedIndex]);

  const activeSessionsCount = sessions.filter((s) => s.status === 'running').length;

  useInput((input, key) => {
    if (activeTab === 'launcher' || showSendInputModal) {
      return; // Modal controls keyboard input
    }

    if (input === 'q') {
      exit();
      return;
    }

    if (input === '1') {
      setActiveTab('sessions');
    } else if (input === '2' || input === 'l') {
      setActiveTab('launcher');
    } else if (input === '3') {
      setActiveTab('system');
    } else if (input === '4') {
      setActiveTab('reviews');
    } else if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, sessions.length - 1)));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => (prev < sessions.length - 1 ? prev + 1 : 0));
    } else if (input === 'c') {
      const selected = sessions[selectedIndex];
      if (selected && selected.status === 'running') {
        remoteClient
          .cancelSession(selected.sessionId)
          .then(() => setStatusMessage(`Session ${selected.sessionId.slice(0, 8)} cancelled.`))
          .catch((err) =>
            setStatusMessage(`Error cancelling session: ${err instanceof Error ? err.message : String(err)}`)
          );
      } else {
        setStatusMessage('No active running session selected to cancel.');
      }
    } else if (input === 's') {
      const selected = sessions[selectedIndex];
      if (selected && selected.status === 'running') {
        setShowSendInputModal(true);
      } else {
        setStatusMessage('Select a running session to send input.');
      }
    }
  });

  const handleLaunch = async (
    agentId: string,
    prompt: string,
    workspace: string,
    kind: 'task' | 'review',
    model?: string
  ) => {
    try {
      const session = await remoteClient.createSession(agentId, prompt, workspace, kind, model);
      setSessions((prev) => [session, ...prev]);
      setSelectedIndex(0);
      setActiveTab('sessions');
      setStatusMessage(`Launched ${agentId} (${kind}) session ${session.sessionId.slice(0, 8)}`);
    } catch (err) {
      setStatusMessage(`Failed to launch agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSendInput = async (message: string) => {
    const selected = sessions[selectedIndex];
    if (selected) {
      try {
        await remoteClient.sendInput(selected.sessionId, message);
        setStatusMessage(`Sent input to ${selected.agentId} (${selected.sessionId.slice(0, 8)})`);
      } catch (err) {
        setStatusMessage(`Error sending input: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setShowSendInputModal(false);
  };

  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Header
        configPath={configPath}
        activeSessions={activeSessionsCount}
        maxSessions={config.security.maxConcurrentSessions}
        activeTab={activeTab}
        sanitizedEnv={config.security.sanitizeEnv !== false}
        version={version}
      />

      {connectionLost && (
        <Box marginBottom={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red" bold>
            ⚠ Connection to agent-rack server lost — retrying…
          </Text>
        </Box>
      )}

      {activeTab === 'launcher' ? (
        <LauncherModal
          availableAgents={availableAgents}
          workspaces={config.allowedWorkspaces}
          onLaunch={handleLaunch}
          onCancel={() => setActiveTab('sessions')}
        />
      ) : showSendInputModal && sessions[selectedIndex] ? (
        <SendInputModal
          sessionId={sessions[selectedIndex].sessionId}
          agentName={sessions[selectedIndex].agentName}
          onSend={handleSendInput}
          onCancel={() => setShowSendInputModal(false)}
        />
      ) : activeTab === 'sessions' ? (
        <SessionsView sessions={sessions} selectedIndex={selectedIndex} events={events} />
      ) : activeTab === 'system' ? (
        <SystemView config={config} configPath={configPath} />
      ) : (
        <ReviewView sessions={sessions} />
      )}

      <Footer statusMessage={statusMessage} />
    </Box>
  );
};
```

`handleLaunch`'s signature is unchanged from before this plan (`LauncherModal`'s `onLaunch` prop type already matches, from the earlier model-override work) — only its implementation becomes `async` and calls `remoteClient` instead of a local `SessionManager`.

- [ ] **Step 4: Replace `src/cli/dashboard/SessionsView.tsx`**

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { AgentSessionInfo } from '../../engine/session.js';
import { ParsedAgentEvent } from '../../adapters/base.js';

interface SessionsViewProps {
  sessions: AgentSessionInfo[];
  selectedIndex: number;
  events: ParsedAgentEvent[];
}

function getStatusBadge(status: string) {
  switch (status) {
    case 'running':
      return <Text color="green">● RUNNING</Text>;
    case 'completed':
      return <Text color="blue">✓ DONE</Text>;
    case 'failed':
      return <Text color="red">✖ FAILED</Text>;
    case 'cancelled':
      return <Text color="yellow">⊘ CANCELLED</Text>;
    case 'idle':
      return <Text color="gray">○ IDLE</Text>;
    default:
      return <Text color="gray">{status}</Text>;
  }
}

export const SessionsView: React.FC<SessionsViewProps> = ({ sessions, selectedIndex, events }) => {
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor="gray" padding={2} alignItems="center" justifyContent="center">
        <Text bold color="yellow">No active or past sessions.</Text>
        <Text color="gray">Press <Text bold color="cyan">[l]</Text> or switch to <Text bold color="cyan">[2] Launch Agent</Text> tab to run a new agent session.</Text>
      </Box>
    );
  }

  const info = sessions[selectedIndex] || sessions[0];
  const recentEvents = events.slice(-12);

  return (
    <Box flexDirection="row" gap={1} flexGrow={1}>
      {/* Left List Pane */}
      <Box flexDirection="column" width="35%" borderStyle="single" borderColor="blue" paddingX={1}>
        <Text bold color="cyan" underline>
          Sessions ({sessions.length})
        </Text>
        {sessions.map((sInfo, idx) => {
          const isSelected = idx === selectedIndex;
          return (
            <Box key={sInfo.sessionId} flexDirection="column" marginY={0}>
              <Text bold color={isSelected ? 'inverse' : undefined}>
                {isSelected ? '► ' : '  '}
                {sInfo.agentId} <Text color="gray">({sInfo.sessionId.slice(0, 8)})</Text>
              </Text>
              <Box paddingLeft={2} justifyContent="space-between">
                {getStatusBadge(sInfo.status)}
                <Text color="gray" dimColor>
                  {sInfo.eventCount} ev
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Right Details & Live Log Stream Pane */}
      <Box flexDirection="column" width="65%" borderStyle="single" borderColor="cyan" paddingX={1} gap={1}>
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold color="green">
            Session Details: <Text color="white">{info.sessionId}</Text>
          </Text>
          <Text>
            Agent: <Text bold color="yellow">{info.agentName}</Text> ({info.agentId}) | Kind: <Text color="magenta">{info.kind}</Text>
          </Text>
          <Text color="gray">Workspace: {info.workspace}</Text>
          <Text color="gray">Created: {new Date(info.createdAt).toLocaleTimeString()}</Text>
          {info.summary && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color="white">Summary:</Text>
              <Text color="gray" wrap="truncate-end">
                {info.summary.slice(0, 150)}{info.summary.length > 150 ? '...' : ''}
              </Text>
            </Box>
          )}
        </Box>

        {/* Event Logs Stream */}
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color="magenta" underline>
            Live Event Stream ({events.length} events)
          </Text>
          {recentEvents.length === 0 ? (
            <Text color="gray" dimColor>Waiting for agent events...</Text>
          ) : (
            recentEvents.map((ev, i) => {
              const time = new Date(ev.timestamp).toLocaleTimeString();
              let content = ev.content;
              let badge = <Text color="gray">[TEXT]</Text>;
              if (ev.type === 'tool_call') {
                badge = <Text color="cyan">[TOOL] {ev.toolName || ''}</Text>;
                content = typeof ev.input === 'object' ? JSON.stringify(ev.input) : String(ev.input || ev.content);
              } else if (ev.type === 'thought') {
                badge = <Text color="magenta">[THOUGHT]</Text>;
              } else if (ev.type === 'error') {
                badge = <Text color="red">[ERROR]</Text>;
              } else if (ev.type === 'status') {
                badge = <Text color="yellow">[STATUS]</Text>;
              }

              return (
                <Text key={i} wrap="truncate-end">
                  <Text color="gray">[{time}]</Text> {badge} {content.replace(/\n/g, ' ')}
                </Text>
              );
            })
          )}
        </Box>
      </Box>
    </Box>
  );
};
```

- [ ] **Step 5: Replace `src/cli/dashboard/ReviewView.tsx`**

```typescript
import React from 'react';
import { Box, Text } from 'ink';
import { AgentSessionInfo } from '../../engine/session.js';

interface ReviewViewProps {
  sessions: AgentSessionInfo[];
}

export const ReviewView: React.FC<ReviewViewProps> = ({ sessions }) => {
  const reviewSessions = sessions.filter((s) => s.kind === 'review' || s.review);

  if (reviewSessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor="magenta" padding={2} alignItems="center" justifyContent="center" flexGrow={1}>
        <Text bold color="magenta">
          🔍 No Code Reviews Generated Yet
        </Text>
        <Text color="gray">
          To launch a code review, press <Text bold color="cyan">[l]</Text> and select <Text bold color="magenta">[Code Review]</Text> session kind.
        </Text>
      </Box>
    );
  }

  const latestReview = reviewSessions[reviewSessions.length - 1];
  const review = latestReview.review;

  return (
    <Box flexDirection="column" gap={1} flexGrow={1}>
      <Box borderStyle="single" borderColor="magenta" paddingX={1} justifyContent="space-between">
        <Text bold color="magenta">
          🔍 CODE REVIEW INSPECTOR (Session: {latestReview.sessionId.slice(0, 8)})
        </Text>
        <Text bold color={review?.verdict === 'approve' ? 'green' : 'red'}>
          VERDICT: {review?.verdict === 'approve' ? '✓ APPROVED' : '⚠️ NEEDS ATTENTION'}
        </Text>
      </Box>

      {review?.summary && (
        <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
          <Text bold color="white">Executive Summary:</Text>
          <Text color="gray">{review.summary}</Text>
        </Box>
      )}

      {/* Findings Table */}
      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} flexGrow={1}>
        <Text bold color="cyan" underline>
          Findings ({review?.findings?.length || 0})
        </Text>
        {(!review?.findings || review.findings.length === 0) ? (
          <Text color="green">✓ No critical findings or issues reported by reviewer agent.</Text>
        ) : (
          review.findings.map((f, idx) => {
            let sevColor = 'gray';
            if (f.severity === 'critical') sevColor = 'red';
            else if (f.severity === 'high') sevColor = 'yellow';
            else if (f.severity === 'medium') sevColor = 'magenta';

            return (
              <Box key={idx} flexDirection="column" marginY={1}>
                <Box justifyContent="space-between">
                  <Text bold color={sevColor as any}>
                    [{f.severity.toUpperCase()}] {f.title}
                  </Text>
                  <Text color="gray">
                    {f.file}:{f.line_start}-{f.line_end}
                  </Text>
                </Box>
                <Box paddingLeft={2}>
                  <Text color="white">
                    {f.body}
                  </Text>
                </Box>
                {f.recommendation && (
                  <Box paddingLeft={2}>
                    <Text color="green">
                      💡 Rec: {f.recommendation}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {/* Next Steps */}
      {review?.next_steps && review.next_steps.length > 0 && (
        <Box borderStyle="single" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text bold color="yellow">Recommended Next Steps:</Text>
          {review.next_steps.map((step, i) => (
            <Text key={i} color="gray">
              • {step}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
};
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass — this is the first point at which all five files are mutually consistent.

- [ ] **Step 7: Manual pty smoke test**

Exercises the whole chain end to end (server + dashboard as its client), the same technique used for the earlier TTY-guard/version fixes:

```bash
pnpm build
node dist/cli/index.js start --transport sse --port 8987 &
sleep 1
script -q /tmp/dashboard-smoke.log node dist/cli/index.js dashboard --connect http://localhost:8987/sse &
sleep 3
kill %2 2>/dev/null; kill %1 2>/dev/null
grep -o "AGENT-RACK DASHBOARD[^│]*" /tmp/dashboard-smoke.log | head -1
rm -f /tmp/dashboard-smoke.log
```

Expected: the header line prints with the real current version and no unhandled-exception stack trace. Then re-run the dashboard alone, server not running, to confirm the friendly "Could not reach the agent-rack server…" message appears instead of a crash:

```bash
node dist/cli/index.js dashboard --connect http://localhost:8987/sse < /dev/null
```

Expected: prints the "Could not reach the agent-rack server at http://localhost:8987/sse" message and exits non-zero (no server was started this time).

- [ ] **Step 8: Commit**

```bash
git add src/cli/index.ts src/cli/dashboard/index.tsx src/cli/dashboard/App.tsx src/cli/dashboard/SessionsView.tsx src/cli/dashboard/ReviewView.tsx
git commit -m "feat(dashboard): make dashboard an MCP client of the shared agent-rack server"
```

---

### Task 7: Delete now-dead local-launch code

**Files:**
- Delete: `src/cli/dashboard/launch.ts`
- Delete: `src/cli/dashboard/launch.test.ts`

**Interfaces:**
- Consumes: none (verifying nothing imports these anymore).
- Produces: nothing — pure removal.

- [ ] **Step 1: Verify nothing references `launch.js` anymore**

Run: `grep -rn "dashboard/launch" src/ --include="*.ts" --include="*.tsx"`
Expected: no matches (Task 6's `App.tsx` rewrite already dropped the `computeLaunchAgentConfig` import — model resolution now happens server-side in the `agent_session_create` tool handler, same as every other client).

- [ ] **Step 2: Delete the files**

```bash
git rm src/cli/dashboard/launch.ts src/cli/dashboard/launch.test.ts
```

- [ ] **Step 3: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass — one fewer test file, no import errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(dashboard): remove launch.ts, superseded by remote agent_session_create"
```

---

### Task 8: Update README

**Files:**
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the `dashboard` section**

In the `### \`dashboard\` (alias \`ui\`)` section of `README.md`, replace the usage line and add a requirement note. Find:

```markdown
### `dashboard` (alias `ui`)

```sh
agent-rack dashboard [-c, --config <path>]
```

Launches an interactive terminal user interface (TUI) built with Ink/React. Provides real-time visibility and control over local agent processes:
```

Replace with:

```markdown
### `dashboard` (alias `ui`)

```sh
agent-rack dashboard [-c, --config <path>] [--connect <url>]
```

The dashboard is a client of a running agent-rack server, not a standalone tool — it shows the
same sessions any other MCP client (Claude Code, Codex, etc.) creates, and vice versa. Before
launching it:

1. Set `"transport": "sse"` and a `"port"` in `agent-rack.config.json`.
2. Start the server: `agent-rack start` (leave it running).
3. Point every MCP client's config at `http://localhost:<port>/sse` instead of having each spawn
   its own private `agent-rack start` over stdio.
4. Run `agent-rack dashboard` — it connects to that same server automatically. Pass `--connect
   <url>` to point at a different server explicitly.

If no shared server is reachable, the dashboard prints how to start one and exits, rather than
falling back to a disconnected local-only view.

Launches an interactive terminal user interface (TUI) built with Ink/React. Provides real-time visibility and control over local agent processes:
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document the shared-server requirement for agent-rack dashboard"
```

---

### Task 9: Final verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full clean verification**

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: all green.

- [ ] **Step 2: Confirm package version bump is warranted**

This is a behavior change to a public CLI surface (`dashboard`/`ui` now requires a shared server, new `--connect` flag, new `agent_session_list` tool, `agent_session_create` gains a `kind` param). Bump `package.json`'s `version` following this project's existing pattern (minor bump for additive-but-behavior-changing features, as done for the earlier model-override work) before publishing — confirm the exact number with whoever is publishing, don't assume it.

- [ ] **Step 3: Leave push/publish to the user's explicit go-ahead**

Per this project's established workflow in this conversation, do not `git push`/`npm publish` as part of this plan's automatic execution — stop after Step 1/2 and report status, exactly like every prior feature in this session.
