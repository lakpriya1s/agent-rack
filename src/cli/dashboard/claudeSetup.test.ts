import { describe, expect, it, vi } from 'vitest';
import {
  ensureClaudeDashboardRegistration,
  parseClaudeMcpGet,
  type ClaudeCommandRunner,
} from './claudeSetup.js';

const localSse = `agent-rack:
  Scope: Local config (private to you in this project)
  Status: ✔ Connected
  Type: sse
  URL: http://127.0.0.1:8987/sse
`;

describe('parseClaudeMcpGet', () => {
  it.each([
    ['Local config (private to you in this project)', 'local'],
    ['Project config (shared with your team)', 'project'],
    ['User config (available in all your projects)', 'user'],
  ] as const)('parses %s as %s scope', (label, scope) => {
    expect(parseClaudeMcpGet(`agent-rack:\n  Scope: ${label}\n  Type: sse\n  URL: http://127.0.0.1:8987/sse`)).toEqual({
      exists: true,
      scope,
      type: 'sse',
      url: 'http://127.0.0.1:8987/sse',
    });
  });

  it('parses JSON output while preserving effective scope and SSE URL', () => {
    expect(
      parseClaudeMcpGet(
        JSON.stringify({
          name: 'agent-rack',
          scope: 'user',
          type: 'sse',
          url: 'http://127.0.0.1:8987/sse',
        })
      )
    ).toEqual({
      exists: true,
      scope: 'user',
      type: 'sse',
      url: 'http://127.0.0.1:8987/sse',
    });
  });

  it('parses restorable JSON environment and HTTP header settings', () => {
    expect(
      parseClaudeMcpGet(
        JSON.stringify({
          name: 'agent-rack',
          scope: 'project',
          type: 'http',
          url: 'https://example.test/mcp',
          env: { API_KEY: 'secret-value' },
          headers: { Authorization: 'Bearer token-value' },
        })
      )
    ).toEqual({
      exists: true,
      scope: 'project',
      type: 'http',
      url: 'https://example.test/mcp',
      env: { API_KEY: 'secret-value' },
      headers: ['Authorization: Bearer token-value'],
    });
  });

  it('marks JSON registrations with unsupported authentication settings as unsafe to replace', () => {
    expect(
      parseClaudeMcpGet(
        JSON.stringify({
          name: 'agent-rack',
          scope: 'user',
          type: 'sse',
          url: 'https://example.test/sse',
          clientId: 'private-client-id',
        })
      )
    ).toMatchObject({ exists: true, unsupportedOptions: true });
  });

  it('recognizes a missing registration and defaults its future scope to local', () => {
    expect(parseClaudeMcpGet('No MCP server named "agent-rack". Configured servers:')).toEqual({
      exists: false,
      scope: 'local',
    });
  });
});

function fakeRunner(
  responses: Array<{ stdout?: string; stderr?: string; exitCode?: number } | Error>
): ClaudeCommandRunner & ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { stdout: '', stderr: '', exitCode: 0, ...response };
  });
}

