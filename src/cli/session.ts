import { loadConfig } from '../config/loader.js';
import { resolveDashboardServerUrl } from './dashboard/connection.js';
import { DashboardRemoteClient } from './dashboard/remoteClient.js';
import type { AgentSessionInfo } from '../engine/session.js';
import type { ParsedAgentEvent } from '../adapters/base.js';

export interface SessionCommandOptions {
  config?: string;
  connect?: string;
  json?: boolean;
}

export interface SessionTailOptions extends SessionCommandOptions {
  count?: number;
}

export interface SessionWatchOptions extends SessionTailOptions {
  interval?: number;
}

async function connectSessionClient(
  options: Pick<SessionCommandOptions, 'config' | 'connect'>
): Promise<{ client: DashboardRemoteClient; url: string }> {
  const { config } = loadConfig(options.config);
  const { url, token } = resolveDashboardServerUrl(config, options.connect);
  const client = new DashboardRemoteClient(url, token);
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Could not reach an agent-rack server at ${url}. This command polls an already-running ` +
        `SSE server — start one first with 'agent-rack start --transport sse' or ` +
        `'agent-rack dashboard', or pass --connect <url>.` +
        (token
          ? ''
          : ` No auth token was found for this server; if it is running elsewhere, set ` +
            `AGENT_RACK_TOKEN or append ?token=<token> to --connect.`) +
        ` Connection error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { client, url };
}

/** One diffable line per session, safe to compare across polls in a shell loop. */
function formatSessionLine(info: AgentSessionInfo): string {
  const summary = (info.summary || '').replace(/\s+/g, ' ').trim();
  // `events` is the monotonic total, not the retained buffer length — so this line keeps
  // changing as the agent works even after the retained tail has hit its cap.
  return `sessionId=${info.sessionId} agent=${info.agentId} kind=${info.kind} status=${info.status} events=${info.eventCount} summary="${summary}"`;
}

export async function runSessionStatus(sessionId: string, options: SessionCommandOptions): Promise<void> {
  const { client } = await connectSessionClient(options);
  try {
    const info = await client.getSessionStatus(sessionId);
    console.log(options.json ? JSON.stringify(info, null, 2) : formatSessionLine(info));
  } finally {
    await client.close();
  }
}

/** One diffable line per event — the actual text/tool-call content, not just a status word. */
function formatEventLine(event: ParsedAgentEvent): string {
  const preview = (event.content || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const label = event.toolName ? `${event.type}:${event.toolName}` : event.type;
  return `[${label}] ${preview}`;
}

export async function runSessionTail(sessionId: string, options: SessionTailOptions): Promise<void> {
  const { client } = await connectSessionClient(options);
  try {
    const info = await client.getSessionStatus(sessionId);
    const count = options.count ?? 5;
    // Ask the server for the tail directly rather than deriving an offset from a count: the
    // retained window may start well past zero once older events have been evicted.
    const page = await client.getSessionLogTail(sessionId, count);

    if (options.json) {
      console.log(JSON.stringify(page, null, 2));
      return;
    }
    if (page.events.length === 0) {
      console.log(`sessionId=${sessionId} status=${info.status} (no events yet)`);
      return;
    }
    if (page.droppedCount > 0) {
      console.log(`[${page.droppedCount} earlier event(s) dropped from the retained log]`);
    }
    for (const event of page.events) console.log(formatEventLine(event));
  } finally {
    await client.close();
  }
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Which session `watch` follows when the caller gives no id — the newest one that is still
 * doing something, else simply the newest. Someone who just launched a sub-agent and typed
 * `agent-rack watch` in another terminal means "the thing I just started", and that is almost
 * always the most recent running session.
 */
export function pickWatchTarget(sessions: AgentSessionInfo[]): AgentSessionInfo | null {
  if (sessions.length === 0) return null;
  const newestFirst = [...sessions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  return newestFirst.find((s) => !TERMINAL_STATUSES.has(s.status)) ?? newestFirst[0];
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `tail -f` for a background session: prints a backlog, then only what is new on each poll and
 * exits when the session settles. Cursor-based rather than count-based, so a busy agent cannot
 * outrun the poll interval and have its output silently skipped — `getSessionLogs(cursor)`
 * returns everything since the last read, and reports `droppedCount` when the retained tail
 * scrolled past something we never saw.
 */
export async function runSessionWatch(
  sessionId: string | undefined,
  options: SessionWatchOptions
): Promise<void> {
  const { client, url } = await connectSessionClient(options);
  const intervalMs = Math.max(1, options.interval ?? 2) * 1000;
  let closed = false;
  const closeOnce = async () => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  // Ctrl-C should hang up the MCP connection rather than leave the server holding a dead one.
  process.once('SIGINT', () => {
    void closeOnce().then(() => process.exit(0));
  });

  try {
    let target = sessionId;
    if (!target) {
      const picked = pickWatchTarget(await client.listSessions());
      if (!picked) {
        console.log(`No sessions tracked by the agent-rack server at ${url}.`);
        return;
      }
      target = picked.sessionId;
      console.error(`following ${target} (${picked.agentId}, ${picked.status}) — newest session`);
    }

    const emit = (event: ParsedAgentEvent) =>
      console.log(options.json ? JSON.stringify(event) : formatEventLine(event));

    const backlog = await client.getSessionLogTail(target, options.count ?? 10);
    if (backlog.droppedCount > 0) {
      console.log(`[${backlog.droppedCount} earlier event(s) dropped from the retained log]`);
    }
    for (const event of backlog.events) emit(event);
    let cursor = backlog.nextCursor;
    let lastStatus = '';

    for (;;) {
      // Status first, drain second: an agent that finishes between the two calls still has its
      // final events printed below before this returns.
      const info = await client.getSessionStatus(target);
      if (info.status !== lastStatus) {
        console.log(formatSessionLine(info));
        lastStatus = info.status;
      }

      const page = await client.getSessionLogs(target, cursor);
      if (page.droppedCount > 0) {
        console.log(`[${page.droppedCount} event(s) dropped from the retained log]`);
      }
      for (const event of page.events) emit(event);
      cursor = page.nextCursor;

      if (TERMINAL_STATUSES.has(info.status)) return;
      await delay(intervalMs);
    }
  } finally {
    await closeOnce();
  }
}

export async function runSessionList(options: SessionCommandOptions): Promise<void> {
  const { client } = await connectSessionClient(options);
  try {
    const sessions = await client.listSessions();
    if (options.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log('No sessions tracked by this server.');
      return;
    }
    for (const info of sessions) console.log(formatSessionLine(info));
  } finally {
    await client.close();
  }
}
