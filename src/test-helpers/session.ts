import { AgentSession, SessionManager } from '../engine/session.js';

/**
 * Polls a SessionManager until the given session reaches a *terminal* status.
 *
 * Deliberately checks `isTerminal()` rather than `status !== 'running'`: 'cancelling' is a
 * transient state where the child has been signalled but has not exited yet, so treating it as
 * finished would let assertions run while the subprocess is still alive.
 */
export async function waitForSessionCompletion(
  manager: SessionManager,
  sessionId: string,
  timeoutMs = 5000
): Promise<AgentSession> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = manager.getSession(sessionId);
    if (session && session.isTerminal()) return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for session to complete');
}
