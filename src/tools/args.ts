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

/** Looks up a configured agent, throwing the shared not-configured error when absent. */
export function requireAgentConfig(config: AgentMCPConfig, agentId: string): AgentConfig {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    throw new Error(`Agent '${agentId}' is not configured in agent-mcp.`);
  }
  return agentConfig;
}
