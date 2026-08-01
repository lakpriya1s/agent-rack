import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import os from 'os';
import readline from 'readline';
import { execa } from 'execa';
import { startAgentMCPServer } from '../server.js';
import { loadConfig, getDefaultConfig, saveConfig } from '../config/loader.js';
import { listAgentAvailability, isBinaryAvailable } from '../engine/availability.js';

/**
 * Path to the executable as MCP clients must spell it. Resolved from `process.argv[1]` — the
 * script Node actually ran — so it is correct whether invoked from the repo (`node
 * bin/agent-rack.js`), a global npm install, or via `npx`, regardless of cwd.
 */
function resolveBinPath(): string {
  return path.resolve(process.argv[1]);
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

/** macOS's Claude Desktop config path — the only platform `registerDesktop` supports today. */
function desktopConfigPath(): string {
  return path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json');
}

async function registerClaude(binPath: string): Promise<void> {
  try {
    console.log('Registering agent-rack with Claude Code CLI...');
    await execa('claude', ['mcp', 'add', 'agent-rack', '--', 'node', binPath, 'start'], { stdio: 'inherit' });
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

function registerDesktop(): void {
  const configPath = desktopConfigPath();
  let desktopConfig: any = { mcpServers: {} };

  try {
    if (fs.existsSync(configPath)) {
      desktopConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    desktopConfig.mcpServers = desktopConfig.mcpServers || {};
    desktopConfig.mcpServers['agent-rack'] = buildMcpServerSnippet().mcpServers['agent-rack'];

    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(desktopConfig, null, 2), 'utf-8');
    console.log(`\n✓ Successfully added agent-rack to Claude Desktop config at:\n  ${configPath}`);
  } catch (err) {
    console.error('✗ Failed to update Claude Desktop config:', err instanceof Error ? err.message : String(err));
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

export function runCLI() {
  const program = new Command();

  program
    .name('agent-rack')
    .description('Model Context Protocol (MCP) Server driving agy, claude, opencode, and CLI agents as MCP tools')
    .version('0.1.4');

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
    .description('Automatically install and register agent-rack into Claude Code CLI, Codex CLI, or Claude Desktop')
    .option(
      '--target <target>',
      "Target: claude (Claude Code CLI), codex (Codex CLI), or desktop (Claude Desktop App). Any other value falls back to printing a manual snippet via 'snippet <target>'.",
      'claude'
    )
    .action(async (options) => {
      const binPath = resolveBinPath();

      if (options.target === 'claude') {
        await registerClaude(binPath);
      } else if (options.target === 'codex') {
        await registerCodex(binPath);
      } else if (options.target === 'desktop') {
        registerDesktop();
      } else {
        console.log(`No automatic registration is available for target '${options.target}' yet.`);
        console.log(`Run \`agent-rack snippet ${options.target}\` to print the mcpServers JSON, then add it to that client's config by hand.`);
      }
    });

  program
    .command('setup')
    .description('Interactive wizard: detect installed clients and register agent-rack with each')
    .action(async () => {
      const binPath = resolveBinPath();
      console.log("Let's set up agent-rack.\n");

      const [hasClaude, hasCodex] = await Promise.all([isBinaryAvailable('claude'), isBinaryAvailable('codex')]);
      const hasDesktop = fs.existsSync(path.dirname(desktopConfigPath()));

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let registeredAny = false;

      if (hasClaude) {
        if (await askYesNo(rl, 'Register with Claude Code CLI?', true)) {
          await registerClaude(binPath);
          registeredAny = true;
        }
      } else {
        console.log("- Claude Code CLI not found on $PATH, skipping.");
      }

      if (hasCodex) {
        if (await askYesNo(rl, 'Register with Codex CLI?', true)) {
          await registerCodex(binPath);
          registeredAny = true;
        }
      } else {
        console.log("- Codex CLI not found on $PATH, skipping.");
      }

      if (hasDesktop) {
        if (await askYesNo(rl, 'Register with Claude Desktop?', true)) {
          registerDesktop();
          registeredAny = true;
        }
      } else {
        console.log("- Claude Desktop not found, skipping.");
      }

      rl.close();

      console.log(
        registeredAny
          ? '\nDone. Restart the client(s) above to pick up the new tools.'
          : '\nNothing was registered.'
      );
      console.log(
        "\nUsing a different MCP client (Cursor, VS Code, Antigravity, etc.)? Run " +
          "`agent-rack snippet <client>` to print a config snippet to paste in by hand."
      );
    });

  program
    .command('uninstall')
    .description('Remove agent-rack from Claude Code CLI, Codex CLI, or Claude Desktop')
    .option(
      '--target <target>',
      'Target: claude (Claude Code CLI), codex (Codex CLI), or desktop (Claude Desktop App)',
      'claude'
    )
    .action(async (options) => {
      if (options.target === 'claude') {
        try {
          console.log('Removing agent-rack from Claude Code CLI...');
          await execa('claude', ['mcp', 'remove', 'agent-rack'], { stdio: 'inherit' });
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
        const configPath = path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json');

        try {
          if (!fs.existsSync(configPath)) {
            console.log(`Nothing to remove — no Claude Desktop config found at:\n  ${configPath}`);
            return;
          }

          const desktopConfig: any = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

          if (!desktopConfig.mcpServers?.['agent-rack']) {
            console.log('Nothing to remove — agent-rack is not registered in Claude Desktop config.');
            return;
          }

          const backupPath = `${configPath}.bak`;
          fs.copyFileSync(configPath, backupPath);

          delete desktopConfig.mcpServers['agent-rack'];
          fs.writeFileSync(configPath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

          console.log(`\n✓ Successfully removed agent-rack from Claude Desktop config at:\n  ${configPath}`);
          console.log(`  (backup saved to ${backupPath})`);
        } catch (err) {
          console.error('✗ Failed to update Claude Desktop config:', err instanceof Error ? err.message : String(err));
        }
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

  // Default subcommand: if no subcommand provided, launch server
  if (process.argv.length === 2) {
    startAgentMCPServer();
  } else {
    program.parse(process.argv);
  }
}
