import { describe, it, expect } from 'vitest';
import { createAgentMCPServer } from './server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
