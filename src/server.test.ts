import { describe, it, expect } from 'vitest';
import { createAgentMCPServer } from './server.js';

describe('Server Initialization', () => {
  it('creates server instance and registers tool handlers', async () => {
    const { server, config } = await createAgentMCPServer();
    expect(server).toBeDefined();
    expect(config.allowedWorkspaces.length).toBeGreaterThan(0);
    expect(config.agents['agy']).toBeDefined();
    expect(config.agents['claude']).toBeDefined();
  });
});
