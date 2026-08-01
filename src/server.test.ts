import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAgentMCPServer, startAgentMCPServer } from './server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { AddressInfo } from 'net';
import type http from 'http';

let runningServer: http.Server | undefined;

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

      await clientA.connect(new SSEClientTransport(url));
      await clientB.connect(new SSEClientTransport(url));

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
