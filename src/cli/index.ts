import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { execa } from 'execa';
import { startAgentMCPServer } from '../server.js';
import { loadConfig, getDefaultConfig, saveConfig } from '../config/loader.js';
import { listAgentAvailability, isBinaryAvailable } from '../engine/availability.js';
import { handleCpCommand, copySkills } from './skills.js';
import { getPackageVersion } from './version.js';

/**
 * Path to the executable as MCP clients must spell it. Resolved from `process.argv[1]` — the
 * script Node actually ran — so it is correct whether invoked from the repo (`node
 * bin/agent-rack.js`), a global npm install, or via `npx`, regardless of cwd.
 */
function resolveBinPath(): string {
  return path.resolve(process.argv[1]);
}

/**
 * Root of the installed package (two levels up from this compiled file at `dist/cli/index.js`).
 * Used to locate the shipped plugin skill files at `plugins/agent-rack/skills/` regardless of
 * whether this is running from a local checkout, a global npm install, or via `npx`.
 */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

/** The `mcpServers` block every MCP client (Claude Desktop, Cursor, Antigravity) expects. */
function buildMcpServerSnippet() {
  return {
    mcpServers: {
      'agent-rack': {
        command: 'node',
        args: [resolveBinPath(), 'start'],
      },
    },
  };
}

function readJsonConfig(configPath: string): any {
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  return {};
}

function writeJsonConfig(configPath: string, config: any): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/** macOS's Claude Desktop config path — the only platform this target supports today. */
function desktopConfigPath(): string {
  return path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json');
}

/**
 * Cursor's MCP config — verified shape: `{ mcpServers: { name: { command, args } } }`.
 * Cursor reads both a global (`~/.cursor/mcp.json`) and a per-project
 * (`<project>/.cursor/mcp.json`) config, same shape either way.
 */
function cursorConfigPath(scope: 'user' | 'project' = 'user'): string {
  const base = scope === 'project' ? process.cwd() : os.homedir();
  return path.join(base, '.cursor', 'mcp.json');
}

function cursorSkillsDir(scope: 'user' | 'project' = 'user'): string {
  const base = scope === 'project' ? process.cwd() : os.homedir();
  return path.join(base, '.cursor', 'skills');
}

/** Directory names impeccable's own (real, shipping) harness detector uses to recognize each tool's project-local footprint — reused here for detection, not file writing. */
const PROJECT_DIR_HINTS: Record<string, string> = {
  'Claude Code CLI': '.claude',
  'Codex CLI': '.agents',
  Cursor: '.cursor',
  Antigravity: '.gemini',
  OpenCode: '.opencode',
};

function hasProjectDir(name: string): boolean {
  return fs.existsSync(path.join(process.cwd(), name));
}

/**
 * Antigravity shares Gemini's config namespace: `~/.gemini/config/mcp_config.json`, same
 * `mcpServers` shape as Cursor/Claude Desktop. Its own IDE data dir
 * (`~/Library/Application Support/Antigravity IDE`) has no MCP config of its own.
 */
function antigravityConfigPath(): string {
  return path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
}

function antigravitySkillsDir(): string {
  return path.join(os.homedir(), '.gemini', 'config', 'skills');
}

/** Same precedence opencode itself uses: $OPENCODE_CONFIG_DIR, then $XDG_CONFIG_HOME/opencode, then ~/.config/opencode. */
function opencodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

/** opencode's config — verified shape: `{ mcp: { name: { type: "local", command: [cmd, ...args] } } }` (combined argv array, different key name). */
function opencodeConfigPath(): string {
  return path.join(opencodeConfigDir(), 'opencode.json');
}

/**
 * `scope` maps directly to Claude Code's own `-s, --scope <local|user|project>` flag (verified
 * via `claude mcp add --help`). Omitted (undefined) preserves the CLI's own default ("local":
 * tied to this exact directory, stored in the user's private config, not shared) rather than us
 * silently picking a different default than before this option existed.
 */
async function registerClaude(binPath: string, scope?: string): Promise<void> {
  const scopeArgs = scope ? ['-s', scope] : [];
  try {
    console.log(`Registering agent-rack with Claude Code CLI${scope ? ` (scope: ${scope})` : ''}...`);
    await execa('claude', ['mcp', 'add', ...scopeArgs, 'agent-rack', '--', 'node', binPath, 'start'], {
      stdio: 'inherit',
    });
    console.log('\n✓ Successfully added agent-rack to Claude Code CLI!');
  } catch (err) {
    console.error('✗ Failed to register with Claude Code CLI:', err instanceof Error ? err.message : String(err));
  }
}

