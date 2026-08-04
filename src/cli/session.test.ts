import { describe, it, expect } from 'vitest';
import { pickWatchTarget } from './session.js';
import type { AgentSessionInfo } from '../engine/session.js';

function session(overrides: Partial<AgentSessionInfo>): AgentSessionInfo {
  return {
    sessionId: 'id',
    agentId: 'claude',
    agentName: 'Claude Code CLI',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    workspace: '/tmp',
    eventCount: 0,
    droppedEventCount: 0,
    nextCursor: 0,
    kind: 'task',
    supportsFollowUp: false,
    followUpMode: 'none',
    turnCount: 1,
    ...overrides,
  } as AgentSessionInfo;
}

describe('pickWatchTarget', () => {
  it('returns null when the server tracks no sessions', () => {
    expect(pickWatchTarget([])).toBeNull();
  });

  it('prefers the newest non-terminal session over a newer finished one', () => {
    // The point of `watch` with no id: follow the thing still running, even when a later session
    // has already come and gone.
    const picked = pickWatchTarget([
      session({ sessionId: 'old-done', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' }),
      session({ sessionId: 'running', status: 'running', createdAt: '2026-01-01T00:01:00.000Z' }),
      session({ sessionId: 'new-done', status: 'completed', createdAt: '2026-01-01T00:02:00.000Z' }),
    ]);
    expect(picked?.sessionId).toBe('running');
  });

  it('picks the newest of several running sessions', () => {
    const picked = pickWatchTarget([
      session({ sessionId: 'first', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' }),
      session({ sessionId: 'second', status: 'running', createdAt: '2026-01-01T00:05:00.000Z' }),
    ]);
    expect(picked?.sessionId).toBe('second');
  });

  it('treats cancelling as still active — the child may not be dead yet', () => {
    const picked = pickWatchTarget([
      session({ sessionId: 'done', status: 'completed', createdAt: '2026-01-01T00:09:00.000Z' }),
      session({ sessionId: 'winding-down', status: 'cancelling', createdAt: '2026-01-01T00:01:00.000Z' }),
    ]);
    expect(picked?.sessionId).toBe('winding-down');
  });

  it('falls back to the newest terminal session when nothing is active', () => {
    const picked = pickWatchTarget([
      session({ sessionId: 'older', status: 'failed', createdAt: '2026-01-01T00:00:00.000Z' }),
      session({ sessionId: 'newest', status: 'completed', createdAt: '2026-01-01T00:03:00.000Z' }),
    ]);
    expect(picked?.sessionId).toBe('newest');
  });

  it('does not mutate the caller list order', () => {
    const sessions = [
      session({ sessionId: 'a', createdAt: '2026-01-01T00:00:00.000Z' }),
      session({ sessionId: 'b', createdAt: '2026-01-01T00:05:00.000Z' }),
    ];
    pickWatchTarget(sessions);
    expect(sessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
  });
});
