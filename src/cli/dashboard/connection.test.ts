import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../../config/loader.js';
import {
  formatDashboardConnectionFailure,
  formatSharedDashboardHelp,
  resolveDashboardServerUrl,
} from './connection.js';

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

  it('does not offer a local start command for IPv6 loopback URLs', () => {
    const help = formatSharedDashboardHelp('http://[::1]:9999/sse');

    expect(help).toContain(
      'Ensure the shared MCP server at http://[::1]:9999/sse is running.'
    );
    expect(help).not.toContain('npx agent-rack@latest start');
  });

  it('does not offer a local start command for unsupported paths', () => {
    const help = formatSharedDashboardHelp('http://localhost:9999/events');

    expect(help).toContain(
      'Ensure the shared MCP server at http://localhost:9999/events is running.'
    );
    expect(help).not.toContain('npx agent-rack@latest start');
  });

  it('does not offer a local start command for a non-addressable port', () => {
    const help = formatSharedDashboardHelp('http://localhost:0/sse');

    expect(help).toContain('Ensure the shared MCP server at http://localhost:0/sse is running.');
    expect(help).not.toContain('npx agent-rack@latest start');
  });

  it('uses HTTP port 80 for a portless localhost URL', () => {
    const help = formatSharedDashboardHelp('http://localhost/sse');

    expect(help).toContain('npx agent-rack@latest start --transport sse --port 80');
    expect(help).toContain('npx agent-rack@latest dashboard --connect http://localhost/sse');
  });

  it('quotes query metacharacters in the dashboard command', () => {
    const serverUrl = 'http://localhost:9999/sse?mode=a&next=b;done=yes';
    const help = formatSharedDashboardHelp(serverUrl);

    expect(help).toContain(
      "npx agent-rack@latest dashboard --connect 'http://localhost:9999/sse?mode=a&next=b;done=yes'"
    );
  });

  it('quotes embedded single quotes in the dashboard command', () => {
    const serverUrl = "http://localhost:9999/sse?label=it's";
    const help = formatSharedDashboardHelp(serverUrl);

    expect(help).toContain(
      `npx agent-rack@latest dashboard --connect 'http://localhost:9999/sse?label=it'"'"'s'`
    );
  });

  it('does not offer a local start command for a remote URL', () => {
    const help = formatSharedDashboardHelp('http://example.com:9999/sse');

    expect(help).toContain(
      'Ensure the shared MCP server at http://example.com:9999/sse is running.'
    );
    expect(help).not.toContain('npx agent-rack@latest start');
    expect(help).toContain(
      'npx agent-rack@latest dashboard --connect http://example.com:9999/sse'
    );
  });
});

describe('formatDashboardConnectionFailure', () => {
  it('combines the requested URL, original error, and shared-dashboard help', () => {
    const message = formatDashboardConnectionFailure(
      'http://localhost:9999/sse',
      new Error('socket refused')
    );

    expect(message).toContain('Could not reach the agent-rack server at http://localhost:9999/sse.');
    expect(message).toContain('Connection error: socket refused');
    expect(message).toContain('npx agent-rack@latest start --transport sse --port 9999');
    expect(message).toContain('agent_session_list');
    expect(message).toContain('private stdio');
  });
});
