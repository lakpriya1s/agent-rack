import { AgentMCPConfig } from '../config/schema.js';
import { MCPToolDefinition } from './unified.js';

export function registerShortcutTools(
  config: AgentMCPConfig,
  unifiedRunHandler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
): MCPToolDefinition[] {
  const shortcutTools: MCPToolDefinition[] = [];

  for (const [agentId, agentConfig] of Object.entries(config.agents)) {
    const toolName = `${agentId.toLowerCase()}_run`;

    shortcutTools.push({
      name: toolName,
      description: `Shorthand to execute a subtask directly with the '${agentConfig.name}' (${agentConfig.command}) sub-agent`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: `Prompt/instruction for ${agentConfig.name}`,
          },
          workspace: {
            type: 'string',
            description: 'Target workspace directory (must be in allowedWorkspaces)',
          },
          timeoutSeconds: {
            type: 'number',
            description: 'Maximum execution time in seconds',
          },
          mode: {
            type: 'string',
            description: 'Execution mode',
          },
        },
        required: ['prompt'],
      },
      handler: async (args) => {
        return unifiedRunHandler({
          ...args,
          agent: agentId,
        });
      },
    });
  }

  return shortcutTools;
}
