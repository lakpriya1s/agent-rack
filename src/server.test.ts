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
