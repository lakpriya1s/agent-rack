import type { DashboardServerMode } from './serverCoordinator.js';

export type DashboardExitDecision =
  | { action: 'exit' }
  | { action: 'warn'; runningCount: number }
  | { action: 'cancel-and-exit'; sessionIds: string[] };

export async function decideDashboardExitFromServer(
  mode: DashboardServerMode,
  armed: boolean,
  listSessions: () => Promise<Array<{ sessionId: string; status: string }>>
): Promise<DashboardExitDecision> {
  if (mode === 'existing') return { action: 'exit' };
  const sessions = await listSessions();
  return decideDashboardExit(
    mode,
    armed,
    sessions
      .filter((session) => session.status === 'running')
      .map((session) => session.sessionId)
  );
}

export function decideDashboardExit(
  mode: DashboardServerMode,
  armed: boolean,
  runningSessionIds: string[]
): DashboardExitDecision {
  if (mode === 'existing' || runningSessionIds.length === 0) return { action: 'exit' };
  if (!armed) return { action: 'warn', runningCount: runningSessionIds.length };
  return { action: 'cancel-and-exit', sessionIds: [...runningSessionIds] };
}
