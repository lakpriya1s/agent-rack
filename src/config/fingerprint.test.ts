import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from './loader.js';
import { fingerprintAgentMCPConfig } from './fingerprint.js';

describe('fingerprintAgentMCPConfig', () => {
  it('is deterministic across object key insertion order', () => {
    const first = getDefaultConfig('/tmp/fingerprint-workspace');
    const second = getDefaultConfig('/tmp/fingerprint-workspace');
    second.agents = Object.fromEntries(Object.entries(second.agents).reverse());

    expect(fingerprintAgentMCPConfig(first)).toBe(fingerprintAgentMCPConfig(second));
  });

  it('normalizes an omitted port to the effective default', () => {
    const explicit = getDefaultConfig('/tmp/fingerprint-workspace');
    const omitted = getDefaultConfig('/tmp/fingerprint-workspace');
    delete omitted.port;

    expect(fingerprintAgentMCPConfig(explicit)).toBe(fingerprintAgentMCPConfig(omitted));
  });

  it('changes when authoritative workspace restrictions differ', () => {
    const first = getDefaultConfig('/tmp/project-a');
    const second = getDefaultConfig('/tmp/project-b');

    expect(fingerprintAgentMCPConfig(first)).not.toBe(fingerprintAgentMCPConfig(second));
  });
});