describe('ensureClaudeDashboardRegistration', () => {
  it('does nothing when the same SSE URL is already registered', async () => {
    const run = fakeRunner([{ stdout: localSse }]);
    const confirm = vi.fn();
    expect(await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', { run, confirm })).toEqual({});
    expect(run).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('migrates a mismatched stdio registration to SSE after explicit confirmation', async () => {
    const stdio = `agent-rack:\n  Scope: Local config (private to you in this project)\n  Type: stdio\n  Command: npx\n  Args: -y agent-rack start\n`;
    const run = fakeRunner([{ stdout: stdio }, {}, {}]);

    const result = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run,
      confirm: async () => true,
    });

    expect(result.notice).toContain('now points to this shared dashboard server');
    expect(run).toHaveBeenNthCalledWith(2, 'claude', [
      'mcp', 'remove', 'agent-rack', '--scope', 'local',
    ]);
    expect(run).toHaveBeenNthCalledWith(3, 'claude', [
      'mcp', 'add', '--transport', 'sse', '--scope', 'local', 'agent-rack', 'http://127.0.0.1:8987/sse',
    ]);
  });

  it('restores a mismatched stdio registration if its SSE migration add fails', async () => {
    const stdio = `agent-rack:\n  Scope: Project config (shared with your team)\n  Type: stdio\n  Command: npx\n  Args: -y agent-rack start\n`;
    const run = fakeRunner([{ stdout: stdio }, {}, { exitCode: 1, stderr: 'add failed' }, {}]);

    const result = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run,
      confirm: async () => true,
    });

    expect(result.warning).toContain('could not add the shared registration');
    expect(result.warning).toContain('restored');
    expect(run).toHaveBeenNthCalledWith(4, 'claude', [
      'mcp', 'add', '--transport', 'stdio', '--scope', 'project', 'agent-rack', 'npx', '-y', 'agent-rack', 'start',
    ]);
  });

  it('restores stdio environment from a restorable JSON registration', async () => {
    const registration = JSON.stringify({
      name: 'agent-rack',
      scope: 'project',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'agent-rack', 'start'],
      environment: { API_KEY: 'secret-value' },
    });
    const run = fakeRunner([{ stdout: registration }, {}, { exitCode: 1, stderr: 'add failed' }, {}]);

    await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run,
      confirm: async () => true,
    });

    expect(run).toHaveBeenNthCalledWith(4, 'claude', [
      'mcp', 'add', '--transport', 'stdio', '--scope', 'project',
      '-e', 'API_KEY=secret-value',
      'agent-rack', 'npx', '-y', 'agent-rack', 'start',
    ]);
  });

  it('reports when rollback throws instead of claiming restoration succeeded', async () => {
    const run = fakeRunner([
      { stdout: `agent-rack:\n  Scope: Local config\n  Type: stdio\n  Command: npx\n` },
      {},
      new Error('add failed'),
      new Error('restore failed'),
    ]);

    const result = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run,
      confirm: async () => true,
    });

    expect(result.warning).toContain('could not be restored');
    expect(result.warning).not.toContain('restore failed');
  });

  it('restores HTTP environment and headers from a restorable JSON registration', async () => {
    const registration = JSON.stringify({
      name: 'agent-rack',
      scope: 'user',
      type: 'http',
      url: 'https://example.test/mcp',
      env: { API_KEY: 'secret-value' },
      headers: { Authorization: 'Bearer token-value' },
    });
    const run = fakeRunner([{ stdout: registration }, {}, { exitCode: 1, stderr: 'add failed' }, {}]);

    const result = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run,
      confirm: async () => true,
    });

    expect(result.warning).toContain('previous registration was restored');
    expect(run).toHaveBeenNthCalledWith(4, 'claude', [
      'mcp', 'add', '--transport', 'http', '--scope', 'user',
      '-e', 'API_KEY=secret-value', '-H', 'Authorization: Bearer token-value',
      'agent-rack', 'https://example.test/mcp',
    ]);
  });

  it('refuses to replace registrations with unsupported settings without exposing them', async () => {
    const run = fakeRunner([{ stdout: JSON.stringify({
      name: 'agent-rack', scope: 'user', type: 'sse', url: 'https://example.test/sse', clientId: 'secret-client-id',
    }) }]);
    const confirm = vi.fn();

    const result = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', { run, confirm });

    expect(result.warning).toContain('left unchanged');
    expect(result.warning).not.toContain('secret-client-id');
    expect(confirm).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it('opens with a warning when adding a missing registration is declined', async () => {
    const run = fakeRunner([
      { stderr: 'No MCP server named "agent-rack".', exitCode: 1 },
    ]);
    const result = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run,
      confirm: async () => false,
    });
    expect(result.warning).toContain('not changed');
    expect(run).toHaveBeenCalledOnce();
  });

  it('warns about external authority before offering to register --connect', async () => {
    const run = fakeRunner([
      { stderr: 'No MCP server named "agent-rack".', exitCode: 1 },
    ]);
    const confirm = vi.fn(async () => false);

    await ensureClaudeDashboardRegistration('http://127.0.0.1:9999/sse', {
      run,
      confirm,
      externalConnection: true,
    });

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/external and authoritative/i));
  });

  it('adds a missing registration at local scope', async () => {
    const run = fakeRunner([
      { stderr: 'No MCP server named "agent-rack".', exitCode: 1 },
      {},
    ]);
    await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run,
      confirm: async () => true,
    });
    expect(run).toHaveBeenLastCalledWith('claude', [
      'mcp', 'add', '--transport', 'sse', '--scope', 'local', 'agent-rack', 'http://127.0.0.1:8987/sse',
    ]);
  });

  it('does not expose command output when setup fails', async () => {
    const run = fakeRunner([
      { stderr: 'No MCP server named "agent-rack".', exitCode: 1 },
      { exitCode: 1, stderr: 'API_KEY=secret-value' },
    ]);

    const result = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run,
      confirm: async () => true,
    });

    expect(result.warning).toContain('could not add the shared registration');
    expect(result.warning).not.toContain('secret-value');
  });

  it('returns warnings for a missing Claude binary and command failures', async () => {
    const missing = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run: fakeRunner([Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })]),
      confirm: async () => true,
    });
    expect(missing.warning).toContain('Claude Code CLI was not found');

    const failure = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run: fakeRunner([
        { stderr: 'No MCP server named "agent-rack".', exitCode: 1 },
        { exitCode: 1, stderr: 'add failed' },
      ]),
      confirm: async () => true,
    });
    expect(failure.warning).toContain('could not add the shared registration');
  });
});
