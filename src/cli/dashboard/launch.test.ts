import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '../../config/loader.js';
import { requireAgentConfig } from '../../tools/args.js';
import { computeLaunchAgentConfig } from './launch.js';

describe('computeLaunchAgentConfig', () => {
  it('appends --model <value> when a launcher override is given', () => {
    const config = getDefaultConfig();
    const agentConfig = requireAgentConfig(config, 'codex');

    const result = computeLaunchAgentConfig(agentConfig, 'gpt-5.5');

    expect(result.args).toEqual([...agentConfig.args, '--model', 'gpt-5.5']);
  });

  it('falls back to the agent config default model when no override is given', () => {
    const config = getDefaultConfig();
    const agentConfig = { ...requireAgentConfig(config, 'codex'), model: 'gpt-5.6-sol' };

    const result = computeLaunchAgentConfig(agentConfig, undefined);

    expect(result.args).toEqual([...agentConfig.args, '--model', 'gpt-5.6-sol']);
  });

  it('prefers the launcher override over the config default', () => {
    const config = getDefaultConfig();
    const agentConfig = { ...requireAgentConfig(config, 'codex'), model: 'gpt-5.6-sol' };

    const result = computeLaunchAgentConfig(agentConfig, 'gpt-5.5');

    expect(result.args).toEqual([...agentConfig.args, '--model', 'gpt-5.5']);
  });

  it('returns the original config unchanged when neither is set', () => {
    const config = getDefaultConfig();
    const agentConfig = requireAgentConfig(config, 'codex');

    expect(computeLaunchAgentConfig(agentConfig, undefined)).toBe(agentConfig);
  });
});
