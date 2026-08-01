import { execa } from 'execa';
import { AgentMCPConfig } from '../config/schema.js';
import { SessionManager } from '../engine/session.js';
import { validateWorkspacePath } from '../security/workspace.js';
import { createAdapter } from '../adapters/index.js';
import { AgentProcessController } from '../engine/process.js';

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export function registerUnifiedTools(
  config: AgentMCPConfig,
  sessionManager: SessionManager
): MCPToolDefinition[] {
  const tools: MCPToolDefinition[] = [];

  // Tool 1: agent_list_available
  tools.push({
    name: 'agent_list_available',
    description: 'Lists all configured local AI coding agent CLIs (agy, claude, opencode, codex) and their status',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const results = [];
      for (const [agentId, agentConfig] of Object.entries(config.agents)) {
        let isBinaryAvailable = false;
        try {
          await execa('which', [agentConfig.command]);
          isBinaryAvailable = true;
        } catch {
          isBinaryAvailable = false;
        }

        results.push({
          agentId,
          name: agentConfig.name,
          command: agentConfig.command,
          transport: agentConfig.transport,
          description: agentConfig.description || '',
          status: isBinaryAvailable ? 'available' : 'missing_binary',
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  });

  // Tool 2: agent_run (Synchronous Execution)
  tools.push({
    name: 'agent_run',
    description: 'Executes a sub-agent task synchronously within the specified workspace and returns the formatted response',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'ID of the target agent (e.g. agy, claude, opencode, codex)',
        },
        prompt: {
          type: 'string',
          description: 'Detailed prompt instruction for the sub-agent',
        },
        workspace: {
          type: 'string',
          description: 'Target workspace directory (must be within allowedWorkspaces)',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Maximum execution time in seconds (default: 600)',
        },
        mode: {
          type: 'string',
          description: 'Execution mode (e.g. auto, plan, accept_edits, manual)',
        },
      },
      required: ['agent', 'prompt'],
    },
    handler: async (args) => {
      const agentId = String(args.agent);
      const prompt = String(args.prompt);
      const workspace = args.workspace ? String(args.workspace) : config.allowedWorkspaces[0];
      const timeoutSeconds = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : config.security?.defaultTimeoutSeconds || 600;
      const mode = args.mode ? String(args.mode) : undefined;

      const agentConfig = config.agents[agentId];
      if (!agentConfig) {
        throw new Error(`Agent '${agentId}' is not configured in agent-mcp.`);
      }

      validateWorkspacePath(workspace, config.allowedWorkspaces);

      const adapter = createAdapter(agentConfig);
      const controller = new AgentProcessController(agentConfig, adapter);

      const result = await controller.runSync({
        prompt,
        workspace,
        mode,
        timeoutSeconds,
        sanitizeEnv: config.security?.sanitizeEnv !== false,
      });

      return {
        content: [
          {
            type: 'text',
            text: result.summary,
          },
        ],
      };
    },
  });

  // Tool 3: agent_session_create (Async background session)
  tools.push({
    name: 'agent_session_create',
    description: 'Spawns a background task session with a sub-agent and returns a sessionId for tracking',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'ID of the target agent (e.g. agy, claude, opencode, codex)',
        },
        prompt: {
          type: 'string',
          description: 'Initial task prompt for the sub-agent',
        },
        workspace: {
          type: 'string',
          description: 'Target workspace directory',
        },
        mode: {
          type: 'string',
          description: 'Execution mode',
        },
      },
      required: ['agent', 'prompt'],
    },
    handler: async (args) => {
      const agentId = String(args.agent);
      const prompt = String(args.prompt);
      const workspace = args.workspace ? String(args.workspace) : undefined;
      const mode = args.mode ? String(args.mode) : undefined;

      const session = sessionManager.createSession(agentId, prompt, workspace, mode);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(session.getInfo(), null, 2),
          },
        ],
      };
    },
  });

  // Tool 4: agent_session_status
  tools.push({
    name: 'agent_session_status',
    description: 'Retrieves current status and summary of a background sub-agent session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'ID of the session to query',
        },
      },
      required: ['sessionId'],
    },
    handler: async (args) => {
      const sessionId = String(args.sessionId);
      const session = sessionManager.getSession(sessionId);

      if (!session) {
        throw new Error(`Session '${sessionId}' not found.`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(session.getInfo(), null, 2),
          },
        ],
      };
    },
  });

  // Tool 5: agent_session_send
  tools.push({
    name: 'agent_session_send',
    description: 'Sends follow-up text or user response to a running background sub-agent session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'ID of the target session',
        },
        message: {
          type: 'string',
          description: 'Text message to send to the sub-agent stdin',
        },
      },
      required: ['sessionId', 'message'],
    },
    handler: async (args) => {
      const sessionId = String(args.sessionId);
      const message = String(args.message);

      sessionManager.sendToSession(sessionId, message);

      return {
        content: [
          {
            type: 'text',
            text: `Successfully sent message to session '${sessionId}'.`,
          },
        ],
      };
    },
  });

  // Tool 6: agent_session_cancel
  tools.push({
    name: 'agent_session_cancel',
    description: 'Terminates a running background sub-agent session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'ID of the session to cancel',
        },
      },
      required: ['sessionId'],
    },
    handler: async (args) => {
      const sessionId = String(args.sessionId);
      const session = sessionManager.cancelSession(sessionId);

      return {
        content: [
          {
            type: 'text',
            text: `Session '${sessionId}' has been cancelled. Status: ${session.status}`,
          },
        ],
      };
    },
  });

  // Tool 7: agent_session_logs
  tools.push({
    name: 'agent_session_logs',
    description: 'Retrieves stdout/stderr log events from a session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'ID of the session',
        },
        offset: {
          type: 'number',
          description: 'Event offset index (default: 0)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return',
        },
      },
      required: ['sessionId'],
    },
    handler: async (args) => {
      const sessionId = String(args.sessionId);
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(`Session '${sessionId}' not found.`);
      }

      const events = session.controller.getBuffer().getEvents(offset, limit);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(events, null, 2),
          },
        ],
      };
    },
  });

  return tools;
}
