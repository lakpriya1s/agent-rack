import { describe, expect, it } from 'vitest';
import type { AgentSessionInfo } from '../../engine/session.js';
import {
  dashboardConfigAuthorityWarning,
  moveSessionSelection,
  prependLaunchedSession,
  refreshSessionList,
  shouldRequestDashboardExit,
  type DashboardSessionListState,
} from './App.js';

function session(sessionId: string): AgentSessionInfo {
  return {
    sessionId,
    agentId: 'test',
    agentName: 'Test Agent',
    status: 'running',
    createdAt: new Date().toISOString(),
    workspace: '/tmp',
    eventCount: 0,
    kind: 'task',
  };
}

describe('dashboard session selection', () => {
  it('preserves the selected session by id when a newer session is prepended by polling', () => {
    const state: DashboardSessionListState = {
      sessions: [session('selected'), session('oldest')],
      selectedSessionId: 'selected',
    };

    const refreshed = refreshSessionList(state, [
      session('newest'),
      session('selected'),
      session('oldest'),
    ]);

    expect(refreshed.selectedSessionId).toBe('selected');
  });

  it('selects a newly launched session atomically with prepending it', () => {
    const state: DashboardSessionListState = {
      sessions: [session('existing')],
      selectedSessionId: 'existing',
    };

    const launched = prependLaunchedSession(state, session('launched'));

    expect(launched.sessions.map((item) => item.sessionId)).toEqual(['launched', 'existing']);
    expect(launched.selectedSessionId).toBe('launched');
  });

  it('labels explicit external configuration as authoritative', () => {
    expect(dashboardConfigAuthorityWarning('external')).toContain('EXTERNAL CONFIG');
    expect(dashboardConfigAuthorityWarning('external')).toContain('workspaces');
    expect(dashboardConfigAuthorityWarning('local')).toBeUndefined();
  });

  it('handles Ctrl+C through the exit guard even while a modal is open', () => {
    expect(shouldRequestDashboardExit('c', true, true)).toBe(true);
    expect(shouldRequestDashboardExit('q', false, true)).toBe(false);
    expect(shouldRequestDashboardExit('q', false, false)).toBe(true);
  });

  it('moves keyboard selection by id and wraps at both ends', () => {
    const state: DashboardSessionListState = {
      sessions: [session('newest'), session('middle'), session('oldest')],
      selectedSessionId: 'middle',
    };

    expect(moveSessionSelection(state, -1).selectedSessionId).toBe('newest');
    expect(moveSessionSelection(state, 1).selectedSessionId).toBe('oldest');
    expect(
      moveSessionSelection({ ...state, selectedSessionId: 'newest' }, -1).selectedSessionId
    ).toBe('oldest');
    expect(
      moveSessionSelection({ ...state, selectedSessionId: 'oldest' }, 1).selectedSessionId
    ).toBe('newest');
  });
});
