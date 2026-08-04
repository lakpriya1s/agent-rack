import { AgentMCPConfig } from '../config/schema.js';
import { SessionManager } from '../engine/session.js';
import { listAgentAvailability } from '../engine/availability.js';
import { fingerprintAgentMCPConfig } from '../config/fingerprint.js';
import { capabilitiesForAgent } from '../adapters/index.js';
import { describeUnenforcedPolicy } from '../security/policy.js';
import { resolveExecution, resolveTimeoutSeconds, resolveWorkspace } from './args.js';

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
      const availability = await listAgentAvailability(config);
      const policy = config.security.executionPolicy;

      // Capabilities ship with the listing so a client learns up front that (for example)
      // agent_session_send will not work for this agent, rather than after starting a session.
      const results = availability.map((entry) => {
        const agentConfig = config.agents[entry.agentId];
        return {
          ...entry,
          capabilities: capabilitiesForAgent(agentConfig),
          executionPolicy: policy,
          policyWarning: describeUnenforcedPolicy(agentConfig.transport, policy),
        };
      });

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
          description:
            'Execution mode forwarded to the agent CLI (e.g. plan, acceptEdits, auto for claude; ' +
            'read-only, workspace-write for codex). May only narrow authority: a mode granting ' +
            "more than the server's configured security.executionPolicy is rejected. Omit to use " +
            'the policy default.',
        },
        model: {
          type: 'string',
          description:
            "Model to run the agent with (e.g. 'gpt-5.5' for codex, 'opus' for claude). Overrides the agent's configured default model for this call only.",
        },
      },
      required: ['agent', 'prompt'],
    },
    handler: async (args) => {
      const agentId = String(args.agent);
      const prompt = String(args.prompt);
      const workspace = resolveWorkspace(args, config);
      const timeoutSeconds = resolveTimeoutSeconds(args, config);

      const { agentConfig, mode } = resolveExecution(config, agentId, args);

      const session = sessionManager.createSession(agentId, prompt, workspace, mode, {
        timeoutSeconds,
        agentConfigOverride: agentConfig,
      });
      const result = await sessionManager.waitForSession(session.id);

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
        timeoutSeconds: {
          type: 'number',
          description: 'Maximum execution time in seconds (default: 600)',
        },
        model: {
          type: 'string',
          description:
            "Model to run the agent with (e.g. 'gpt-5.5' for codex, 'opus' for claude). Overrides the agent's configured default model for this session only.",
        },
      },
      required: ['agent', 'prompt'],
    },
    handler: async (args) => {
      const agentId = String(args.agent);
      const prompt = String(args.prompt);
      const workspace = args.workspace ? String(args.workspace) : undefined;
      const timeoutSeconds = resolveTimeoutSeconds(args, config);

      const { agentConfig, mode } = resolveExecution(config, agentId, args);

      // Deliberately no `kind` parameter: it used to accept 'review', which only relabelled
      // the session for the dashboard while skipping every protection a real review gets
      // (read-only mode, stripped escape hatches, the review prompt, the git precheck). A
      // free-form task could therefore be presented as a read-only review. Only agent_review
      // creates review sessions now.
      const session = sessionManager.createSession(agentId, prompt, workspace, mode, {
        kind: 'task',
        timeoutSeconds,
        agentConfigOverride: agentConfig,
      });

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

  // Tool: agent_session_list
  tools.push({
    name: 'agent_session_list',
    description: 'Lists every background sub-agent session tracked by this server (running, completed, failed, or cancelled), most recent first',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const sessions = sessionManager.listSessions().map((s) => s.getInfo());
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sessions, null, 2),
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
    description:
      'Sends a follow-up turn to a background sub-agent session, continuing the same ' +
      'conversation. How it is delivered depends on the agent, and so does *when* you may call ' +
      'it — see followUpMode on the session info: "live" (opencode) writes to the still-running ' +
      'process, so the session must be running; "resume" (claude, codex) restarts the agent with ' +
      'its own resume flag, so the current turn must have FINISHED first — poll ' +
      'agent_session_status until it is no longer running, then send. A resumed session goes ' +
      'back to status "running" and its turnCount increases. Agents with followUpMode "none" ' +
      '(agy) cannot continue a conversation at all; start a new session instead.',
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
    description:
      'Retrieves log events from a session. Pass the nextCursor from the previous call to get ' +
      'only new events; the response reports droppedCount when the retained tail has scrolled ' +
      'past events you never saw.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'ID of the session',
        },
        cursor: {
          type: 'number',
          description:
            'Return events at or after this cursor (default 0 = from the oldest retained event). ' +
            'Use nextCursor from a previous response to poll incrementally.',
        },
        tail: {
          type: 'number',
          description: 'Instead of a cursor, return only the most recent N events.',
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
      const limit = typeof args.limit === 'number' ? args.limit : undefined;

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(`Session '${sessionId}' not found.`);
      }

      const buffer = session.controller.getBuffer();
      const page =
        typeof args.tail === 'number'
          ? buffer.getTail(args.tail)
          : buffer.getSince(typeof args.cursor === 'number' ? args.cursor : 0, limit);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    },
  });

  tools.push({
    name: 'agent_session_delete',
    description:
      'Forgets a finished session and frees its retained event log. Sessions are also pruned ' +
      'automatically per security.sessionRetentionMinutes and maxRetainedSessions.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'ID of the finished session to delete',
        },
      },
      required: ['sessionId'],
    },
    handler: async (args) => {
      const sessionId = String(args.sessionId);
      sessionManager.deleteSession(sessionId);

      return {
        content: [
          {
            type: 'text',
            text: `Session '${sessionId}' has been deleted.`,
          },
        ],
      };
    },
  });

  tools.push({
    name: 'agent_server_identity',
    description: 'Returns agent-rack server identity and a deterministic effective-configuration fingerprint',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            server: 'agent-rack',
            identityVersion: 1,
            configFingerprint: fingerprintAgentMCPConfig(config),
            // Deliberately exclude command args and env: a remote dashboard needs only the
            // choices the server will accept, never local execution details or secrets.
            launchMetadata: {
              agents: Object.keys(config.agents),
              allowedWorkspaces: config.allowedWorkspaces,
            },
          }),
        },
      ],
    }),
  });

  return tools;
}
