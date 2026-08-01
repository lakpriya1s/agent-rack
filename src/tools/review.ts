import { AgentMCPConfig } from '../config/schema.js';
import { SessionManager } from '../engine/session.js';
import { validateWorkspacePath } from '../security/workspace.js';
import { createAdapter } from '../adapters/index.js';
import { AgentProcessController } from '../engine/process.js';
import { MCPToolDefinition } from './unified.js';
import {
  buildReviewPrompt,
  extractAndValidateReview,
  getReadOnlyMode,
  hasChangesToReview,
  ReviewOutput,
  stripEscapeHatchArgs,
} from '../engine/review.js';

export function registerReviewTools(
  config: AgentMCPConfig,
  sessionManager: SessionManager
): MCPToolDefinition[] {
  const tools: MCPToolDefinition[] = [];

  tools.push({
    name: 'agent_review',
    description:
      'Runs a read-only, structured code review (normal or adversarial) over the working tree or a branch diff, using the specified agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'ID of the target agent (e.g. agy, claude, opencode, codex)',
        },
        workspace: {
          type: 'string',
          description: 'Target workspace directory (must be within allowedWorkspaces)',
        },
        scope: {
          type: 'string',
          enum: ['working-tree', 'branch'],
          description: "Review scope (default 'working-tree')",
        },
        baseRef: {
          type: 'string',
          description: "Base ref to diff against; required when scope is 'branch'",
        },
        adversarial: {
          type: 'boolean',
          description: 'Use a skeptical, challenge-the-design review stance (default false)',
        },
        focus: {
          type: 'string',
          description: 'Optional steering text; only used when adversarial is true',
        },
        background: {
          type: 'boolean',
          description: 'Run as a background session instead of blocking (default false)',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Maximum execution time in seconds (default: 600)',
        },
      },
      required: ['agent'],
    },
    handler: async (args) => {
      const agentId = String(args.agent);
      const workspace = args.workspace ? String(args.workspace) : config.allowedWorkspaces[0];
      if (args.scope !== undefined && args.scope !== 'working-tree' && args.scope !== 'branch') {
        throw new Error("scope must be 'working-tree' or 'branch'.");
      }
      const scope = args.scope === 'branch' ? 'branch' : 'working-tree';
      const baseRef = args.baseRef ? String(args.baseRef) : undefined;
      const adversarial = args.adversarial === true;
      const focus = args.focus ? String(args.focus) : undefined;
      const background = args.background === true;
      const timeoutSeconds =
        typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : config.security?.defaultTimeoutSeconds || 600;

      if (scope === 'branch' && !baseRef) {
        throw new Error("baseRef is required when scope is 'branch'.");
      }

      const agentConfig = config.agents[agentId];
      if (!agentConfig) {
        throw new Error(`Agent '${agentId}' is not configured in agent-mcp.`);
      }

      validateWorkspacePath(workspace, config.allowedWorkspaces);

      const hasChanges = await hasChangesToReview({ workspace, scope, baseRef });
      if (!hasChanges) {
        const emptyResult: ReviewOutput = {
          verdict: 'approve',
          summary: 'Nothing to review.',
          findings: [],
          next_steps: [],
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(emptyResult, null, 2) }],
        };
      }

      const readOnlyMode = getReadOnlyMode(agentConfig.transport);

      // When a native read-only mode is requested, the agent's configured escape-hatch
      // flags (--dangerously-skip-permissions / --dangerously-bypass-approvals-and-sandbox)
      // would nullify it, so strip them for this run only.
      const effectiveAgentConfig =
        readOnlyMode !== undefined ? stripEscapeHatchArgs(agentConfig) : agentConfig;

      const prompt = buildReviewPrompt({
        scope,
        baseRef,
        adversarial,
        focus,
        readOnlyEnforced: readOnlyMode !== undefined,
      });

      if (background) {
        const session = sessionManager.createSession(agentId, prompt, workspace, readOnlyMode, {
          kind: 'review',
          timeoutSeconds,
          agentConfigOverride: readOnlyMode !== undefined ? effectiveAgentConfig : undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(session.getInfo(), null, 2) }],
        };
      }

      const adapter = createAdapter(effectiveAgentConfig);
      const controller = new AgentProcessController(effectiveAgentConfig, adapter);

      const result = await controller.runSync({
        prompt,
        workspace,
        mode: readOnlyMode,
        timeoutSeconds,
        sanitizeEnv: config.security?.sanitizeEnv !== false,
      });

      // Parse rawText, not summary: adapters append a "### Tool Calls Executed" block to
      // summary, which corrupts JSON extraction (the review prompt guarantees tool calls).
      const review = extractAndValidateReview(result.rawText || result.summary);
      return {
        content: [{ type: 'text', text: JSON.stringify(review, null, 2) }],
      };
    },
  });

  return tools;
}
