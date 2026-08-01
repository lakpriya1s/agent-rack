import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentMCPConfig, AgentMCPConfigSchema } from './schema.js';

export function getDefaultConfig(workspacePath?: string): AgentMCPConfig {
  const currentWorkspace = path.resolve(workspacePath || process.cwd());

  return AgentMCPConfigSchema.parse({
    transport: 'stdio',
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
        args: ['--dangerously-skip-permissions', '--output-format', 'json'],
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
        args: ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'],
        transport: 'codex_exec_json',
        description: 'OpenAI Codex CLI non-interactive JSON streaming agent',
        env: {},
      },
    },
    security: {
      sanitizeEnv: true,
      maxConcurrentSessions: 5,
      defaultTimeoutSeconds: 600,
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

export function saveConfig(config: AgentMCPConfig, targetPath: string): void {
  const resolvedPath = path.resolve(targetPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolvedPath, JSON.stringify(config, null, 2), 'utf-8');
}
