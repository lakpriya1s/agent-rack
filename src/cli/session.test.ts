import { describe, it, expect } from 'vitest';
import { classifyWatchSessions, formatWatchLabel } from './session.js';
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

describe('classifyWatchSessions', () => {
  it('follows nothing, and skips nothing, on an empty server', () => {
    // The watcher is expected to keep waiting here rather than treat this as an end state.
    expect(classifyWatchSessions([], new Set(), true)).toEqual({ follow: [], skippedFinished: [] });
  });

  it('follows every active session at once, oldest launch first', () => {
    const { follow } = classifyWatchSessions(
      [
        session({ sessionId: 'second', status: 'running', createdAt: '2026-01-01T00:05:00.000Z' }),
        session({ sessionId: 'first', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
      new Set(),
      true
    );
    expect(follow.map((s) => s.sessionId)).toEqual(['first', 'second']);
  });

  it('skips sessions that finished before watch started instead of replaying them', () => {
    const { follow, skippedFinished } = classifyWatchSessions(
      [
        session({ sessionId: 'history', status: 'completed' }),
        session({ sessionId: 'failed-history', status: 'failed' }),
        session({ sessionId: 'live', status: 'running' }),
      ],
      new Set(),
      true
    );
    expect(follow.map((s) => s.sessionId)).toEqual(['live']);
    expect(skippedFinished.map((s) => s.sessionId)).toEqual(['history', 'failed-history']);
  });

  it('treats cancelling as still active — the child may not be dead yet', () => {
    const { follow } = classifyWatchSessions(
      [session({ sessionId: 'winding-down', status: 'cancelling' })],
      new Set(),
      true
    );
    expect(follow.map((s) => s.sessionId)).toEqual(['winding-down']);
  });

  it('follows a session that appears after startup even if it already finished', () => {
    // A short run can complete inside one poll interval; its output is still what the user is
    // waiting for, so a later poll must not discard it as history.
    const { follow, skippedFinished } = classifyWatchSessions(
      [session({ sessionId: 'quick', status: 'completed' })],
      new Set(),
      false
    );
    expect(follow.map((s) => s.sessionId)).toEqual(['quick']);
    expect(skippedFinished).toEqual([]);
  });

  it('never re-follows a session it has already seen', () => {
    const { follow } = classifyWatchSessions(
      [
        session({ sessionId: 'known', status: 'running' }),
        session({ sessionId: 'new', status: 'running' }),
      ],
      new Set(['known']),
      false
    );
    expect(follow.map((s) => s.sessionId)).toEqual(['new']);
  });

  it('does not mutate the caller list order', () => {
    const sessions = [
      session({ sessionId: 'a', status: 'running', createdAt: '2026-01-01T00:05:00.000Z' }),
      session({ sessionId: 'b', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    classifyWatchSessions(sessions, new Set(), true);
    expect(sessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
  });
});

describe('formatWatchLabel', () => {
  it('labels interleaved lines by agent and a short session id', () => {
    expect(
      formatWatchLabel(session({ agentId: 'codex', sessionId: '1a2b3c4d-5e6f-7890-abcd-ef1234567890' }))
    ).toBe('codex:1a2b3c4d');
  });
});
