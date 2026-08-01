import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../config/loader.js';
import { requireAgentConfig, resolveTimeoutSeconds, resolveWorkspace } from './args.js';

describe('resolveWorkspace', () => {
  it('uses the supplied workspace when present', () => {
    const config = getDefaultConfig('/tmp/somewhere');
    expect(resolveWorkspace({ workspace: '/tmp/elsewhere' }, config)).toBe('/tmp/elsewhere');
  });

  it('falls back to the first allowed workspace', () => {
    const config = getDefaultConfig('/tmp/somewhere');
    expect(resolveWorkspace({}, config)).toBe(config.allowedWorkspaces[0]);
  });
});

describe('resolveTimeoutSeconds', () => {
  it('uses the supplied numeric timeout', () => {
    const config = getDefaultConfig();
    expect(resolveTimeoutSeconds({ timeoutSeconds: 30 }, config)).toBe(30);
  });

  it('falls back to the schema-provided default rather than a hardcoded literal', () => {
    const config = getDefaultConfig();
    config.security.defaultTimeoutSeconds = 42;
    expect(resolveTimeoutSeconds({}, config)).toBe(42);
  });

  it('ignores non-numeric timeouts', () => {
    const config = getDefaultConfig();
    expect(resolveTimeoutSeconds({ timeoutSeconds: '30' }, config)).toBe(
      config.security.defaultTimeoutSeconds
    );
  });
});

describe('requireAgentConfig', () => {
  it('returns the configured agent', () => {
    const config = getDefaultConfig();
    expect(requireAgentConfig(config, 'claude').command).toBe('claude');
  });

  it('throws for an unknown agent', () => {
    const config = getDefaultConfig();
    expect(() => requireAgentConfig(config, 'nope')).toThrow(
      "Agent 'nope' is not configured in agent-rack."
    );
  });
});
