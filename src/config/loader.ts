import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentMCPConfig, AgentMCPConfigSchema, DEFAULT_SSE_PORT } from './schema.js';

export function getDefaultConfig(workspacePath?: string): AgentMCPConfig {
  const currentWorkspace = path.resolve(workspacePath || process.cwd());

  return AgentMCPConfigSchema.parse({
    transport: 'stdio',
    port: DEFAULT_SSE_PORT,
    allowedWorkspaces: [currentWorkspace],
    agents: {
      agy: {
        name: 'Antigravity CLI',
        command: 'agy',
        args: ['--print'],
        transport: 'agy_stream',
        description: 'Antigravity CLI autonomous coding agent',
        env: {
          PAGER: 'cat',
        },
      },
      claude: {
        name: 'Claude Code CLI',
        command: 'claude',
        // No --dangerously-skip-permissions. Authority comes from security.executionPolicy,
        // which is translated into --permission-mode per run; baking the escape hatch into the
        // default args made every sub-agent unsandboxed before anyone chose that.
        args: ['--output-format', 'json'],
        transport: 'claude_stream_json',
        description: 'Claude Code CLI streaming JSON agent',
        env: {},
      },
      opencode: {
        name: 'OpenCode Interpreter',
        command: 'opencode',
        args: ['run'],
        transport: 'pty_interactive',
        description: 'OpenCode interactive terminal CLI agent',
        env: {},
      },
      codex: {
        name: 'Codex CLI',
        command: 'codex',
        // No --dangerously-bypass-approvals-and-sandbox: executionPolicy supplies
        // --sandbox <policy> instead, which is a real OS-level sandbox.
        args: ['exec', '--json', '--skip-git-repo-check'],
        transport: 'codex_exec_json',
        description: 'OpenAI Codex CLI non-interactive JSON streaming agent',
        env: {},
      },
    },
    security: {
      sanitizeEnv: true,
      maxConcurrentSessions: 5,
      defaultTimeoutSeconds: 600,
      executionPolicy: 'workspace-write',
      sessionRetentionMinutes: 60,
      maxRetainedSessions: 200,
      maxSessionOutputBytes: 5_000_000,
      requireSseAuth: true,
    },
  });
}

export function findConfigFile(): string | null {
  if (process.env.AGENT_RACK_CONFIG && fs.existsSync(process.env.AGENT_RACK_CONFIG)) {
    return path.resolve(process.env.AGENT_RACK_CONFIG);
  }

  const localConfig = path.resolve(process.cwd(), 'agent-rack.config.json');
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }

  const userConfig = path.resolve(os.homedir(), '.config', 'agent-rack', 'config.json');
  if (fs.existsSync(userConfig)) {
    return userConfig;
  }

  return null;
}

export function loadConfig(configPath?: string): { config: AgentMCPConfig; filePath: string | null } {
  const targetPath = configPath ? path.resolve(configPath) : findConfigFile();

  if (!targetPath) {
    return { config: getDefaultConfig(), filePath: null };
  }

  try {
    const fileContent = fs.readFileSync(targetPath, 'utf-8');
    const jsonContent = JSON.parse(fileContent);
    const parsedConfig = AgentMCPConfigSchema.parse(jsonContent);

    // Normalize all allowedWorkspaces paths to absolute
    parsedConfig.allowedWorkspaces = parsedConfig.allowedWorkspaces.map((w) => path.resolve(w));

    return { config: parsedConfig, filePath: targetPath };
  } catch (error) {
    throw new Error(
      `Failed to load config file from ${targetPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Writes JSON to `targetPath` atomically: serialize to a sibling temp file, fsync it, then
 * rename over the destination. A rename within the same directory is atomic, so a crash or a
 * full disk mid-write leaves the original file intact rather than truncated — which matters
 * because the files this touches are the ones a client needs in order to start at all.
 *
 * An existing file's mode is preserved, and a `.bak` copy is kept when one is being replaced.
 */
export function writeJsonFileAtomic(targetPath: string, value: unknown): void {
  const resolvedPath = path.resolve(targetPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let mode: number | undefined;
  if (fs.existsSync(resolvedPath)) {
    try {
      mode = fs.statSync(resolvedPath).mode & 0o777;
      fs.copyFileSync(resolvedPath, `${resolvedPath}.bak`);
    } catch {
      // A missing backup is not worth failing the write over.
    }
  }

  const tempPath = `${resolvedPath}.${process.pid}.tmp`;
  const handle = fs.openSync(tempPath, 'w', mode ?? 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  try {
    fs.renameSync(tempPath, resolvedPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }

  if (mode !== undefined) {
    try {
      fs.chmodSync(resolvedPath, mode);
    } catch {
      // Best effort: the content is already committed.
    }
  }
}

export function saveConfig(config: AgentMCPConfig, targetPath: string): void {
  writeJsonFileAtomic(targetPath, config);
}
