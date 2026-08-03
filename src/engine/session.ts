import { randomUUID } from 'node:crypto';
import { AgentConfig, AgentMCPConfig } from '../config/schema.js';
import { createAdapter, FormattedResult } from '../adapters/index.js';
import { AgentProcessController, ProcessRunOptions } from './process.js';
import { validateWorkspacePath } from '../security/workspace.js';
import { reviewFromResult, ReviewOutput } from './review.js';

/**
 * `cancelling` exists because cancellation is not instantaneous: the child gets SIGINT and up
 * to a 3-second grace period before SIGKILL. Reporting 'cancelled' immediately (as this used
 * to) meant the concurrency check — which counts only 'running' — let callers start extra
 * sessions during that window and overshoot `maxConcurrentSessions`.
 *
 * The previously-declared `idle` status was never assigned anywhere and has been dropped.
 */
export type SessionStatus = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export type SessionKind = 'task' | 'review';

const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'completed',
  'failed',
  'cancelled',
]);

export interface AgentSessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  status: SessionStatus;
  createdAt: string;
  /** Set once the session reaches a terminal status; drives retention pruning. */
  finishedAt?: string;
  workspace: string;
  summary?: string;
  /**
   * Monotonic count of every event this session has produced, including ones evicted from the
   * retained tail. Safe to compare across polls to detect progress — unlike the retained
   * buffer length, which plateaus at its cap and then never changes again.
   */
  eventCount: number;
  /** Events dropped from the retained tail so far. */
  droppedEventCount: number;
  /** Cursor to pass to agent_session_logs to fetch only what is new. */
  nextCursor: number;
  review?: ReviewOutput;
  kind: SessionKind;
  /** Whether this transport can accept agent_session_send follow-up input. */
  supportsFollowUp: boolean;
}

export class AgentSession {
  public readonly id: string;
  public status: SessionStatus = 'running';
  public readonly createdAt: string;
  public finishedAt?: string;
  public readonly controller: AgentProcessController;
  public result?: FormattedResult;
  public error?: string;
  public reviewResult?: ReviewOutput;

  constructor(
    public readonly agentId: string,
    public readonly agentConfig: AgentConfig,
    public readonly workspace: string,
    public readonly kind: SessionKind = 'task',
    controllerOptions: { maxEvents?: number; maxBytes?: number } = {}
  ) {
    this.id = randomUUID();
    this.createdAt = new Date().toISOString();
    const adapter = createAdapter(agentConfig);
    this.controller = new AgentProcessController(agentConfig, adapter, controllerOptions);
  }

  /** Marks a terminal status once, stamping the time retention is measured from. */
  settle(status: SessionStatus): void {
    this.status = status;
    this.finishedAt ??= new Date().toISOString();
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.status);
  }

  getInfo(): AgentSessionInfo {
    const buffer = this.controller.getBuffer();
    return {
      sessionId: this.id,
      agentId: this.agentId,
      agentName: this.agentConfig.name,
      status: this.status,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      workspace: this.workspace,
      summary: this.result?.summary || this.error,
      eventCount: buffer.totalEvents(),
      droppedEventCount: buffer.droppedEvents(),
      nextCursor: buffer.totalEvents(),
      review: this.reviewResult,
      kind: this.kind,
      supportsFollowUp: this.controller.adapter.capabilities.supportsFollowUp,
    };
  }
}

