import { execa } from 'execa';
import { createInterface } from 'readline/promises';

export type ClaudeScope = 'local' | 'project' | 'user';

export interface ClaudeRegistration {
  exists: boolean;
  scope: ClaudeScope;
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
}

export interface ClaudeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ClaudeCommandRunner = (
  command: string,
  args: string[]
) => Promise<ClaudeCommandResult>;

export interface ClaudeSetupDependencies {
  run: ClaudeCommandRunner;
  confirm(message: string): Promise<boolean>;
  externalConnection?: boolean;
}

export interface ClaudeSetupResult {
  warning?: string;
  notice?: string;
}

export function parseClaudeMcpGet(stdout: string, stderr = ''): ClaudeRegistration {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const scopeValue = typeof parsed.scope === 'string' ? parsed.scope.toLowerCase() : 'local';
    const scope: ClaudeScope =
      scopeValue === 'project' || scopeValue === 'user' ? scopeValue : 'local';
    const type = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : undefined;
    const url = typeof parsed.url === 'string' ? parsed.url : undefined;
    const command = typeof parsed.command === 'string' ? parsed.command : undefined;
    const args = Array.isArray(parsed.args) && parsed.args.every((arg) => typeof arg === 'string')
      ? parsed.args
      : undefined;
    const identifiesAgentRack =
      parsed.name === 'agent-rack' || 'scope' in parsed || 'type' in parsed || 'url' in parsed;
    if (identifiesAgentRack) {
      return {
        exists: parsed.exists !== false,
        scope,
        ...(type ? { type } : {}),
        ...(url ? { url } : {}),
        ...(command ? { command } : {}),
        ...(args ? { args } : {}),
      };
    }
  } catch {
    // Current Claude Code emits labeled text; JSON support keeps this parser future-compatible.
  }

  const output = `${stdout}\n${stderr}`;
  if (/No MCP server named\s+["']?agent-rack/i.test(output)) {
    return { exists: false, scope: 'local' };
  }

  const scopeLabel = output.match(/^\s*Scope:\s*(Local|Project|User)\s+config/im)?.[1]?.toLowerCase();
  const scope: ClaudeScope =
    scopeLabel === 'project' || scopeLabel === 'user' ? scopeLabel : 'local';
  const type = output.match(/^\s*Type:\s*(\S+)/im)?.[1]?.toLowerCase();
  const url = output.match(/^\s*(?:URL|Url):\s*(\S+)/im)?.[1];
  const command = output.match(/^\s*Command:\s*(\S+)/im)?.[1];
  const argsText = output.match(/^\s*Args:\s*(.*)$/im)?.[1];
  const args = argsText
    ? Array.from(argsText.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)).map((match) => {
        const token = match[0];
        return /^['"].*['"]$/.test(token) ? token.slice(1, -1) : token;
      })
    : undefined;
  const exists = /^\s*agent-rack:\s*$/im.test(output) || Boolean(scopeLabel || type || url);

  return {
    exists,
    scope,
    ...(type ? { type } : {}),
    ...(url ? { url } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
  };
}

const defaultRun: ClaudeCommandRunner = async (command, args) => {
  const result = await execa(command, args, { reject: false });
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    exitCode: result.exitCode ?? 1,
  };
};

