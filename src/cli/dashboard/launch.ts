import { AgentConfig } from '../../config/schema.js';
import { applyModelOverride, resolveModel } from '../../tools/args.js';

/**
 * Resolves the effective agent config for a dashboard-launched session: a launcher-entered
 * model override wins, falling back to the agent's configured default model.
 */
export function computeLaunchAgentConfig(agentConfig: AgentConfig, modelOverride: string | undefined): AgentConfig {
  return applyModelOverride(agentConfig, resolveModel({ model: modelOverride }, agentConfig));
}
