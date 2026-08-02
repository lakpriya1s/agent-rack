import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../../config/loader.js';
import { formatDashboardConnectionFailure, resolveDashboardServerUrl } from './connection.js';

describe('resolveDashboardServerUrl', () => {
  it('uses 8987 as the generated config and dashboard default', () => {
    expect(getDefaultConfig().port).toBe(8987);
    const config = getDefaultConfig();
    config.transport = 'stdio';
    config.port = undefined;
    expect(resolveDashboardServerUrl(config, undefined)).toEqual({
      url: 'http://127.0.0.1:8987/sse',
    });
  });

  it('uses the loaded port regardless of configured transport', () => {
    const config = getDefaultConfig();
    config.transport = 'stdio';
    config.port = 9123;
    expect(resolveDashboardServerUrl(config, undefined)).toEqual({
      url: 'http://127.0.0.1:9123/sse',
    });
  });

  it('preserves an explicit external --connect URL', () => {
    const config = getDefaultConfig();
    expect(resolveDashboardServerUrl(config, 'http://example.com:9999/sse')).toEqual({
      url: 'http://example.com:9999/sse',
    });
  });
});

describe('formatDashboardConnectionFailure', () => {
  it('reports an external connection failure without suggesting auto-start', () => {
    const message = formatDashboardConnectionFailure(
      'http://example.com:9999/sse',
      new Error('socket refused')
    );

    expect(message).toContain('Could not connect to the agent-rack server at http://example.com:9999/sse.');
    expect(message).toContain('socket refused');
    expect(message).toContain('--connect is external-only');
    expect(message).not.toContain('start --transport');
  });
});