export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private runPromises = new Map<string, Promise<void>>();
  private acceptingSessions = true;
  private shutdownPromise?: Promise<void>;

  constructor(private config: AgentMCPConfig) {}

  /**
   * Counts sessions whose child process may still be alive. Deliberately based on the
   * controller rather than `status`: a 'cancelling' session still holds a real subprocess
   * until SIGKILL lands, and not counting it lets the concurrency cap be exceeded.
   */
  private activeProcessCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === 'running' || session.status === 'cancelling') count++;
      else if (session.controller.isProcessLive()) count++;
    }
    return count;
  }

  /**
   * Drops finished sessions that are older than the retention window, then trims oldest-first
   * to `maxRetainedSessions`. Without this the map grows for the lifetime of the process — an
   * unbounded leak for a long-lived SSE server, since every `agent_run` lands here too.
   *
   * Running and cancelling sessions are never pruned regardless of age.
   */
  private pruneSessions(): void {
    const { sessionRetentionMinutes, maxRetainedSessions } = this.config.security;
    const cutoff = Date.now() - sessionRetentionMinutes * 60_000;

    const terminal: AgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (!session.isTerminal()) continue;
      const finishedAt = session.finishedAt ? Date.parse(session.finishedAt) : 0;
      if (finishedAt && finishedAt < cutoff) {
        this.sessions.delete(session.id);
      } else {
        terminal.push(session);
      }
    }

    if (terminal.length <= maxRetainedSessions) return;
    terminal
      .sort((a, b) => Date.parse(a.finishedAt ?? a.createdAt) - Date.parse(b.finishedAt ?? b.createdAt))
      .slice(0, terminal.length - maxRetainedSessions)
      .forEach((session) => this.sessions.delete(session.id));
  }

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

    this.pruneSessions();

    const activeCount = this.activeProcessCount();
    const maxAllowed = this.config.security.maxConcurrentSessions;

    if (activeCount >= maxAllowed) {
      throw new Error(`Maximum concurrent sessions limit (${maxAllowed}) reached.`);
    }

    if (!this.config.agents[agentId]) {
      throw new Error(`Agent '${agentId}' is not defined in configuration.`);
    }
    const agentConfig = options?.agentConfigOverride ?? this.config.agents[agentId];

    const targetWorkspace = workspace || this.config.allowedWorkspaces[0];
    // Spawn in the canonical (symlink-resolved) path that was actually validated, so the
    // child's cwd cannot differ from the directory the security check approved.
    const { canonicalPath } = validateWorkspacePath(targetWorkspace, this.config.allowedWorkspaces);

    const session = new AgentSession(
      agentId,
      agentConfig,
      canonicalPath,
      options?.kind ?? 'task',
      { maxBytes: this.config.security.maxSessionOutputBytes }
    );
    this.sessions.set(session.id, session);

    // Run session asynchronously in background
    const runOptions: ProcessRunOptions = {
      prompt,
      workspace: canonicalPath,
      mode,
      timeoutSeconds: options?.timeoutSeconds ?? this.config.security.defaultTimeoutSeconds,
      sanitizeEnv: this.config.security.sanitizeEnv,
    };

    const runPromise = session.controller
      .runSync(runOptions)
      .then((result) => {
        session.result = result;
        // A cancelled session settles as 'cancelled', not 'completed' — the child exiting is
        // the *consequence* of the cancel, not a successful run.
        session.settle(session.status === 'cancelling' ? 'cancelled' : 'completed');
        if (session.kind === 'review') {
          session.reviewResult = reviewFromResult(result);
        }
      })
      .catch((err) => {
        session.error = err instanceof Error ? err.message : String(err);
        session.settle(session.status === 'cancelling' ? 'cancelled' : 'failed');
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

  /** Awaits a tracked session, including foreground callers that need its final result. */
  async waitForSession(sessionId: string): Promise<FormattedResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found.`);
    }

    await this.runPromises.get(sessionId);
    if (session.result) return session.result;
    throw new Error(session.error ?? `Session '${sessionId}' completed without a result.`);
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
      // 'cancelling' until the child actually exits; the run promise settles it to 'cancelled'.
      session.status = 'cancelling';
    }

    return session;
  }

  /** Forgets a terminal session. Running/cancelling sessions must be cancelled first. */
  deleteSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found.`);
    }
    if (!session.isTerminal()) {
      throw new Error(
        `Session '${sessionId}' is still ${session.status}; cancel it before deleting.`
      );
    }
    this.sessions.delete(sessionId);
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

    // Refuse on capability before status: "this transport can never do this" is a different
    // and more useful message than "the session isn't running".
    if (!session.controller.adapter.capabilities.supportsFollowUp) {
      throw new Error(
        `Agent '${session.agentId}' (transport '${session.agentConfig.transport}') does not ` +
          `support follow-up input. Its CLI takes the prompt as a command-line argument and ` +
          `exits when the turn ends, so there is no channel to send to. Create a new session ` +
          `with the follow-up as its prompt instead.`
      );
    }

    if (session.status !== 'running') {
      throw new Error(
        `Cannot send input to session '${sessionId}' because its status is '${session.status}'.`
      );
    }

    session.controller.sendInput(message);
  }
}
