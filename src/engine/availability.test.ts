import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../config/loader.js';
import { isBinaryAvailable, listAgentAvailability } from './availability.js';

describe('isBinaryAvailable', () => {
  it('finds a binary that is on $PATH', async () => {
    expect(await isBinaryAvailable('node')).toBe(true);
  });

  it('reports a binary that is not on $PATH', async () => {
    expect(await isBinaryAvailable('definitely-not-a-real-binary-xyz')).toBe(false);
  });
});

describe('listAgentAvailability', () => {
  it('reports status per agent and preserves config order', async () => {
    const config = getDefaultConfig();
    config.agents = {
      present: {
        name: 'Present',
        command: 'node',
        args: [],
        transport: 'pty_interactive',
        env: {},
        description: 'exists on PATH',
      },
      absent: {
        name: 'Absent',
        command: 'definitely-not-a-real-binary-xyz',
        args: [],
        transport: 'pty_interactive',
        env: {},
      },
    };

    const result = await listAgentAvailability(config);

    expect(result.map((a) => a.agentId)).toEqual(['present', 'absent']);
    expect(result[0].status).toBe('available');
    expect(result[0].description).toBe('exists on PATH');
    expect(result[1].status).toBe('missing_binary');
    // Agents without a description surface an empty string, not undefined.
    expect(result[1].description).toBe('');
  });
});