async function registerCodex(binPath: string): Promise<void> {
  try {
    console.log('Registering agent-rack with Codex CLI...');
    await execa('codex', ['mcp', 'add', 'agent-rack', '--', 'node', binPath, 'start'], { stdio: 'inherit' });
    console.log('\n✓ Successfully added agent-rack to Codex CLI!');
  } catch (err) {
    console.error('✗ Failed to register with Codex CLI:', err instanceof Error ? err.message : String(err));
  }
}

/** Shared by desktop/cursor/antigravity — all three use the identical `mcpServers` shape. */
function registerIntoMcpServersConfig(configPath: string, label: string): void {
  try {
    const config = readJsonConfig(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers['agent-rack'] = buildMcpServerSnippet().mcpServers['agent-rack'];
    writeJsonConfig(configPath, config);
    console.log(`\n✓ Successfully added agent-rack to ${label} config at:\n  ${configPath}`);
  } catch (err) {
    console.error(`✗ Failed to update ${label} config:`, err instanceof Error ? err.message : String(err));
  }
}

function registerDesktop(): void {
  registerIntoMcpServersConfig(desktopConfigPath(), 'Claude Desktop');
}

function registerCursor(scope: 'user' | 'project' = 'user'): void {
  const label = scope === 'project' ? 'Cursor (this project)' : 'Cursor';
  registerIntoMcpServersConfig(cursorConfigPath(scope), label);
  copySkillsTo(cursorSkillsDir(scope), label);
}

function registerAntigravity(): void {
  registerIntoMcpServersConfig(antigravityConfigPath(), 'Antigravity');
  copySkillsTo(antigravitySkillsDir(), 'Antigravity');
}

function registerOpenCode(binPath: string): void {
  const configPath = opencodeConfigPath();
  try {
    const config = readJsonConfig(configPath);
    if (!config.$schema) config.$schema = 'https://opencode.ai/config.json';
    config.mcp = config.mcp || {};
    config.mcp['agent-rack'] = { type: 'local', command: ['node', binPath, 'start'] };
    writeJsonConfig(configPath, config);
    console.log(`\n✓ Successfully added agent-rack to OpenCode config at:\n  ${configPath}`);
  } catch (err) {
    console.error('✗ Failed to update OpenCode config:', err instanceof Error ? err.message : String(err));
  }
}

/** Shared by cursor/antigravity uninstall — both use the identical `mcpServers` shape. */
function unregisterFromMcpServersConfig(configPath: string, label: string): void {
  try {
    if (!fs.existsSync(configPath)) {
      console.log(`Nothing to remove — no ${label} config found at:\n  ${configPath}`);
      return;
    }
    const config = readJsonConfig(configPath);
    if (!config.mcpServers?.['agent-rack']) {
      console.log(`Nothing to remove — agent-rack is not registered in ${label} config.`);
      return;
    }
    const backupPath = `${configPath}.bak`;
    fs.copyFileSync(configPath, backupPath);
    delete config.mcpServers['agent-rack'];
    writeJsonConfig(configPath, config);
    console.log(`\n✓ Successfully removed agent-rack from ${label} config at:\n  ${configPath}`);
    console.log(`  (backup saved to ${backupPath})`);
  } catch (err) {
    console.error(`✗ Failed to update ${label} config:`, err instanceof Error ? err.message : String(err));
  }
}

function unregisterOpenCode(): void {
  const configPath = opencodeConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      console.log(`Nothing to remove — no OpenCode config found at:\n  ${configPath}`);
      return;
    }
    const config = readJsonConfig(configPath);
    if (!config.mcp?.['agent-rack']) {
      console.log('Nothing to remove — agent-rack is not registered in OpenCode config.');
      return;
    }
    const backupPath = `${configPath}.bak`;
    fs.copyFileSync(configPath, backupPath);
    delete config.mcp['agent-rack'];
    writeJsonConfig(configPath, config);
    console.log(`\n✓ Successfully removed agent-rack from OpenCode config at:\n  ${configPath}`);
    console.log(`  (backup saved to ${backupPath})`);
  } catch (err) {
    console.error('✗ Failed to update OpenCode config:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Copies agent-rack's guidance skills (tool-selection, review-handling — the same ones shipped
 * in the Claude Code plugin) into another tool's global skills directory, prefixed with
 * `agent-rack-` to avoid colliding with any other package's same-named skill. Best-effort: a
 * missing source (e.g. running from a dev checkout without a full build) just skips silently
 * rather than failing the whole registration.
 */
function copySkillsTo(skillsDir: string, label: string): void {
  try {
    const copied = copySkills({
      destSkillsDir: skillsDir,
      packageRootPath: packageRoot(),
    });
    console.log(`✓ Copied ${copied.length} agent-rack skill(s) into ${label} at:\n  ${skillsDir}`);
  } catch (err) {
    console.error(`✗ Failed to copy skills into ${label}:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Sequential y/n prompt for the setup wizard — avoids pulling in an interactive-prompt
 * dependency. Takes a shared `readline.Interface` rather than creating one per call: creating a
 * fresh interface for every question loses sync with piped/buffered stdin (each question's
 * answer would never resolve past the first).
 */
function askYesNo(rl: readline.Interface, question: string, defaultYes: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    rl.question(`${question} ${suffix} `, (answer) => {
      const normalized = answer.trim().toLowerCase();
      if (!normalized) {
        resolve(defaultYes);
        return;
      }
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

const INSTALL_TARGETS_HELP =
  'claude (Claude Code CLI), codex (Codex CLI), desktop (Claude Desktop App), cursor (Cursor), ' +
  'antigravity or agy (Antigravity), opencode (OpenCode). Any other value falls back to printing ' +
  "a manual snippet via 'snippet <target>'.";

export function runCLI() {
  const program = new Command();

  program
    .name('agent-rack')
    .description('Model Context Protocol (MCP) Server driving agy, claude, opencode, and CLI agents as MCP tools')
    .version(getPackageVersion());

  program
    .command('start')
    .description('Start the Agent Rack Server over stdio or HTTP-SSE transport')
    .option('-c, --config <path>', 'Path to custom agent-rack.config.json')
    .option('-t, --transport <type>', 'Transport mode: stdio or sse')
    .option('-p, --port <number>', 'HTTP port when using SSE transport', (val) => parseInt(val, 10))
    .action(async (options) => {
      try {
        await startAgentMCPServer({
          configPath: options.config,
          transport: options.transport,
          port: options.port,
        });
      } catch (err) {
        console.error('Failed to start Agent Rack Server:', err);
        process.exit(1);
      }
    });

  program
    .command('install')
    .description('Automatically install and register agent-rack into a supported MCP client')
    .option('--target <target>', `Target: ${INSTALL_TARGETS_HELP}`, 'claude')
    .option(
      '--scope <scope>',
      "project or user (global). Only applies to --target claude|cursor. claude defaults to Claude Code's own default (local) when omitted; cursor defaults to user."
    )
    .action(async (options) => {
      const binPath = resolveBinPath();

      if (options.target === 'claude') {
        await registerClaude(binPath, options.scope);
      } else if (options.target === 'codex') {
        await registerCodex(binPath);
      } else if (options.target === 'desktop') {
        registerDesktop();
      } else if (options.target === 'cursor') {
        registerCursor(options.scope === 'project' ? 'project' : 'user');
      } else if (options.target === 'antigravity' || options.target === 'agy') {
        registerAntigravity();
      } else if (options.target === 'opencode') {
        registerOpenCode(binPath);
      } else {
        console.log(`No automatic registration is available for target '${options.target}' yet.`);
        console.log(`Run \`agent-rack snippet ${options.target}\` to print the mcpServers JSON, then add it to that client's config by hand.`);
      }
    });

  program
    .command('setup')
    .description('Interactive wizard: detect installed clients and register agent-rack with each')
    .action(async () => {
      if (!process.stdin.isTTY) {
        console.error(
          "'agent-rack setup' needs an interactive terminal to ask yes/no questions, but stdin " +
            "here isn't one (common over some SSH sessions, certain IDE-embedded terminals, or " +
            'when output is piped/redirected).'
        );
        console.error(
          '\nUse the explicit commands instead:\n' +
            '  agent-rack install --target claude\n' +
            '  agent-rack install --target codex\n' +
            '  agent-rack install --target desktop\n' +
            '  agent-rack install --target cursor\n' +
            '  agent-rack install --target antigravity\n' +
            '  agent-rack install --target opencode'
        );
        process.exitCode = 1;
        return;
      }

      const binPath = resolveBinPath();

      const projectHits = Object.entries(PROJECT_DIR_HINTS).filter(([, dir]) => hasProjectDir(dir));
      if (projectHits.length > 0) {
        console.log(`Detected in this project (${process.cwd()}):`);
        for (const [label, dir] of projectHits) {
          console.log(`  ${label.padEnd(16)} ${dir}`);
        }
        console.log('');
      }

      console.log("Let's set up agent-rack.\n");

      const [hasClaude, hasCodex, hasOpenCode] = await Promise.all([
        isBinaryAvailable('claude'),
        isBinaryAvailable('codex'),
        isBinaryAvailable('opencode'),
      ]);
      const hasDesktop = fs.existsSync(path.dirname(desktopConfigPath()));
      const hasCursor = fs.existsSync(path.dirname(cursorConfigPath()));
      const hasAntigravity = fs.existsSync(path.dirname(antigravityConfigPath()));
      const projectClaude = hasProjectDir(PROJECT_DIR_HINTS['Claude Code CLI']);
      const projectCursor = hasProjectDir(PROJECT_DIR_HINTS.Cursor);

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let registeredAny = false;

      /**
       * `scopePrompt` is only present for targets with a verified project-vs-user distinction
       * (claude, cursor). Its default answer follows whether a project-local dir was already
       * detected — if you're sitting in a project that already has a `.claude`/`.cursor` folder,
       * default to registering there; otherwise default to the global/user scope.
       */
      const steps: Array<{
        detected: boolean;
        label: string;
        skipLabel: string;
        scopePrompt?: { defaultProject: boolean };
        run: (scope: 'user' | 'project') => void | Promise<void>;
      }> = [
        {
          detected: hasClaude,
          label: 'Claude Code CLI',
          skipLabel: 'Claude Code CLI not found on $PATH',
          scopePrompt: { defaultProject: projectClaude },
          run: (scope) => registerClaude(binPath, scope === 'project' ? 'project' : undefined),
        },
        {
          detected: hasCodex,
          label: 'Codex CLI',
          skipLabel: 'Codex CLI not found on $PATH',
          run: () => registerCodex(binPath),
        },
        {
          detected: hasDesktop,
          label: 'Claude Desktop',
          skipLabel: 'Claude Desktop not found',
          run: () => registerDesktop(),
        },
        {
          detected: hasCursor,
          label: 'Cursor',
          skipLabel: 'Cursor not found',
          scopePrompt: { defaultProject: projectCursor },
          run: (scope) => registerCursor(scope),
        },
        {
          detected: hasAntigravity,
          label: 'Antigravity',
          skipLabel: 'Antigravity not found',
          run: () => registerAntigravity(),
        },
        {
          detected: hasOpenCode,
          label: 'OpenCode',
          skipLabel: 'OpenCode not found on $PATH',
          run: () => registerOpenCode(binPath),
        },
      ];

      for (const step of steps) {
        if (!step.detected) {
          console.log(`- ${step.skipLabel}, skipping.`);
          continue;
        }
        if (!(await askYesNo(rl, `Register with ${step.label}?`, true))) continue;

        let scope: 'user' | 'project' = 'user';
        if (step.scopePrompt) {
          scope = (await askYesNo(rl, '  Just for this project (not globally)?', step.scopePrompt.defaultProject))
            ? 'project'
            : 'user';
        }
        await step.run(scope);
        registeredAny = true;
      }

      rl.close();

      console.log(
        registeredAny
          ? '\nDone. Restart the client(s) above to pick up the new tools.'
          : '\nNothing was registered.'
      );
      console.log(
        "\nUsing a different MCP client (VS Code, GitHub Copilot, etc.)? Run " +
          "`agent-rack snippet <client>` to print a config snippet to paste in by hand."
      );
    });

  program
    .command('uninstall')
    .description('Remove agent-rack from a supported MCP client')
    .option('--target <target>', `Target: ${INSTALL_TARGETS_HELP}`, 'claude')
    .option('--scope <scope>', 'project or user (global). Only applies to --target claude|cursor, matching install.')
    .action(async (options) => {
      if (options.target === 'claude') {
        const scopeArgs = options.scope ? ['-s', options.scope] : [];
        try {
          console.log(`Removing agent-rack from Claude Code CLI${options.scope ? ` (scope: ${options.scope})` : ''}...`);
          await execa('claude', ['mcp', 'remove', ...scopeArgs, 'agent-rack'], { stdio: 'inherit' });
          console.log('\n✓ Successfully removed agent-rack from Claude Code CLI!');
        } catch (err) {
          console.error('✗ Failed to remove from Claude Code CLI:', err instanceof Error ? err.message : String(err));
        }
      } else if (options.target === 'codex') {
        try {
          console.log('Removing agent-rack from Codex CLI...');
          await execa('codex', ['mcp', 'remove', 'agent-rack'], { stdio: 'inherit' });
          console.log('\n✓ Successfully removed agent-rack from Codex CLI!');
        } catch (err) {
          console.error('✗ Failed to remove from Codex CLI:', err instanceof Error ? err.message : String(err));
        }
      } else if (options.target === 'desktop') {
        unregisterFromMcpServersConfig(desktopConfigPath(), 'Claude Desktop');
      } else if (options.target === 'cursor') {
        const scope = options.scope === 'project' ? 'project' : 'user';
        unregisterFromMcpServersConfig(cursorConfigPath(scope), scope === 'project' ? 'Cursor (this project)' : 'Cursor');
      } else if (options.target === 'antigravity' || options.target === 'agy') {
        unregisterFromMcpServersConfig(antigravityConfigPath(), 'Antigravity');
      } else if (options.target === 'opencode') {
        unregisterOpenCode();
      } else {
        console.log(`No automatic removal is available for target '${options.target}'.`);
        console.log(`If you registered it manually via a printed snippet, remove that entry from the client's config by hand.`);
      }
    });

  program
    .command('config')
    .description('Manage agent-rack configuration')
    .command('init')
    .description('Initialize a new starter agent-rack.config.json file')
    .option('-p, --path <path>', 'Output file path', './agent-rack.config.json')
    .action((options) => {
      const config = getDefaultConfig(process.cwd());
      saveConfig(config, options.path);
      console.log(`Created starter configuration file at: ${path.resolve(options.path)}`);
    });

  program
    .command('config-check')
    .description('Validate existing agent-rack configuration')
    .option('-c, --config <path>', 'Path to agent-rack.config.json')
    .action((options) => {
      try {
        const { config, filePath } = loadConfig(options.config);
        console.log(`✓ Configuration valid! Loaded from: ${filePath || 'default runtime'}`);
        console.log(JSON.stringify(config, null, 2));
      } catch (err) {
        console.error('✗ Configuration invalid:', err);
        process.exit(1);
      }
    });

  program
    .command('agents')
    .description('List configured agents and verify binary availability on $PATH')
    .option('-c, --config <path>', 'Path to agent-rack.config.json')
    .action(async (options) => {
      const { config } = loadConfig(options.config);
      console.log('\nRegistered Agents Status:\n');

      for (const agent of await listAgentAvailability(config)) {
        const isAvailable = agent.status === 'available';
        const icon = isAvailable ? '✓' : '✗';
        const statusText = isAvailable ? 'AVAILABLE' : 'MISSING BINARY';
        console.log(` ${icon} [${agent.agentId}] ${agent.name} (${agent.command}) -> ${statusText}`);
        console.log(`   Transport: ${agent.transport}`);
        console.log(`   Args: ${config.agents[agent.agentId].args.join(' ')}`);
        console.log('');
      }
    });

  program
    .command('snippet')
    .description('Generate MCP client configuration JSON snippet')
    .argument('<client>', 'Target client: claude-desktop, antigravity, cursor')
    .action((client) => {
      console.log(`\nSample snippet for '${client}':\n`);
      console.log(JSON.stringify(buildMcpServerSnippet(), null, 2));
      console.log('');
    });

  program
    .command('cp [dest]')
    .alias('copy-skills')
    .description('Copy agent-rack skill set to a project or agent skills directory')
    .option('--target <target>', `Target: ${INSTALL_TARGETS_HELP}`)
    .option('--scope <scope>', 'project (default) or user (global)')
    .option('--skill <name>', 'Specific skill name to copy (default: all skills)')
    .option('--prefix <prefix>', 'Prefix for skill directory names', 'agent-rack-')
    .action((dest, options) => {
      handleCpCommand(dest, options);
    });

  program
    .command('dashboard')
    .alias('ui')
    .description('Launch the interactive CLI dashboard (TUI) for agent-rack')
    .option('-c, --config <path>', 'Path to agent-rack.config.json')
    .option('--connect <url>', 'URL of a running agent-rack SSE server (default: derived from config)')
    .action(async (options) => {
      const { startDashboard } = await import('./dashboard/index.js');
      await startDashboard(options.config, options.connect);
    });

  // Default subcommand: if no subcommand provided, launch server
  if (process.argv.length === 2) {
    startAgentMCPServer();
  } else {
    program.parse(process.argv);
  }
}
