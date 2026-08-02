import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../../config/loader.js';
import { formatSharedDashboardHelp, resolveDashboardServerUrl } from './connection.js';

describe('resolveDashboardServerUrl', () => {
  it('uses 8987 as the generated config and shared-server default', () => {
    expect(getDefaultConfig().port).toBe(8987);
  });

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

  it('defaults to port 8987 when transport is sse but no port is set', () => {
    const config = getDefaultConfig();
    config.transport = 'sse';
    config.port = undefined;
    const result = resolveDashboardServerUrl(config, undefined);
    expect(result).toEqual({ url: 'http://localhost:8987/sse' });
  });

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

  it('recognizes IPv6 loopback URLs as local shared servers', () => {
    const help = formatSharedDashboardHelp('http://[::1]:9999/sse');

    expect(help).toContain('npx agent-rack@latest start --transport sse --port 9999');
  });
});
