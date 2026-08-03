import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { sseTransportInit } from '../../security/auth.js';
import type { BufferedEventPage } from '../../engine/buffer.js';
import type { AgentSessionInfo } from '../../engine/session.js';

export interface DashboardLaunchMetadata {
  agents: string[];
  allowedWorkspaces: string[];
}

export interface DashboardServerIdentity {
  server: 'agent-rack';
  identityVersion: 1;
  configFingerprint: string;
  launchMetadata: DashboardLaunchMetadata;
}

const DASHBOARD_MCP_REQUEST_TIMEOUT_MS = 3000;

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

  constructor(
    private readonly serverUrl: string,
    private readonly token?: string
  ) {
    this.client = new Client({ name: 'agent-rack-dashboard', version: '1.0.0' }, { capabilities: {} });
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    // The token must be on both the SSE handshake and every POST back to /message.
    const transport = new SSEClientTransport(new URL(this.serverUrl), sseTransportInit(this.token));
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
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: DASHBOARD_MCP_REQUEST_TIMEOUT_MS }
    );
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
    const { tools } = await this.client.listTools(undefined, {
      timeout: DASHBOARD_MCP_REQUEST_TIMEOUT_MS,
    });
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
      !/^sha256:[0-9a-f]{64}$/.test(identity.configFingerprint) ||
      !identity.launchMetadata ||
      !Array.isArray(identity.launchMetadata.agents) ||
      !identity.launchMetadata.agents.every((agent) => typeof agent === 'string') ||
      !Array.isArray(identity.launchMetadata.allowedWorkspaces) ||
      !identity.launchMetadata.allowedWorkspaces.every((workspace) => typeof workspace === 'string')
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

  /**
   * Events at or after `cursor`, plus the cursor to resume from. Cursors are monotonic and
   * survive buffer eviction, so a poller never silently stalls the way an array offset did
   * once the retained window filled up.
   */
  async getSessionLogs(sessionId: string, cursor = 0, limit?: number): Promise<BufferedEventPage> {
    const args: Record<string, unknown> = { sessionId, cursor };
    if (limit !== undefined) args.limit = limit;
    return JSON.parse(await this.callTool('agent_session_logs', args));
  }

  /** The most recent `count` events, for a tail view that does not track cursors itself. */
  async getSessionLogTail(sessionId: string, count: number): Promise<BufferedEventPage> {
    return JSON.parse(await this.callTool('agent_session_logs', { sessionId, tail: count }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.callTool('agent_session_delete', { sessionId });
  }

  async sendInput(sessionId: string, message: string): Promise<void> {
    await this.callTool('agent_session_send', { sessionId, message });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.callTool('agent_session_cancel', { sessionId });
  }

  /**
   * Starts a background task session. There is deliberately no `kind` argument: only
   * `agent_review` can create a review session, because only it applies the read-only
   * protections a review implies.
   */
  async createSession(
    agent: string,
    prompt: string,
    workspace: string,
    model?: string
  ): Promise<AgentSessionInfo> {
    const args: Record<string, unknown> = { agent, prompt, workspace };
    if (model) args.model = model;
    return JSON.parse(await this.callTool('agent_session_create', args));
  }

  /**
   * Starts a background review via `agent_review`, which is the only path that applies the
   * read-only mode, strips escape-hatch flags, and runs the git precheck. The dashboard used to
   * get a review session by passing `kind: 'review'` to agent_session_create, which produced a
   * session merely *labelled* a review while running with full write authority.
   */
  async createReview(
    agent: string,
    workspace: string,
    options: { adversarial?: boolean; focus?: string; model?: string } = {}
  ): Promise<AgentSessionInfo> {
    const args: Record<string, unknown> = { agent, workspace, background: true };
    if (options.adversarial) args.adversarial = true;
    if (options.focus) args.focus = options.focus;
    if (options.model) args.model = options.model;
    return JSON.parse(await this.callTool('agent_review', args));
  }
}
