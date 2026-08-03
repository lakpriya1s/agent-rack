import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createAgentMCPServer,
  createServerContextFromConfig,
  startAgentMCPServer,
  startSSEServer,
  startSseSidecar,
  type ManagedAgentMCPServer,
} from './server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { AddressInfo } from 'net';
import type http from 'http';
import net from 'net';
import { getDefaultConfig } from './config/loader.js';
import { sseTransportInit } from './security/auth.js';

let runningServer: ManagedAgentMCPServer | undefined;

afterEach(async () => {
  if (!runningServer) return;

  const server = runningServer;
  runningServer = undefined;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
});

describe('Server Initialization', () => {
  it('creates server instance and registers tool handlers', async () => {
    const { server, config } = await createAgentMCPServer();
    expect(server).toBeDefined();
    expect(config.allowedWorkspaces.length).toBeGreaterThan(0);
    expect(config.agents['agy']).toBeDefined();
    expect(config.agents['claude']).toBeDefined();
  });
});

describe('agent_review tool registration', () => {
  it('lists agent_review among the server tools', async () => {
    const { server } = await createAgentMCPServer();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('agent_review');
  });
});

describe('loaded-config SSE server API', () => {
  it('uses the exact loaded config and releases its port on close', async () => {
    const config = getDefaultConfig('/tmp/agent-rack-loaded-config-sentinel');
    const context = createServerContextFromConfig(config);
    expect(context.config).toBe(config);
    expect(context.config.allowedWorkspaces).toEqual(['/tmp/agent-rack-loaded-config-sentinel']);

    const handle = await startSSEServer(context, 0);
    const port = (handle.server.address() as AddressInfo).port;
    expect(handle.url).toBe(`http://127.0.0.1:${port}/sse`);

    const client = new Client({ name: 'loaded-config-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(new SSEClientTransport(new URL(handle.url), sseTransportInit(handle.token)));
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await handle.close();
    }

    const rebound = net.createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) =>
      rebound.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it('makes startAgentMCPServer return a server with lifecycle-aware shutdown', async () => {
    const started = await startAgentMCPServer({ transport: 'sse', port: 0 });
    expect(started).toBeDefined();
    const port = (started!.address() as AddressInfo).port;

    await started!.shutdown();

    const rebound = net.createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) =>
      rebound.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it('shuts down running agent children before owned HTTP close completes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rack-owned-close-'));
    const pidFile = path.join(dir, 'child.pid');
    const config = getDefaultConfig(dir);
    config.agents['long_running'] = {
      name: 'Long Running',
      command: 'node',
      args: [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      transport: 'claude_stream_json',
      env: {},
    };
    const context = createServerContextFromConfig(config);
    const handle = await startSSEServer(context, 0);
    let childPid: number | undefined;

    try {
      context.sessionManager.createSession('long_running', 'wait', dir);
      const deadline = Date.now() + 2000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fs.existsSync(pidFile)).toBe(true);
      childPid = Number(fs.readFileSync(pidFile, 'utf8'));

      await handle.close();
      expect(() => process.kill(childPid!, 0)).toThrow();
    } finally {
      await handle.close().catch(() => undefined);
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // Already terminated as expected.
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects promptly when the requested port cannot be listened on', async () => {
    const occupied = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', resolve);
    });
    const port = (occupied.address() as AddressInfo).port;

    try {
      await expect(
        Promise.race([
          startSSEServer(createServerContextFromConfig(getDefaultConfig()), port),
          new Promise((_, reject) => setTimeout(() => reject(new Error('listen timed out')), 500)),
        ])
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});

describe('SSE sidecar (stdio + observability)', () => {
  it('shares the same session state as the stdio context it was started alongside', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rack-sidecar-'));
    const config = getDefaultConfig(dir);
    config.agents['echoer'] = {
      name: 'Echoer',
      command: 'node',
      args: ['-e', "setInterval(() => {}, 1000)"],
      transport: 'claude_stream_json',
      env: {},
    };
    const ctx = createServerContextFromConfig(config);
    // A session created as if by a stdio-connected client (e.g. Claude Code) ...
    const session = ctx.sessionManager.createSession('echoer', 'echo hi', dir);

    const handle = await startSseSidecar(ctx, 0);
    expect(handle).toBeDefined();

    const client = new Client({ name: 'sidecar-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(new SSEClientTransport(new URL(handle!.url), sseTransportInit(handle!.token)));
      // ... is visible to an independently connected SSE client hitting the same sidecar.
      const result = await client.callTool({
        name: 'agent_session_status',
        arguments: { sessionId: session.id },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text)
        .join('');
      expect(text).toContain(session.id);
    } finally {
      await client.close();
      await handle!.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is best-effort: a port already in use is logged and swallowed, not thrown', async () => {
    const occupied = net.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', resolve);
    });
    const port = (occupied.address() as AddressInfo).port;

    try {
      const ctx = createServerContextFromConfig(getDefaultConfig());
      const handle = await Promise.race([
        startSseSidecar(ctx, port),
        new Promise<undefined>((_, reject) => setTimeout(() => reject(new Error('timed out')), 500)),
      ]);
      expect(handle).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});

describe('multi-client SSE support', () => {
  it('binds to loopback and shares real sessions between independently connected clients', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rack-shared-sse-'));
    const echoScript = path.join(dir, 'echo.cjs');
    const configPath = path.join(dir, 'agent-rack.config.json');
    fs.writeFileSync(
      echoScript,
      "console.log(JSON.stringify({ type: 'assistant', text: 'shared-session' }));\n"
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        transport: 'sse',
        allowedWorkspaces: [dir],
        agents: {
          echoer: {
            name: 'Echoer',
            command: 'node',
            args: [echoScript],
            transport: 'claude_stream_json',
            env: {},
          },
        },
      })
    );

    const clientA = new Client({ name: 'client-a', version: '1.0.0' }, { capabilities: {} });
    const clientB = new Client({ name: 'client-b', version: '1.0.0' }, { capabilities: {} });

    try {
      runningServer = await startAgentMCPServer({ transport: 'sse', port: 0, configPath });
      const address = runningServer!.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      const url = new URL(`http://localhost:${address.port}/sse`);

      const transportInit = sseTransportInit(runningServer!.agentRackToken);
      await clientA.connect(new SSEClientTransport(url, transportInit));
      await clientB.connect(new SSEClientTransport(url, transportInit));

      const createdResult = await clientA.callTool({
        name: 'agent_session_create',
        arguments: { agent: 'echoer', prompt: 'hello', workspace: dir },
      });
      const createdText = (createdResult.content as Array<{ type: string; text?: string }>)[0]?.text;
      const created = JSON.parse(createdText || '{}') as { sessionId?: string };
      expect(created.sessionId).toBeTruthy();

      const listedResult = await clientB.callTool({ name: 'agent_session_list', arguments: {} });
      const listedText = (listedResult.content as Array<{ type: string; text?: string }>)[0]?.text;
      const listed = JSON.parse(listedText || '[]') as Array<{ sessionId: string }>;
      expect(listed.map((session) => session.sessionId)).toContain(created.sessionId);

      let status = 'running';
      const deadline = Date.now() + 5000;
      while (status === 'running' && Date.now() < deadline) {
        const statusResult = await clientB.callTool({
          name: 'agent_session_status',
          arguments: { sessionId: created.sessionId },
        });
        const statusText = (statusResult.content as Array<{ type: string; text?: string }>)[0]?.text;
        status = (JSON.parse(statusText || '{}') as { status?: string }).status || '';
        if (status === 'running') await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(status).toBe('completed');
    } finally {
      await Promise.allSettled([clientA.close(), clientB.close()]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
