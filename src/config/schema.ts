import { z } from 'zod';

export const DEFAULT_SSE_PORT = 8987;

export const AgentTransportTypeSchema = z.enum([
  'claude_stream_json',
  'agy_stream',
  'pty_interactive',
  'codex_exec_json',
]);

export type AgentTransportType = z.infer<typeof AgentTransportTypeSchema>;

/**
 * How much authority a spawned sub-agent gets. This is the knob users reach for; the
 * per-transport translation into real CLI flags lives in `security/policy.ts`.
 *
 * `workspace-write` is the default. `danger-full-access` must be opted into explicitly —
 * it is the only policy under which agent-rack passes a CLI's own permission/sandbox
 * escape-hatch flag.
 */
export const ExecutionPolicySchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);

export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

export const AgentConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  transport: AgentTransportTypeSchema,
  env: z.record(z.string(), z.string()).default({}),
  description: z.string().optional(),
  /** Default model to pass via `--model` when a tool call doesn't override it. */
  model: z.string().optional(),
  /**
   * Names of parent-process environment variables this agent may inherit. When set, this is
   * an allowlist and nothing outside it is passed through — the only way to be sure a
   * credential never reaches a sub-agent, since a denylist is always incomplete. When
   * omitted, `security.sanitizeEnv`'s pattern denylist applies instead.
   */
  inheritEnv: z.array(z.string()).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const SecurityConfigSchema = z.object({
  sanitizeEnv: z.boolean().default(true),
  maxConcurrentSessions: z.number().int().positive().default(5),
  defaultTimeoutSeconds: z.number().int().positive().default(600),
  /** Authority granted to sub-agents. See ExecutionPolicySchema. */
  executionPolicy: ExecutionPolicySchema.default('workspace-write'),
  /**
   * How long a finished (completed/failed/cancelled) session stays queryable before it is
   * pruned. Without this the session map grows for the lifetime of the process.
   */
  sessionRetentionMinutes: z.number().int().positive().default(60),
  /** Hard cap on retained finished sessions, applied oldest-first regardless of age. */
  maxRetainedSessions: z.number().int().positive().default(200),
  /**
   * Byte budget for a single session's retained event log. One tool result can carry
   * megabytes of command output, so an event count alone does not bound memory.
   */
  maxSessionOutputBytes: z.number().int().positive().default(5_000_000),
  /**
   * Require a bearer token on the SSE transport. Loopback binding alone does not stop
   * another local process (or a webpage doing DNS rebinding) from driving this server.
   */
  requireSseAuth: z.boolean().default(true),
});

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const AgentMCPConfigSchema = z.object({
  port: z.number().int().positive().optional(),
  transport: z.enum(['stdio', 'sse']).default('stdio'),
  allowedWorkspaces: z.array(z.string()).min(1),
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  security: SecurityConfigSchema.default({
    sanitizeEnv: true,
    maxConcurrentSessions: 5,
    defaultTimeoutSeconds: 600,
    executionPolicy: 'workspace-write',
    sessionRetentionMinutes: 60,
    maxRetainedSessions: 200,
    maxSessionOutputBytes: 5_000_000,
    requireSseAuth: true,
  }),
});

export type AgentMCPConfig = z.infer<typeof AgentMCPConfigSchema>;
