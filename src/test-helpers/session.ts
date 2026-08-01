import { AgentSession, SessionManager } from '../engine/session.js';

/**
 * Polls a SessionManager until the given session leaves the 'running' state.
 * Shared by the engine and tool test suites.
 */
export async function waitForSessionCompletion(
  manager: SessionManager,
  sessionId: string,
  timeoutMs = 5000
): Promise<AgentSession> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = manager.getSession(sessionId);
    if (session && session.status !== 'running') return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for session to complete');
}
