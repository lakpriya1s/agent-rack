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

  it('refuses to destructively replace a mismatched existing registration', async () => {
    const run = fakeRunner([{ stdout: localSse.replace('8987', '9999') }]);
    const confirm = vi.fn();
    const result = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run,
      confirm,
    });
    expect(result.warning).toContain('left unchanged');
    expect(result.warning).toContain('claude mcp remove agent-rack --scope local');
    expect(run).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('preserves the detected scope in safe manual replacement guidance', async () => {
    const project = localSse
      .replace('Local config (private to you in this project)', 'Project config (shared with your team)')
      .replace('8987', '9999');
    const run = fakeRunner([{ stdout: project }]);
    const result = await ensureClaudeDashboardRegistration('http://127.0.0.1:8987/sse', {
      run,
      confirm: vi.fn(),
    });

    expect(run).toHaveBeenCalledOnce();
    expect(result.warning).toContain('claude mcp remove agent-rack --scope project');
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
    expect(failure.warning).toContain('add failed');
  });
});
