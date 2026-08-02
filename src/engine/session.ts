import { randomUUID } from 'node:crypto';
import { AgentConfig, AgentMCPConfig } from '../config/schema.js';
import { createAdapter, FormattedResult } from '../adapters/index.js';
import { AgentProcessController, ProcessRunOptions } from './process.js';
import { validateWorkspacePath } from '../security/workspace.js';
import { reviewFromResult, ReviewOutput } from './review.js';

export type SessionStatus = 'running' | 'idle' | 'completed' | 'failed' | 'cancelled';

export type SessionKind = 'task' | 'review';

export interface AgentSessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  status: SessionStatus;
  createdAt: string;
  workspace: string;
  summary?: string;
  eventCount: number;
  review?: ReviewOutput;
  kind: SessionKind;
}

export class AgentSession {
  public readonly id: string;
  public status: SessionStatus = 'running';
  public readonly createdAt: string;
  public readonly controller: AgentProcessController;
  public result?: FormattedResult;
  public error?: string;
  public reviewResult?: ReviewOutput;

  constructor(
    public readonly agentId: string,
    public readonly agentConfig: AgentConfig,
    public readonly workspace: string,
    public readonly kind: SessionKind = 'task'
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
      review: this.reviewResult,
      kind: this.kind,
    };
  }
}

export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private runPromises = new Map<string, Promise<void>>();
  private acceptingSessions = true;
  private shutdownPromise?: Promise<void>;

  constructor(private config: AgentMCPConfig) {}

  createSession(
    agentId: string,
    prompt: string,
    workspace?: string,
    mode?: string,
    options?: {
      kind?: SessionKind;
      /** Replaces the configured agent config (e.g. with escape-hatch flags stripped). */
      agentConfigOverride?: AgentConfig;
      /** Overrides security.defaultTimeoutSeconds for this session only. */
      timeoutSeconds?: number;
    }
  ): AgentSession {
    if (!this.acceptingSessions) {
      throw new Error('Session manager is shutting down and cannot create new sessions.');
    }

    const activeCount = Array.from(this.sessions.values()).filter((s) => s.status === 'running').length;
    const maxAllowed = this.config.security.maxConcurrentSessions;

    if (activeCount >= maxAllowed) {
      throw new Error(`Maximum concurrent sessions limit (${maxAllowed}) reached.`);
    }

    if (!this.config.agents[agentId]) {
      throw new Error(`Agent '${agentId}' is not defined in configuration.`);
    }
    const agentConfig = options?.agentConfigOverride ?? this.config.agents[agentId];

    const targetWorkspace = workspace || this.config.allowedWorkspaces[0];
    validateWorkspacePath(targetWorkspace, this.config.allowedWorkspaces);

    const session = new AgentSession(agentId, agentConfig, targetWorkspace, options?.kind ?? 'task');
    this.sessions.set(session.id, session);

    // Run session asynchronously in background
    const runOptions: ProcessRunOptions = {
      prompt,
      workspace: targetWorkspace,
      mode,
      timeoutSeconds: options?.timeoutSeconds ?? this.config.security.defaultTimeoutSeconds,
      sanitizeEnv: this.config.security.sanitizeEnv,
    };

    const runPromise = session.controller
      .runSync(runOptions)
      .then((result) => {
        session.result = result;
        if (session.status === 'running') session.status = 'completed';
        if (session.kind === 'review') {
          session.reviewResult = reviewFromResult(result);
        }
      })
      .catch((err) => {
        session.error = err instanceof Error ? err.message : String(err);
        if (session.status === 'running') session.status = 'failed';
      })
      .finally(() => {
        this.runPromises.delete(session.id);
      });
    this.runPromises.set(session.id, runPromise);

    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
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

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.acceptingSessions = false;
    this.shutdownPromise = (async () => {
      for (const session of this.sessions.values()) {
        if (session.status === 'running') this.cancelSession(session.id);
      }
      await Promise.allSettled([...this.runPromises.values()]);
    })();
    return this.shutdownPromise;
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
}
