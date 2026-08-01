import { randomUUID } from 'node:crypto';
import { AgentConfig, AgentMCPConfig } from '../config/schema.js';
import { createAdapter, FormattedResult } from '../adapters/index.js';
import { AgentProcessController, ProcessRunOptions } from './process.js';
import { validateWorkspacePath } from '../security/workspace.js';

export type SessionStatus = 'running' | 'idle' | 'completed' | 'failed' | 'cancelled';

export interface AgentSessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  status: SessionStatus;
  createdAt: string;
  workspace: string;
  summary?: string;
  eventCount: number;
}

export class AgentSession {
  public readonly id: string;
  public status: SessionStatus = 'running';
  public readonly createdAt: string;
  public readonly controller: AgentProcessController;
  public result?: FormattedResult;
  public error?: string;

  constructor(
    public readonly agentId: string,
    public readonly agentConfig: AgentConfig,
    public readonly workspace: string
  ) {
    this.id = randomUUID();
    this.createdAt = new Date().toISOString();
    const adapter = createAdapter(agentConfig);
    this.controller = new AgentProcessController(agentConfig, adapter);
  }

  getInfo(): AgentSessionInfo {
    return {
      sessionId: this.id,
      agentId: this.agentId,
      agentName: this.agentConfig.name,
      status: this.status,
      createdAt: this.createdAt,
      workspace: this.workspace,
      summary: this.result?.summary || this.error,
      eventCount: this.controller.getBuffer().size(),
    };
  }
}

export class SessionManager {
  private sessions = new Map<string, AgentSession>();

  constructor(private config: AgentMCPConfig) {}

  createSession(
    agentId: string,
    prompt: string,
    workspace?: string,
    mode?: string
  ): AgentSession {
    const activeCount = Array.from(this.sessions.values()).filter((s) => s.status === 'running').length;
    const maxAllowed = this.config.security?.maxConcurrentSessions || 5;

    if (activeCount >= maxAllowed) {
      throw new Error(`Maximum concurrent sessions limit (${maxAllowed}) reached.`);
    }

    const agentConfig = this.config.agents[agentId];
    if (!agentConfig) {
      throw new Error(`Agent '${agentId}' is not defined in configuration.`);
    }

    const targetWorkspace = workspace || this.config.allowedWorkspaces[0];
    validateWorkspacePath(targetWorkspace, this.config.allowedWorkspaces);

    const session = new AgentSession(agentId, agentConfig, targetWorkspace);
    this.sessions.set(session.id, session);

    // Run session asynchronously in background
    const options: ProcessRunOptions = {
      prompt,
      workspace: targetWorkspace,
      mode,
      timeoutSeconds: this.config.security?.defaultTimeoutSeconds || 600,
      sanitizeEnv: this.config.security?.sanitizeEnv !== false,
    };

    session.controller
      .runSync(options)
      .then((result) => {
        session.result = result;
        session.status = 'completed';
      })
      .catch((err) => {
        session.error = err instanceof Error ? err.message : String(err);
        session.status = 'failed';
      });

    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  cancelSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found.`);
    }

    if (session.status === 'running') {
      session.controller.cancel();
      session.status = 'cancelled';
    }

    return session;
  }

  sendToSession(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found.`);
    }

    if (session.status !== 'running') {
      throw new Error(`Cannot send input to session '${sessionId}' because its status is '${session.status}'.`);
    }

    session.controller.sendInput(message);
  }

  listSessions(): AgentSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.getInfo());
  }
}
