import { describe, it, expect } from 'vitest';
import {
  applyExecutionPolicy,
  describeUnenforcedPolicy,
  ExecutionPolicyError,
  resolveExecutionMode,
  resolvePolicySupport,
  stripEscapeHatchArgs,
} from './policy.js';
import type { AgentConfig } from '../config/schema.js';

const baseConfig = (overrides: Partial<AgentConfig>): AgentConfig => ({
  name: 'Test',
  command: 'test',
  args: [],
  transport: 'pty_interactive',
  env: {},
  ...overrides,
});

describe('resolvePolicySupport', () => {
  it('maps each policy onto codex --sandbox values verbatim', () => {
    expect(resolvePolicySupport('codex_exec_json', 'read-only').mode).toBe('read-only');
    expect(resolvePolicySupport('codex_exec_json', 'workspace-write').mode).toBe('workspace-write');
    expect(resolvePolicySupport('codex_exec_json', 'danger-full-access').mode).toBe('danger-full-access');
  });

  it('maps policies onto claude permission modes', () => {
    expect(resolvePolicySupport('claude_stream_json', 'read-only').mode).toBe('plan');
    expect(resolvePolicySupport('claude_stream_json', 'workspace-write').mode).toBe('acceptEdits');
    expect(resolvePolicySupport('claude_stream_json', 'danger-full-access').mode).toBe('bypassPermissions');
  });

  it('reports codex as natively enforcing anything short of full access', () => {
    expect(resolvePolicySupport('codex_exec_json', 'read-only').isNativelyEnforced).toBe(true);
    expect(resolvePolicySupport('codex_exec_json', 'workspace-write').isNativelyEnforced).toBe(true);
  });

  it('does not claim claude enforces workspace-write, since acceptEdits only auto-approves prompts', () => {
    expect(resolvePolicySupport('claude_stream_json', 'read-only').isNativelyEnforced).toBe(true);
    expect(resolvePolicySupport('claude_stream_json', 'workspace-write').isNativelyEnforced).toBe(false);
  });

  it('reports no native enforcement for transports with no sandbox flag', () => {
    for (const transport of ['agy_stream', 'pty_interactive'] as const) {
      const support = resolvePolicySupport(transport, 'read-only');
      expect(support.mode).toBeUndefined();
      expect(support.isNativelyEnforced).toBe(false);
    }
  });
});

describe('resolveExecutionMode', () => {
  it('derives the mode from the policy when the caller asks for nothing', () => {
    expect(resolveExecutionMode('codex_exec_json', 'workspace-write')).toBe('workspace-write');
  });

  it('allows a per-call mode that narrows authority', () => {
    expect(resolveExecutionMode('codex_exec_json', 'workspace-write', 'read-only')).toBe('read-only');
    expect(resolveExecutionMode('claude_stream_json', 'workspace-write', 'plan')).toBe('plan');
  });

  it('refuses a per-call mode that escalates beyond the policy', () => {
    // Without this the policy would be advisory: any client could opt itself back up.
    expect(() => resolveExecutionMode('codex_exec_json', 'read-only', 'danger-full-access')).toThrow(
      ExecutionPolicyError
    );
    expect(() => resolveExecutionMode('claude_stream_json', 'read-only', 'bypassPermissions')).toThrow(
      ExecutionPolicyError
    );
    expect(() => resolveExecutionMode('codex_exec_json', 'workspace-write', 'danger-full-access')).toThrow(
      ExecutionPolicyError
    );
  });

  it('permits full access only when the policy is danger-full-access', () => {
    expect(resolveExecutionMode('codex_exec_json', 'danger-full-access', 'danger-full-access')).toBe(
      'danger-full-access'
    );
  });

  it('passes through modes it cannot rank rather than guessing their authority', () => {
    expect(resolveExecutionMode('pty_interactive', 'read-only', 'something-custom')).toBe(
      'something-custom'
    );
  });
});

describe('stripEscapeHatchArgs', () => {
  it('removes --dangerously-skip-permissions for claude_stream_json', () => {
    const config = baseConfig({
      transport: 'claude_stream_json',
      args: ['--dangerously-skip-permissions', '--output-format', 'json'],
    });

    expect(stripEscapeHatchArgs(config).args).toEqual(['--output-format', 'json']);
    // Original config is untouched.
    expect(config.args).toContain('--dangerously-skip-permissions');
  });

  it('also removes --allow-dangerously-skip-permissions, which re-enables the first flag', () => {
    const config = baseConfig({
      transport: 'claude_stream_json',
      args: ['--allow-dangerously-skip-permissions', '--output-format', 'json'],
    });

    expect(stripEscapeHatchArgs(config).args).toEqual(['--output-format', 'json']);
  });

  it('removes --dangerously-bypass-approvals-and-sandbox for codex_exec_json', () => {
    const config = baseConfig({
      transport: 'codex_exec_json',
      args: ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'],
    });

    expect(stripEscapeHatchArgs(config).args).toEqual(['exec', '--json', '--skip-git-repo-check']);
  });

  it('returns the config unchanged for transports without a known escape hatch', () => {
    const config = baseConfig({ transport: 'agy_stream', args: ['--print'] });
    expect(stripEscapeHatchArgs(config)).toBe(config);
  });

  it('returns the config unchanged when no escape-hatch flag is present', () => {
    const config = baseConfig({ transport: 'claude_stream_json', args: ['--output-format', 'json'] });
    expect(stripEscapeHatchArgs(config)).toBe(config);
  });
});

describe('applyExecutionPolicy', () => {
  it('strips a user-configured escape hatch under a restrictive policy', () => {
    // The whole point: a leftover bypass flag would silently nullify the mode we pass.
    const config = baseConfig({
      transport: 'codex_exec_json',
      args: ['exec', '--dangerously-bypass-approvals-and-sandbox'],
    });

    expect(applyExecutionPolicy(config, 'workspace-write').args).toEqual(['exec']);
    expect(applyExecutionPolicy(config, 'read-only').args).toEqual(['exec']);
  });

  it('leaves the escape hatch in place under danger-full-access', () => {
    const config = baseConfig({
      transport: 'codex_exec_json',
      args: ['exec', '--dangerously-bypass-approvals-and-sandbox'],
    });

    expect(applyExecutionPolicy(config, 'danger-full-access')).toBe(config);
  });
});

describe('describeUnenforcedPolicy', () => {
  it('stays silent when the CLI really does enforce the policy', () => {
    expect(describeUnenforcedPolicy('codex_exec_json', 'read-only')).toBeNull();
    expect(describeUnenforcedPolicy('claude_stream_json', 'read-only')).toBeNull();
  });

  it('warns for transports that can only honour a policy by instruction', () => {
    expect(describeUnenforcedPolicy('pty_interactive', 'read-only')).toMatch(/best effort/i);
    expect(describeUnenforcedPolicy('agy_stream', 'workspace-write')).toMatch(/prompt instruction/i);
    expect(describeUnenforcedPolicy('claude_stream_json', 'workspace-write')).toMatch(/no filesystem sandbox/i);
  });

  it('does not warn about full access, which promises nothing to begin with', () => {
    expect(describeUnenforcedPolicy('pty_interactive', 'danger-full-access')).toBeNull();
  });
});