async function defaultConfirm(message: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${message} [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function commandFailure(action: string, result: ClaudeCommandResult): ClaudeSetupResult {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return { warning: `Claude Code MCP setup could not ${action}: ${detail}. The dashboard will still open.` };
}

function sameUrl(left: string | undefined, right: string): boolean {
  if (!left) return false;
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return left === right;
  }
}

function restoreRegistrationArgs(registration: ClaudeRegistration): string[] | undefined {
  const prefix = ['mcp', 'add', '--transport', registration.type ?? '', '--scope', registration.scope, 'agent-rack'];
  if (registration.type === 'sse' && registration.url) return [...prefix, registration.url];
  if (registration.type === 'stdio' && registration.command) {
    return [...prefix, registration.command, ...(registration.args ?? [])];
  }
  return undefined;
}

export async function ensureClaudeDashboardRegistration(
  url: string,
  dependencies: Partial<ClaudeSetupDependencies> = {}
): Promise<ClaudeSetupResult> {
  if (process.env.AGENT_RACK_TEST_SKIP_CLAUDE_SETUP === '1') {
    return { warning: 'Claude Code MCP setup skipped by the internal smoke-test flag.' };
  }

  const deps: ClaudeSetupDependencies = {
    run: dependencies.run ?? defaultRun,
    confirm: dependencies.confirm ?? defaultConfirm,
    externalConnection: dependencies.externalConnection,
  };

  let inspected: ClaudeCommandResult;
  try {
    inspected = await deps.run('claude', ['mcp', 'get', 'agent-rack']);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const detail = error instanceof Error ? error.message : String(error);
    return {
      warning:
        code === 'ENOENT' || /ENOENT|not found/i.test(detail)
          ? 'Claude Code CLI was not found. The dashboard will open without changing Claude MCP setup.'
          : `Claude Code MCP setup could not be inspected: ${detail}. The dashboard will still open.`,
    };
  }

  const registration = parseClaudeMcpGet(inspected.stdout, inspected.stderr);
  const missingRegistration = /No MCP server named/i.test(
    `${inspected.stdout}\n${inspected.stderr}`
  );
  if (inspected.exitCode !== 0 && registration.exists) {
    return commandFailure('inspect agent-rack', inspected);
  }
  if (inspected.exitCode !== 0 && !registration.exists && !missingRegistration) {
    return commandFailure('inspect agent-rack', inspected);
  }

  if (registration.exists && registration.type === 'sse' && sameUrl(registration.url, url)) {
    return {};
  }

  const restoreArgs = registration.exists ? restoreRegistrationArgs(registration) : undefined;
  if (registration.exists && !restoreArgs) {
    return {
      warning: `Claude Code's existing agent-rack registration was left unchanged because it cannot be restored safely. Remove it manually with "claude mcp remove agent-rack --scope ${registration.scope}" only when ready to replace it, then rerun the dashboard.`,
    };
  }

  const approved = await deps.confirm(
    deps.externalConnection
      ? `This --connect server's agents, workspaces, and security settings are external and authoritative. ${registration.exists ? 'Replace the existing registration' : 'Connect Claude Code'} to ${url}?`
      : `${registration.exists ? 'Replace Claude Code\'s existing agent-rack registration' : 'Connect Claude Code\'s agent-rack MCP registration'} to the shared dashboard at ${url}?`
  );
  if (!approved) {
    return {
      warning: 'Claude Code MCP setup was not changed. The dashboard will open, but Claude sessions may not appear here.',
    };
  }

  if (registration.exists) {
    let removed: ClaudeCommandResult;
    try {
      removed = await deps.run('claude', ['mcp', 'remove', 'agent-rack', '--scope', registration.scope]);
    } catch (error) {
      return {
        warning: `Claude Code MCP setup could not remove the previous registration: ${error instanceof Error ? error.message : String(error)}. The dashboard will still open.`,
      };
    }
    if (removed.exitCode !== 0) return commandFailure('remove the previous registration', removed);
  }

  let added: ClaudeCommandResult;
  try {
    added = await deps.run('claude', [
      'mcp',
      'add',
      '--transport',
      'sse',
      '--scope',
      registration.scope,
      'agent-rack',
      url,
    ]);
  } catch (error) {
    if (restoreArgs) await deps.run('claude', restoreArgs).catch(() => undefined);
    return {
      warning: `Claude Code MCP setup could not add the shared registration: ${error instanceof Error ? error.message : String(error)}. ${restoreArgs ? 'The previous registration was restored.' : ''} The dashboard will still open.`,
    };
  }
  if (added.exitCode !== 0) {
    if (restoreArgs) {
      const restored = await deps.run('claude', restoreArgs).catch(() => undefined);
      const detail = added.stderr.trim() || added.stdout.trim() || `exit code ${added.exitCode}`;
      if (restored?.exitCode === 0) {
        return { warning: `Claude Code MCP setup could not add the shared registration: ${detail}. The previous registration was restored. The dashboard will still open.` };
      }
      return { warning: `Claude Code MCP setup could not add the shared registration: ${detail}. The previous registration could not be restored. The dashboard will still open.` };
    }
    return commandFailure('add the shared registration', added);
  }

  return {
    notice: 'Claude Code now points to this shared dashboard server. Restart or reconnect Claude Code once to apply it.',
  };
}
