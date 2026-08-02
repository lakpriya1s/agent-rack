import type { DashboardServerMode } from './serverCoordinator.js';

export type DashboardExitDecision =
  | { action: 'exit' }
  | { action: 'warn'; runningCount: number }
  | { action: 'cancel-and-exit'; sessionIds: string[] };

export function decideDashboardExit(
  mode: DashboardServerMode,
  armed: boolean,
  runningSessionIds: string[]
): DashboardExitDecision {
  if (mode === 'existing' || runningSessionIds.length === 0) return { action: 'exit' };
  if (!armed) return { action: 'warn', runningCount: runningSessionIds.length };
  return { action: 'cancel-and-exit', sessionIds: [...runningSessionIds] };
}
