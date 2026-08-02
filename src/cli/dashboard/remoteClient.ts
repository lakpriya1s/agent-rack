import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ParsedAgentEvent } from '../../adapters/base.js';
import type { AgentSessionInfo, SessionKind } from '../../engine/session.js';

export interface DashboardServerIdentity {
  server: 'agent-rack';
  identityVersion: 1;
  configFingerprint: string;
}

const REQUIRED_DASHBOARD_TOOLS = [
  'agent_server_identity',
  'agent_session_list',
  'agent_session_status',
  'agent_session_logs',
  'agent_session_send',
  'agent_session_cancel',
  'agent_session_create',
] as const;

/** Thin MCP client wrapper the dashboard uses instead of owning a local SessionManager. */
export class DashboardRemoteClient {
  private readonly client: Client;
  private connected = false;
  private transport?: SSEClientTransport;

  constructor(private readonly serverUrl: string) {
    this.client = new Client({ name: 'agent-rack-dashboard', version: '1.0.0' }, { capabilities: {} });
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const transport = new SSEClientTransport(new URL(this.serverUrl));
    this.transport = transport;
    try {
      await this.client.connect(transport);
      this.connected = true;
    } catch (err) {
      await transport.close();
      this.transport = undefined;
      throw err;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.connected) {
        await this.client.close();
      } else {
        await this.transport?.close();
      }
    } finally {
      this.connected = false;
      this.transport = undefined;
    }
  }

  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content as Array<{ type: string; text?: string }>)?.[0];
    if (!content || content.type !== 'text' || typeof content.text !== 'string') {
      throw new Error(`Tool '${name}' returned no text content`);
    }
    if (result.isError) {
      throw new Error(content.text);
    }
    return content.text;
  }

  async validateDashboardServer(): Promise<DashboardServerIdentity> {
    const { tools } = await this.client.listTools();
    const available = new Set(tools.map((tool) => tool.name));
    const missing = REQUIRED_DASHBOARD_TOOLS.filter((tool) => !available.has(tool));
    if (missing.length > 0) {
      throw new Error(`Server is missing required dashboard tools: ${missing.join(', ')}`);
    }

    const identity = JSON.parse(
      await this.callTool('agent_server_identity')
    ) as Partial<DashboardServerIdentity>;
    if (
      identity.server !== 'agent-rack' ||
      identity.identityVersion !== 1 ||
      typeof identity.configFingerprint !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(identity.configFingerprint)
    ) {
      throw new Error('Server returned an invalid agent-rack identity.');
    }
    return identity as DashboardServerIdentity;
  }

  async listSessions(): Promise<AgentSessionInfo[]> {
    return JSON.parse(await this.callTool('agent_session_list'));
  }

  async getSessionStatus(sessionId: string): Promise<AgentSessionInfo> {
    return JSON.parse(await this.callTool('agent_session_status', { sessionId }));
  }

  async getSessionLogs(sessionId: string, offset = 0, limit?: number): Promise<ParsedAgentEvent[]> {
    const args: Record<string, unknown> = { sessionId, offset };
    if (limit !== undefined) args.limit = limit;
    return JSON.parse(await this.callTool('agent_session_logs', args));
  }

  async sendInput(sessionId: string, message: string): Promise<void> {
    await this.callTool('agent_session_send', { sessionId, message });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.callTool('agent_session_cancel', { sessionId });
  }

  async createSession(
    agent: string,
    prompt: string,
    workspace: string,
    kind: SessionKind,
    model?: string
  ): Promise<AgentSessionInfo> {
    const args: Record<string, unknown> = { agent, prompt, workspace, kind };
    if (model) args.model = model;
    return JSON.parse(await this.callTool('agent_session_create', args));
  }
}
