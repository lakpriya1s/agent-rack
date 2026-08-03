import type { AgentConfig, AgentTransportType, ExecutionPolicy } from '../config/schema.js';

/**
 * Translates an `ExecutionPolicy` into the real CLI flags each agent understands.
 *
 * Two things are deliberately kept apart here:
 *
 *  - **What we ask for** — the mode/args we pass. Always derivable.
 *  - **Whether the CLI actually enforces it** (`isNativelyEnforced`). Only codex ships a
 *    real filesystem sandbox; claude has permission modes (a prompt-gating mechanism, not a
 *    sandbox) and agy/pty have neither. Callers that care about a guarantee — `agent_review`
 *    above all — must check enforcement rather than assume asking was enough.
 *
 * `validateWorkspacePath` is a separate and weaker boundary: it constrains the working
 * directory a sub-agent is launched in, not what that process can then reach.
 */

/** Ranks a policy so an explicit per-call mode can be checked for escalation. */
const POLICY_RANK: Record<ExecutionPolicy, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};

/**
 * Claude Code's `--permission-mode` values, ranked by authority. Verified against CLI
 * 2.1.220: choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.
 * These gate *prompting*, not filesystem access, which is why claude reports
 * `isNativelyEnforced: false` for anything but read-only planning.
 */
const CLAUDE_MODE_RANK: Record<string, number> = {
  plan: 0,
  manual: 1,
  acceptEdits: 1,
  auto: 1,
  dontAsk: 1,
  bypassPermissions: 2,
};

/** Codex's `--sandbox` values happen to be spelled exactly like our policies. */
const CODEX_MODE_RANK: Record<string, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};

const CLAUDE_POLICY_MODE: Record<ExecutionPolicy, string> = {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'danger-full-access': 'bypassPermissions',
};

/**
 * The per-transport flag that disables a CLI's own permission/sandbox enforcement. agent-rack
 * only ever passes these under `danger-full-access`; they are stripped from the agent's
 * configured args under every other policy, because leaving one in place silently nullifies
 * whatever mode we asked for.
 *
 * Verified against the shipping CLIs: `claude --help` lists both `--dangerously-skip-permissions`
 * and `--allow-dangerously-skip-permissions` (the latter enables the former, so leaving it
 * behind would re-open the hole); `codex exec --help` lists only
 * `--dangerously-bypass-approvals-and-sandbox`.
 */
export const ESCAPE_HATCH_ARGS: Partial<Record<AgentTransportType, string[]>> = {
  claude_stream_json: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'],
  codex_exec_json: ['--dangerously-bypass-approvals-and-sandbox'],
};

export interface TransportPolicySupport {
  /** The mode string to hand the adapter, or undefined when the transport has no mode flag. */
  mode?: string;
  /** True only when the CLI itself constrains filesystem/network access, not just prompting. */
  isNativelyEnforced: boolean;
}

export function resolvePolicySupport(
  transport: AgentTransportType,
  policy: ExecutionPolicy
): TransportPolicySupport {
  switch (transport) {
    case 'codex_exec_json':
      // `--sandbox read-only|workspace-write|danger-full-access` is a real OS-level sandbox.
      return { mode: policy, isNativelyEnforced: policy !== 'danger-full-access' };
    case 'claude_stream_json':
      // `plan` genuinely prevents edits; acceptEdits only auto-approves prompts.
      return {
        mode: CLAUDE_POLICY_MODE[policy],
        isNativelyEnforced: policy === 'read-only',
      };
    case 'agy_stream':
    case 'pty_interactive':
    default:
      // No documented sandbox or permission flag: policy is prompt-level only.
      return { mode: undefined, isNativelyEnforced: false };
  }
}

function modeRank(transport: AgentTransportType, mode: string): number | undefined {
  const table =
    transport === 'claude_stream_json'
      ? CLAUDE_MODE_RANK
      : transport === 'codex_exec_json'
        ? CODEX_MODE_RANK
        : undefined;
  return table?.[mode];
}

export class ExecutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionPolicyError';
  }
}

/**
 * Picks the mode to run with, refusing a per-call `mode` that would grant more authority
 * than the configured policy. Without this check, `executionPolicy: 'read-only'` would be
 * advisory — any caller could pass `mode: 'bypassPermissions'` and walk straight through it.
 *
 * A mode we don't recognize for the transport is passed through untouched: adapters already
 * ignore unknown modes, and guessing at its authority would be worse than either extreme.
 */
export function resolveExecutionMode(
  transport: AgentTransportType,
  policy: ExecutionPolicy,
  requestedMode?: string
): string | undefined {
  const support = resolvePolicySupport(transport, policy);
  if (!requestedMode) return support.mode;

  const requestedRank = modeRank(transport, requestedMode);
  if (requestedRank !== undefined && requestedRank > POLICY_RANK[policy]) {
    throw new ExecutionPolicyError(
      `Mode '${requestedMode}' grants more authority than the configured executionPolicy ` +
        `'${policy}'. Raise security.executionPolicy in your agent-rack config to allow it.`
    );
  }
  return requestedMode;
}

/** Strips every known escape-hatch flag for the transport from a copy of `agentConfig`. */
export function stripEscapeHatchArgs(agentConfig: AgentConfig): AgentConfig {
  const hatches = ESCAPE_HATCH_ARGS[agentConfig.transport];
  if (!hatches) return agentConfig;

  const filtered = agentConfig.args.filter((arg) => !hatches.includes(arg));
  if (filtered.length === agentConfig.args.length) return agentConfig;

  return { ...agentConfig, args: filtered };
}

/**
 * Brings an agent config in line with the policy before it is ever spawned. Under any policy
 * short of `danger-full-access` this removes escape-hatch flags the user may have configured,
 * so the mode we pass actually means something.
 */
export function applyExecutionPolicy(
  agentConfig: AgentConfig,
  policy: ExecutionPolicy
): AgentConfig {
  if (policy === 'danger-full-access') return agentConfig;
  return stripEscapeHatchArgs(agentConfig);
}

/**
 * Human-readable warning for transports that cannot enforce the requested policy, so callers
 * can surface "best-effort" rather than implying a guarantee. Returns null when enforced.
 */
export function describeUnenforcedPolicy(
  transport: AgentTransportType,
  policy: ExecutionPolicy
): string | null {
  if (resolvePolicySupport(transport, policy).isNativelyEnforced) return null;
  if (policy === 'danger-full-access') return null;

  if (transport === 'claude_stream_json') {
    return `Claude Code has no filesystem sandbox; '${policy}' is enforced by permission prompts and instructions only.`;
  }
  return `Transport '${transport}' has no sandbox or permission flag; '${policy}' is enforced by prompt instruction only (best effort).`;
}
