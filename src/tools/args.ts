import { AgentConfig, AgentMCPConfig } from '../config/schema.js';

/**
 * Shared coercion for the arguments every agent-facing tool accepts. MCP tool arguments
 * arrive as `Record<string, unknown>`, so each tool would otherwise repeat the same
 * defaulting rules — and drift on them.
 */

/** Target workspace, falling back to the first entry in `allowedWorkspaces`. */
export function resolveWorkspace(args: Record<string, unknown>, config: AgentMCPConfig): string {
  return args.workspace ? String(args.workspace) : config.allowedWorkspaces[0];
}

/**
 * Execution timeout in seconds. The zod schema already guarantees
 * `security.defaultTimeoutSeconds`, so there is no literal fallback here.
 */
export function resolveTimeoutSeconds(args: Record<string, unknown>, config: AgentMCPConfig): number {
  return typeof args.timeoutSeconds === 'number'
    ? args.timeoutSeconds
    : config.security.defaultTimeoutSeconds;
}

/** Runtime `model` argument, falling back to the agent's configured default model. */
export function resolveModel(args: Record<string, unknown>, agentConfig: AgentConfig): string | undefined {
  return typeof args.model === 'string' && args.model.length > 0 ? args.model : agentConfig.model;
}

/** Returns a shallow copy of `agentConfig` with `--model <model>` appended to `args`. */
export function applyModelOverride(agentConfig: AgentConfig, model: string | undefined): AgentConfig {
  if (!model) return agentConfig;
  return { ...agentConfig, args: [...agentConfig.args, '--model', model] };
}

/** Looks up a configured agent, throwing the shared not-configured error when absent. */
export function requireAgentConfig(config: AgentMCPConfig, agentId: string): AgentConfig {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    throw new Error(`Agent '${agentId}' is not configured in agent-rack.`);
  }
  return agentConfig;
}
