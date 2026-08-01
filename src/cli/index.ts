import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execa } from 'execa';
import { startAgentMCPServer } from '../server.js';
import { loadConfig, getDefaultConfig, saveConfig } from '../config/loader.js';

export function runCLI() {
  const program = new Command();

  program
    .name('agent-mcp')
    .description('Model Context Protocol (MCP) Server driving agy, claude, opencode, and CLI agents as MCP tools')
    .version('1.0.0');

  program
    .command('start')
    .description('Start the Agent-MCP Server over stdio or HTTP-SSE transport')
    .option('-c, --config <path>', 'Path to custom agent-mcp.config.json')
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
        console.error('Failed to start Agent-MCP Server:', err);
        process.exit(1);
      }
    });

  program
    .command('install')
    .description('Automatically install and register agent-mcp into Claude Code CLI or Claude Desktop')
    .option('--target <target>', 'Target: claude (Claude Code CLI) or desktop (Claude Desktop App)', 'claude')
    .action(async (options) => {
      const binPath = path.resolve(process.cwd(), 'bin/agent-mcp.js');

      if (options.target === 'claude') {
        try {
          console.log('Registering agent-mcp with Claude Code CLI...');
          await execa('claude', ['mcp', 'add', 'agent-mcp', '--', 'node', binPath, 'start'], { stdio: 'inherit' });
          console.log('\n✓ Successfully added agent-mcp to Claude Code CLI!');
        } catch (err) {
          console.error('✗ Failed to register with Claude Code CLI:', err instanceof Error ? err.message : String(err));
        }
      } else if (options.target === 'desktop') {
        const configPath = path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json');
        let desktopConfig: any = { mcpServers: {} };

        try {
          if (fs.existsSync(configPath)) {
            desktopConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          }
          desktopConfig.mcpServers = desktopConfig.mcpServers || {};
          desktopConfig.mcpServers['agent-mcp'] = {
            command: 'node',
            args: [binPath, 'start'],
          };

          const dir = path.dirname(configPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(desktopConfig, null, 2), 'utf-8');
          console.log(`\n✓ Successfully added agent-mcp to Claude Desktop config at:\n  ${configPath}`);
        } catch (err) {
          console.error('✗ Failed to update Claude Desktop config:', err instanceof Error ? err.message : String(err));
        }
      }
    });

  program
    .command('config')
    .description('Manage agent-mcp configuration')
    .command('init')
    .description('Initialize a new starter agent-mcp.config.json file')
    .option('-p, --path <path>', 'Output file path', './agent-mcp.config.json')
    .action((options) => {
      const config = getDefaultConfig(process.cwd());
      saveConfig(config, options.path);
      console.log(`Created starter configuration file at: ${path.resolve(options.path)}`);
    });

  program
    .command('config-check')
    .description('Validate existing agent-mcp configuration')
    .option('-c, --config <path>', 'Path to agent-mcp.config.json')
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
    .option('-c, --config <path>', 'Path to agent-mcp.config.json')
    .action(async (options) => {
      const { config } = loadConfig(options.config);
      console.log('\nRegistered Agents Status:\n');

      for (const [agentId, agentConfig] of Object.entries(config.agents)) {
        let isAvailable = false;
        try {
          await execa('which', [agentConfig.command]);
          isAvailable = true;
        } catch {
          isAvailable = false;
        }

        const icon = isAvailable ? '✓' : '✗';
        const statusText = isAvailable ? 'AVAILABLE' : 'MISSING BINARY';
        console.log(` ${icon} [${agentId}] ${agentConfig.name} (${agentConfig.command}) -> ${statusText}`);
        console.log(`   Transport: ${agentConfig.transport}`);
        console.log(`   Args: ${agentConfig.args.join(' ')}`);
        console.log('');
      }
    });

  program
    .command('snippet')
    .description('Generate MCP client configuration JSON snippet')
    .argument('<client>', 'Target client: claude-desktop, antigravity, cursor')
    .action((client) => {
      const binPath = path.resolve(process.cwd(), 'bin/agent-mcp.js');
      const snippet = {
        mcpServers: {
          'agent-mcp': {
            command: 'node',
            args: [binPath, 'start'],
          },
        },
      };

      console.log(`\nSample snippet for '${client}':\n`);
      console.log(JSON.stringify(snippet, null, 2));
      console.log('');
    });

  // Default subcommand: if no subcommand provided, launch server
  if (process.argv.length === 2) {
    startAgentMCPServer();
  } else {
    program.parse(process.argv);
  }
}
