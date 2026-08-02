import { describe, expect, it } from 'vitest';
import { decideDashboardExit } from './exitDecision.js';

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
});
