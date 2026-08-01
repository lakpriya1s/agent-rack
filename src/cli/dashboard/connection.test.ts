import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../../config/loader.js';
import { resolveDashboardServerUrl } from './connection.js';

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

  it('returns an error when transport is stdio and no --connect flag is given', () => {
    const config = getDefaultConfig();
    config.transport = 'stdio';
    const result = resolveDashboardServerUrl(config, undefined);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('shared');
      expect(result.error).toContain('sse');
    }
  });
});
