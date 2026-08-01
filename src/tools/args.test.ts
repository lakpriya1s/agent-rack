import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../config/loader.js';
import {
  applyModelOverride,
  requireAgentConfig,
  resolveModel,
  resolveTimeoutSeconds,
  resolveWorkspace,
} from './args.js';

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

describe('resolveModel', () => {
  it('uses the runtime model argument when present', () => {
    const config = getDefaultConfig();
    const agentConfig = requireAgentConfig(config, 'codex');
    expect(resolveModel({ model: 'gpt-5.5' }, agentConfig)).toBe('gpt-5.5');
  });

  it('falls back to the agent config default model', () => {
    const config = getDefaultConfig();
    const agentConfig = { ...requireAgentConfig(config, 'codex'), model: 'gpt-5.6-sol' };
    expect(resolveModel({}, agentConfig)).toBe('gpt-5.6-sol');
  });

  it('prefers the runtime argument over the config default', () => {
    const config = getDefaultConfig();
    const agentConfig = { ...requireAgentConfig(config, 'codex'), model: 'gpt-5.6-sol' };
    expect(resolveModel({ model: 'gpt-5.5' }, agentConfig)).toBe('gpt-5.5');
  });

  it('returns undefined when neither is set', () => {
    const config = getDefaultConfig();
    const agentConfig = requireAgentConfig(config, 'codex');
    expect(resolveModel({}, agentConfig)).toBeUndefined();
  });

  it('ignores a non-string runtime model argument', () => {
    const config = getDefaultConfig();
    const agentConfig = requireAgentConfig(config, 'codex');
    expect(resolveModel({ model: 42 }, agentConfig)).toBeUndefined();
  });
});

describe('applyModelOverride', () => {
  it('appends --model <value> to args when a model is given', () => {
    const config = getDefaultConfig();
    const agentConfig = requireAgentConfig(config, 'codex');

    const overridden = applyModelOverride(agentConfig, 'gpt-5.5');

    expect(overridden.args).toEqual([...agentConfig.args, '--model', 'gpt-5.5']);
    // Original config is untouched.
    expect(agentConfig.args).not.toContain('--model');
  });

  it('returns the original config unchanged when no model is given', () => {
    const config = getDefaultConfig();
    const agentConfig = requireAgentConfig(config, 'codex');

    expect(applyModelOverride(agentConfig, undefined)).toBe(agentConfig);
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
