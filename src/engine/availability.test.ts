import { describe, it, expect, afterEach } from 'vitest';
import { getDefaultConfig } from '../config/loader.js';
import { isBinaryAvailable, listAgentAvailability, locatorCommand } from './availability.js';

describe('isBinaryAvailable', () => {
  it('finds a binary that is on $PATH', async () => {
    expect(await isBinaryAvailable('node')).toBe(true);
  });

  it('reports a binary that is not on $PATH', async () => {
    expect(await isBinaryAvailable('definitely-not-a-real-binary-xyz')).toBe(false);
  });
});

describe('locatorCommand', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses `where` on win32, since `which` does not exist there', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(locatorCommand()).toBe('where');
  });

  it('uses `which` on POSIX platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(locatorCommand()).toBe('which');
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
