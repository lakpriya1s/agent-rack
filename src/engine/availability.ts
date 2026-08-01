import { execa } from 'execa';
import { AgentMCPConfig, AgentTransportType } from '../config/schema.js';

export interface AgentAvailability {
  agentId: string;
  name: string;
  command: string;
  transport: AgentTransportType;
  description: string;
  status: 'available' | 'missing_binary';
}

/**
 * Resolves whether `command` exists on the current $PATH.
 */
export async function isBinaryAvailable(command: string): Promise<boolean> {
  try {
    await execa('which', [command]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probes every configured agent's binary. Shared by the `agent_list_available` MCP tool and
 * the `agent-mcp agents` CLI command, which differ only in how they render the result.
 */
export async function listAgentAvailability(config: AgentMCPConfig): Promise<AgentAvailability[]> {
  const entries = Object.entries(config.agents);

  return Promise.all(
    entries.map(async ([agentId, agentConfig]): Promise<AgentAvailability> => ({
      agentId,
      name: agentConfig.name,
      command: agentConfig.command,
      transport: agentConfig.transport,
      description: agentConfig.description || '',
      status: (await isBinaryAvailable(agentConfig.command)) ? 'available' : 'missing_binary',
    }))
  );
}
