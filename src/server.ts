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
import { getPackageVersion } from './cli/version.js';

export interface AgentMCPServerContext {
  config: Awaited<ReturnType<typeof loadConfig>>['config'];
  filePath: string | null;
  sessionManager: SessionManager;
  toolMap: Map<string, MCPToolDefinition>;
  allTools: MCPToolDefinition[];
}

/**
 * Builds the shared, transport-independent state once: config, the one SessionManager, and the
 * tool registry. Every connected client (stdio, or one-per-SSE-connection) gets its own `Server`
 * from `buildServer()` below, but all of them share this same context — that's what makes
 * sessions visible across every simultaneously connected client.
 */
export async function createServerContext(configPath?: string): Promise<AgentMCPServerContext> {
  const { config, filePath } = loadConfig(configPath);
  const sessionManager = new SessionManager(config);

  const unifiedTools = registerUnifiedTools(config, sessionManager);
  const agentRunHandler = unifiedTools.find((t) => t.name === 'agent_run')!.handler;
  const shortcutTools = registerShortcutTools(config, agentRunHandler);
  const reviewTools = registerReviewTools(config, sessionManager);

  const allTools = [...unifiedTools, ...shortcutTools, ...reviewTools];
  const toolMap = new Map<string, MCPToolDefinition>();
  for (const tool of allTools) {
    toolMap.set(tool.name, tool);
  }

  return { config, filePath, sessionManager, toolMap, allTools };
}

/** Builds one fresh `Server` instance wired to the given (shared) context. Safe to call many times. */
export function buildServer(ctx: AgentMCPServerContext): Server {
  const server = new Server(
    {
      name: 'agent-rack',
      version: getPackageVersion(),
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ctx.allTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = ctx.toolMap.get(name);

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

  return server;
}

export async function createAgentMCPServer(configPath?: string) {
  const ctx = await createServerContext(configPath);
  const server = buildServer(ctx);
  return { server, config: ctx.config, filePath: ctx.filePath, sessionManager: ctx.sessionManager };
}

export async function startAgentMCPServer(
  options: { configPath?: string; transport?: 'stdio' | 'sse'; port?: number } = {}
): Promise<http.Server | undefined> {
  const ctx = await createServerContext(options.configPath);
  const targetTransport = options.transport || ctx.config.transport || 'stdio';
  const targetPort = options.port ?? ctx.config.port ?? 8765;

  // No config file anywhere on the search path means `allowedWorkspaces` silently defaults
  // to the current directory. That is the whole security boundary, so say so out loud.
  if (!ctx.filePath) {
    console.error(
      `Warning: no agent-rack config file found. Falling back to built-in defaults with ` +
        `allowedWorkspaces=[${ctx.config.allowedWorkspaces.join(', ')}]. ` +
        `Copy agent-rack.config.example.json to agent-rack.config.json to pin this explicitly.`
    );
  }

  if (targetTransport === 'sse') {
    const app = express();
    app.use(express.json());

    const transports = new Map<string, SSEServerTransport>();

    app.get('/sse', async (req, res) => {
      const transport = new SSEServerTransport('/message', res);
      transports.set(transport.sessionId, transport);
      res.on('close', () => {
        transports.delete(transport.sessionId);
      });

      const server = buildServer(ctx);
      await server.connect(transport);
    });

    app.post('/message', async (req, res) => {
      const sessionId = String(req.query.sessionId || '');
      const transport = transports.get(sessionId);
      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send('No active SSE connection for this sessionId');
      }
    });

    const httpServer = http.createServer(app);
    return new Promise((resolve) => {
      httpServer.listen(targetPort, () => {
        const boundPort = (httpServer.address() as { port: number }).port;
        console.error(`Agent-MCP Server running on HTTP-SSE: http://localhost:${boundPort}/sse`);
        resolve(httpServer);
      });
    });
  } else {
    const server = buildServer(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Agent-MCP Server running on stdio');
    return undefined;
  }
}
