import { AgentConfig, AgentMCPConfig, ExecutionPolicy } from '../config/schema.js';
import {
  applyExecutionPolicy,
  describeUnenforcedPolicy,
  resolveExecutionMode,
} from '../security/policy.js';

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

export interface ResolvedExecution {
  agentConfig: AgentConfig;
  /** Mode to hand the adapter — policy-derived unless the caller asked for a narrower one. */
  mode?: string;
  /** Non-null when the transport cannot actually enforce the policy (best-effort only). */
  policyWarning: string | null;
}

/**
 * Single place every tool goes through to turn a request into a spawnable agent config.
 *
 * Both `agent_run` and `agent_review` used to assemble this themselves, which is how the
 * escape-hatch flags ended up honoured in one path and stripped in the other. Routing every
 * caller through here means a policy cannot be enforced in one tool and ignored in another.
 */
export function resolveExecution(
  config: AgentMCPConfig,
  agentId: string,
  args: Record<string, unknown>,
  overrides: {
    policy?: ExecutionPolicy;
    /**
     * Ignore any `mode` in `args` and let the policy decide it outright. `agent_review` sets
     * this: it must run at its own policy's mode, not at one a caller supplied.
     */
    ignoreRequestedMode?: boolean;
  } = {}
): ResolvedExecution {
  const base = requireAgentConfig(config, agentId);
  const policy = overrides.policy ?? config.security.executionPolicy;
  const requestedMode =
    overrides.ignoreRequestedMode || typeof args.mode !== 'string' ? undefined : args.mode;

  const mode = resolveExecutionMode(base.transport, policy, requestedMode);
  const policed = applyExecutionPolicy(base, policy);
  const agentConfig = applyModelOverride(policed, resolveModel(args, base));

  return {
    agentConfig,
    mode,
    policyWarning: describeUnenforcedPolicy(base.transport, policy),
  };
}

/** Looks up a configured agent, throwing the shared not-configured error when absent. */
export function requireAgentConfig(config: AgentMCPConfig, agentId: string): AgentConfig {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) {
    throw new Error(`Agent '${agentId}' is not configured in agent-rack.`);
  }
  return agentConfig;
}
