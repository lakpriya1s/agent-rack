import http from 'http';
import type { Socket } from 'net';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config/loader.js';
import { DEFAULT_SSE_PORT, type AgentMCPConfig } from './config/schema.js';
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

export interface AgentMCPHTTPServer {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

/** Builds the shared context from a config that has already been loaded and validated. */
export function createServerContextFromConfig(
  config: AgentMCPConfig,
  filePath: string | null = null
): AgentMCPServerContext {
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

/**
 * Builds the shared, transport-independent state once: config, the one SessionManager, and the
 * tool registry. Every connected client (stdio, or one-per-SSE-connection) gets its own `Server`
 * from `buildServer()` below, but all of them share this same context — that's what makes
 * sessions visible across every simultaneously connected client.
 */
export async function createServerContext(configPath?: string): Promise<AgentMCPServerContext> {
  const { config, filePath } = loadConfig(configPath);
  return createServerContextFromConfig(config, filePath);
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

/** Starts a closeable loopback SSE server using an already-created shared context. */
export async function startSSEServer(
  ctx: AgentMCPServerContext,
  port: number
): Promise<AgentMCPHTTPServer> {
  const app = express();
  app.use(express.json());

  const transports = new Map<string, SSEServerTransport>();
  const mcpServers = new Map<string, Server>();

  app.get('/sse', async (_req, res) => {
    const transport = new SSEServerTransport('/message', res);
    const server = buildServer(ctx);
    transports.set(transport.sessionId, transport);
    mcpServers.set(transport.sessionId, server);

    res.on('close', () => {
      transports.delete(transport.sessionId);
      mcpServers.delete(transport.sessionId);
    });

    try {
      await server.connect(transport);
    } catch (error) {
      transports.delete(transport.sessionId);
      mcpServers.delete(transport.sessionId);
      if (!res.headersSent) res.status(500).send('Failed to open SSE connection');
      else res.end();
    }
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

  const server = http.createServer(app);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  const boundPort = (server.address() as { port: number }).port;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      await Promise.allSettled([...mcpServers.values()].map((mcpServer) => mcpServer.close()));
      transports.clear();
      mcpServers.clear();

      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await closed;
    })();
    return closePromise;
  };

  return { server, url: `http://127.0.0.1:${boundPort}/sse`, close };
}

export async function startAgentMCPServer(
  options: { configPath?: string; transport?: 'stdio' | 'sse'; port?: number } = {}
): Promise<http.Server | undefined> {
  const ctx = await createServerContext(options.configPath);
  const targetTransport = options.transport || ctx.config.transport || 'stdio';
  const targetPort = options.port ?? ctx.config.port ?? DEFAULT_SSE_PORT;

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
    const handle = await startSSEServer(ctx, targetPort);
    console.error(`Agent-MCP Server running on HTTP-SSE: ${handle.url}`);
    return handle.server;
  } else {
    const server = buildServer(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Agent-MCP Server running on stdio');
    return undefined;
  }
}
