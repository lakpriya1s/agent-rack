import http from 'http';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config/loader.js';
import { SessionManager } from './engine/session.js';
import { registerUnifiedTools, MCPToolDefinition } from './tools/unified.js';
import { registerShortcutTools } from './tools/shortcuts.js';
import { registerReviewTools } from './tools/review.js';

export async function createAgentMCPServer(configPath?: string) {
  const { config, filePath } = loadConfig(configPath);
  const sessionManager = new SessionManager(config);

  const server = new Server(
    {
      name: 'agent-rack',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const unifiedTools = registerUnifiedTools(config, sessionManager);
  const agentRunHandler = unifiedTools.find((t) => t.name === 'agent_run')!.handler;
  const shortcutTools = registerShortcutTools(config, agentRunHandler);
  const reviewTools = registerReviewTools(config, sessionManager);

  const allTools = [...unifiedTools, ...shortcutTools, ...reviewTools];
  const toolMap = new Map<string, MCPToolDefinition>();
  for (const tool of allTools) {
    toolMap.set(tool.name, tool);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: allTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);

    if (!tool) {
      throw new Error(`Tool '${name}' is not registered on agent-rack server.`);
    }

    try {
      const result = await tool.handler(args || {});
      return result as any;
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool '${name}': ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return { server, config, filePath, sessionManager };
}

export async function startAgentMCPServer(options: { configPath?: string; transport?: 'stdio' | 'sse'; port?: number } = {}) {
  const { server, config, filePath } = await createAgentMCPServer(options.configPath);
  const targetTransport = options.transport || config.transport || 'stdio';
  const targetPort = options.port || config.port || 8765;

  // No config file anywhere on the search path means `allowedWorkspaces` silently defaults
  // to the current directory. That is the whole security boundary, so say so out loud.
  if (!filePath) {
    console.error(
      `Warning: no agent-rack config file found. Falling back to built-in defaults with ` +
        `allowedWorkspaces=[${config.allowedWorkspaces.join(', ')}]. ` +
        `Copy agent-rack.config.example.json to agent-rack.config.json to pin this explicitly.`
    );
  }

  if (targetTransport === 'sse') {
    const app = express();
    app.use(express.json());

    let sseTransport: SSEServerTransport | null = null;

    app.get('/sse', async (req, res) => {
      sseTransport = new SSEServerTransport('/message', res);
      await server.connect(sseTransport);
    });

    app.post('/message', async (req, res) => {
      if (sseTransport) {
        await sseTransport.handlePostMessage(req, res);
      } else {
        res.status(400).send('SSE connection not initialized');
      }
    });

    const httpServer = http.createServer(app);
    httpServer.listen(targetPort, () => {
      console.error(`Agent-MCP Server running on HTTP-SSE: http://localhost:${targetPort}/sse`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Agent-MCP Server running on stdio');
  }
}
