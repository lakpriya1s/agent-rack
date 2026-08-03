import { AgentMCPConfig } from '../config/schema.js';
import { SessionManager } from '../engine/session.js';
import { validateWorkspacePath } from '../security/workspace.js';
import { MCPToolDefinition } from './unified.js';
import { resolveExecution, resolveTimeoutSeconds, resolveWorkspace } from './args.js';
import { resolvePolicySupport } from '../security/policy.js';
import {
  buildReviewPrompt,
  hasChangesToReview,
  resolveBaseRefToSha,
  reviewFromResult,
  ReviewOutput,
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
        model: {
          type: 'string',
          description: "Model to run the review with, overriding the agent's configured default model for this call only",
        },
      },
      required: ['agent'],
    },
    handler: async (args) => {
      const agentId = String(args.agent);
      const workspace = resolveWorkspace(args, config);
      if (args.scope !== undefined && args.scope !== 'working-tree' && args.scope !== 'branch') {
        throw new Error("scope must be 'working-tree' or 'branch'.");
      }
      const scope = args.scope === 'branch' ? 'branch' : 'working-tree';
      const baseRef = args.baseRef ? String(args.baseRef) : undefined;
      const adversarial = args.adversarial === true;
      const focus = args.focus ? String(args.focus) : undefined;
      const background = args.background === true;
      const timeoutSeconds = resolveTimeoutSeconds(args, config);

      if (scope === 'branch' && !baseRef) {
        throw new Error("baseRef is required when scope is 'branch'.");
      }

      // Spawn in the canonical path that was actually validated, matching SessionManager.
      const { canonicalPath } = validateWorkspacePath(workspace, config.allowedWorkspaces);

      const hasChanges = await hasChangesToReview({ workspace: canonicalPath, scope, baseRef });
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

      // A review always runs under the read-only policy regardless of the server's configured
      // executionPolicy: escape-hatch flags are stripped and the transport's native read-only
      // mode is selected. This is the one place that overrides the ambient policy downward.
      const { agentConfig: effectiveAgentConfig, mode: readOnlyMode } = resolveExecution(
        config,
        agentId,
        args,
        { policy: 'read-only', ignoreRequestedMode: true }
      );
      const { isNativelyEnforced } = resolvePolicySupport(effectiveAgentConfig.transport, 'read-only');

      // The prompt tells the sub-agent to run a git command, and that agent will likely run it
      // through a shell — so what lands in the prompt is a SHA git itself produced, never the
      // caller's ref string.
      const baseSha =
        scope === 'branch' ? await resolveBaseRefToSha(canonicalPath, baseRef!) : undefined;

      const prompt = buildReviewPrompt({
        scope,
        baseRef: baseSha,
        adversarial,
        focus,
        readOnlyEnforced: isNativelyEnforced,
      });

      const session = sessionManager.createSession(agentId, prompt, canonicalPath, readOnlyMode, {
        kind: 'review',
        timeoutSeconds,
        agentConfigOverride: effectiveAgentConfig,
      });

      if (background) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { ...session.getInfo(), readOnlyEnforcement: isNativelyEnforced ? 'native' : 'prompt-only' },
                null,
                2
              ),
            },
          ],
        };
      }
      const result = await sessionManager.waitForSession(session.id);

      return {
        content: [{ type: 'text', text: JSON.stringify(reviewFromResult(result), null, 2) }],
      };
    },
  });

  return tools;
}
