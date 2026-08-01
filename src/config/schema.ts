import { z } from 'zod';

export const AgentTransportTypeSchema = z.enum([
  'claude_stream_json',
  'agy_stream',
  'pty_interactive',
  'codex_exec_json',
]);

export type AgentTransportType = z.infer<typeof AgentTransportTypeSchema>;

export const AgentConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  transport: AgentTransportTypeSchema,
  env: z.record(z.string(), z.string()).default({}),
  description: z.string().optional(),
  /** Default model to pass via `--model` when a tool call doesn't override it. */
  model: z.string().optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const SecurityConfigSchema = z.object({
  sanitizeEnv: z.boolean().default(true),
  maxConcurrentSessions: z.number().int().positive().default(5),
  defaultTimeoutSeconds: z.number().int().positive().default(600),
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
  }),
});

export type AgentMCPConfig = z.infer<typeof AgentMCPConfigSchema>;
