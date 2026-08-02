import { describe, expect, it } from 'vitest';
import {
  decideDashboardExit,
  decideDashboardExitFromServer,
  dashboardExitVerificationFailure,
} from './exitDecision.js';

describe('decideDashboardExit', () => {
  it('exits existing/external mode immediately without cancellations', () => {
    expect(decideDashboardExit('existing', false, ['running-1'])).toEqual({ action: 'exit' });
  });

  it('exits owned mode immediately when no sessions are running', () => {
    expect(decideDashboardExit('auto-started', false, [])).toEqual({ action: 'exit' });
  });

  it('warns on the first quit when owned sessions are running', () => {
    expect(decideDashboardExit('auto-started', false, ['running-1'])).toEqual({
      action: 'warn',
      runningCount: 1,
    });
  });

  it('cancels every running session and exits on the second quit', () => {
    expect(decideDashboardExit('auto-started', true, ['running-1', 'running-2'])).toEqual({
      action: 'cancel-and-exit',
      sessionIds: ['running-1', 'running-2'],
    });
  });

  it('uses an authoritative server snapshot instead of a stale UI list', async () => {
    const listSessions = async () => [
      { sessionId: 'just-started', status: 'running' },
      { sessionId: 'finished', status: 'completed' },
    ];

    await expect(
      decideDashboardExitFromServer('auto-started', false, listSessions)
    ).resolves.toEqual({ action: 'warn', runningCount: 1 });
    await expect(
      decideDashboardExitFromServer('auto-started', true, listSessions)
    ).resolves.toEqual({ action: 'cancel-and-exit', sessionIds: ['just-started'] });
  });

  it('arms a deliberate second quit when verification fails so an owned server can still close', async () => {
    const failure = dashboardExitVerificationFailure(new Error('connection lost'));
    expect(failure.exitArmed).toBe(true);
    expect(failure.statusMessage).toContain('Press q again to close');

    await expect(
      decideDashboardExitFromServer('auto-started', false, async () => [
        { sessionId: 'still-running', status: 'running' },
      ])
    ).resolves.toEqual({ action: 'warn', runningCount: 1 });
  });

  it('does not query an existing server when dashboard exit cannot own its sessions', async () => {
    const listSessions = async (): Promise<Array<{ sessionId: string; status: string }>> => {
      throw new Error('must not query');
    };
    await expect(
      decideDashboardExitFromServer('existing', false, listSessions)
    ).resolves.toEqual({ action: 'exit' });
  });
});
