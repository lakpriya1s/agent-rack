import { execa } from 'execa';
import { createInterface } from 'readline/promises';

export type ClaudeScope = 'local' | 'project' | 'user';

export interface ClaudeRegistration {
  exists: boolean;
  scope: ClaudeScope;
  type?: string;
  url?: string;
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
}

export interface ClaudeSetupResult {
  warning?: string;
  notice?: string;
}

export function parseClaudeMcpGet(stdout: string, stderr = ''): ClaudeRegistration {
  const output = `${stdout}\n${stderr}`;
  if (/No MCP server named\s+["']?agent-rack/i.test(output)) {
    return { exists: false, scope: 'local' };
  }

  const scopeLabel = output.match(/^\s*Scope:\s*(Local|Project|User)\s+config/im)?.[1]?.toLowerCase();
  const scope: ClaudeScope =
    scopeLabel === 'project' || scopeLabel === 'user' ? scopeLabel : 'local';
  const type = output.match(/^\s*Type:\s*(\S+)/im)?.[1]?.toLowerCase();
  const url = output.match(/^\s*(?:URL|Url):\s*(\S+)/im)?.[1];
  const exists = /^\s*agent-rack:\s*$/im.test(output) || Boolean(scopeLabel || type || url);

  return {
    exists,
    scope,
    ...(type ? { type } : {}),
    ...(url ? { url } : {}),
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
  if (inspected.exitCode !== 0 && registration.exists) {
    return commandFailure('inspect agent-rack', inspected);
  }
  if (inspected.exitCode !== 0 && !registration.exists && !/No MCP server named/i.test(inspected.stdout)) {
    return commandFailure('inspect agent-rack', inspected);
  }

  if (registration.exists && registration.type === 'sse' && sameUrl(registration.url, url)) {
    return {};
  }

  const approved = await deps.confirm(
    `Connect Claude Code's agent-rack MCP registration to the shared dashboard at ${url}?`
  );
  if (!approved) {
    return {
      warning: 'Claude Code MCP setup was not changed. The dashboard will open, but Claude sessions may not appear here.',
    };
  }

  if (registration.exists) {
    let removed: ClaudeCommandResult;
    try {
      removed = await deps.run('claude', [
        'mcp',
        'remove',
        'agent-rack',
        '--scope',
        registration.scope,
      ]);
    } catch (error) {
      return {
        warning: `Claude Code MCP setup could not remove the old registration: ${error instanceof Error ? error.message : String(error)}. The dashboard will still open.`,
      };
    }
    if (removed.exitCode !== 0) return commandFailure('remove the old registration', removed);
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
    return {
      warning: `Claude Code MCP setup could not add the shared registration: ${error instanceof Error ? error.message : String(error)}. The dashboard will still open.`,
    };
  }
  if (added.exitCode !== 0) return commandFailure('add the shared registration', added);

  return {
    notice: 'Claude Code now points to this shared dashboard server. Restart or reconnect Claude Code once to apply it.',
  };
}
