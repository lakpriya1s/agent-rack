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
  exitWhenIdle?: boolean;
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

/**
 * One diffable line per event — the actual text/tool-call content, not just a status word.
 * `sessionLabel` is set only when more than one session can interleave on this stream, so a
 * single-session tail stays uncluttered.
 */
function formatEventLine(event: ParsedAgentEvent, sessionLabel?: string): string {
  const preview = (event.content || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const label = event.toolName ? `${event.type}:${event.toolName}` : event.type;
  return `${sessionLabel ? `${sessionLabel} ` : ''}[${label}] ${preview}`;
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

/** Short, stable prefix identifying whose line this is once several agents interleave. */
export function formatWatchLabel(info: AgentSessionInfo): string {
  return `${info.agentId}:${info.sessionId.slice(0, 8)}`;
}

/**
 * Which sessions a no-id `watch` should start printing on this poll.
 *
 * Everything the server has not shown us yet gets followed, so a watcher started before any
 * agent exists picks each one up as it appears. The exception is the very first poll: sessions
 * that already finished before `watch` began are somebody else's history, and replaying a dozen
 * of them would bury the run the user is actually waiting for — those are reported as a count
 * instead. Oldest-first so concurrent agents appear in the order they were launched.
 */
export function classifyWatchSessions(
  sessions: AgentSessionInfo[],
  seen: ReadonlySet<string>,
  isFirstPoll: boolean
): { follow: AgentSessionInfo[]; skippedFinished: AgentSessionInfo[] } {
  const fresh = sessions
    .filter((info) => !seen.has(info.sessionId))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (!isFirstPoll) return { follow: fresh, skippedFinished: [] };
  return {
    follow: fresh.filter((info) => !TERMINAL_STATUSES.has(info.status)),
    skippedFinished: fresh.filter((info) => TERMINAL_STATUSES.has(info.status)),
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface WatchedSession {
  cursor: number;
  lastStatus: string;
  label: string;
}

type EventEmitter = (event: ParsedAgentEvent, session: WatchedSession) => void;

function buildEmitter(options: SessionWatchOptions, sessionId: string, labelled: boolean): EventEmitter {
  return (event, session) => {
    if (options.json) {
      // The sessionId rides along in JSON mode: with several agents interleaving, a consumer
      // otherwise cannot tell whose event it just read.
      console.log(JSON.stringify(labelled ? { sessionId, ...event } : event));
      return;
    }
    console.log(formatEventLine(event, labelled ? session.label : undefined));
  };
}

/** Print the retained tail of a session we just started following, and return its resume cursor. */
async function printBacklog(
  client: DashboardRemoteClient,
  sessionId: string,
  count: number,
  emit: EventEmitter,
  session: WatchedSession
): Promise<number> {
  const backlog = await client.getSessionLogTail(sessionId, count);
  if (backlog.droppedCount > 0) {
    console.log(`[${backlog.droppedCount} earlier event(s) dropped from the retained log]`);
  }
  for (const event of backlog.events) emit(event, session);
  return backlog.nextCursor;
}

/**
 * Advance one followed session: print any status change, plus everything new since its cursor.
 *
 * Status is *read* first and the drain follows, so an agent that finishes between the two calls
 * still has its final events printed. A terminal status is *printed* last, though — it is the
 * session's closing line, and emitting it above the output it summarises reads like the events
 * arrived after the agent stopped.
 */
async function drainSession(
  client: DashboardRemoteClient,
  sessionId: string,
  session: WatchedSession,
  emit: EventEmitter
): Promise<AgentSessionInfo> {
  const info = await client.getSessionStatus(sessionId);
  const statusChanged = info.status !== session.lastStatus;
  const isTerminal = TERMINAL_STATUSES.has(info.status);
  session.lastStatus = info.status;
  if (statusChanged && !isTerminal) console.log(formatSessionLine(info));

  const page = await client.getSessionLogs(sessionId, session.cursor);
  if (page.droppedCount > 0) {
    console.log(`[${page.droppedCount} event(s) dropped from the retained log]`);
  }
  for (const event of page.events) emit(event, session);
  session.cursor = page.nextCursor;

  if (statusChanged && isTerminal) console.log(formatSessionLine(info));
  return info;
}

/**
 * `tail -f` for one named background session: prints a backlog, then only what is new on each
 * poll, and exits when the session settles. Cursor-based rather than count-based, so a busy
 * agent cannot outrun the poll interval and have its output silently skipped —
 * `getSessionLogs(cursor)` returns everything since the last read, and reports `droppedCount`
 * when the retained tail scrolled past something we never saw.
 */
async function watchOneSession(
  client: DashboardRemoteClient,
  sessionId: string,
  options: SessionWatchOptions,
  intervalMs: number
): Promise<void> {
  const emit = buildEmitter(options, sessionId, false);
  const session: WatchedSession = { cursor: 0, lastStatus: '', label: '' };
  session.cursor = await printBacklog(client, sessionId, options.count ?? 10, emit, session);

  for (;;) {
    const info = await drainSession(client, sessionId, session, emit);
    if (TERMINAL_STATUSES.has(info.status)) return;
    await delay(intervalMs);
  }
}

/**
 * `tail -f` for the *server* rather than for one session: waits on the port and follows every
 * sub-agent that shows up, several at once, prefixing each line with whose it is. This is the
 * no-id shape because that is when the user cannot name a session — typically they opened a
 * second terminal before launching anything, so "nothing is running yet" must mean "wait", not
 * "exit". It keeps waiting after a session finishes, since the next agent may still be coming.
 */
async function watchAllSessions(
  client: DashboardRemoteClient,
  url: string,
  options: SessionWatchOptions,
  intervalMs: number
): Promise<void> {
  const tracked = new Map<string, WatchedSession>();
  // Both followed-and-finished and skipped-as-history land here, so neither is picked up again
  // on a later poll.
  const seen = new Set<string>();
  let isFirstPoll = true;
  let followedAnything = false;
  let announcedWaiting = false;

  for (;;) {
    let sessions: AgentSessionInfo[];
    try {
      sessions = await client.listSessions();
    } catch (error) {
      throw new Error(
        `Lost the connection to the agent-rack server at ${url}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }

    const { follow, skippedFinished } = classifyWatchSessions(sessions, seen, isFirstPoll);
    if (skippedFinished.length > 0) {
      console.error(
        `ignoring ${skippedFinished.length} session(s) that finished before watch started — ` +
          `pass a sessionId to replay one`
      );
      for (const info of skippedFinished) seen.add(info.sessionId);
    }

    for (const info of follow) {
      const session: WatchedSession = { cursor: 0, lastStatus: '', label: formatWatchLabel(info) };
      seen.add(info.sessionId);
      tracked.set(info.sessionId, session);
      followedAnything = true;
      announcedWaiting = false;
      console.error(`following ${session.label} (${info.status}, ${info.workspace})`);
      const emit = buildEmitter(options, info.sessionId, true);
      session.cursor = await printBacklog(client, info.sessionId, options.count ?? 10, emit, session);
    }

    for (const [sessionId, session] of [...tracked]) {
      const emit = buildEmitter(options, sessionId, true);
      let info: AgentSessionInfo;
      try {
        info = await drainSession(client, sessionId, session, emit);
      } catch (error) {
        // Retention pruning can delete a session out from under us; that is not a watch failure.
        console.error(
          `stopped following ${session.label}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
        tracked.delete(sessionId);
        continue;
      }
      if (TERMINAL_STATUSES.has(info.status)) tracked.delete(sessionId);
    }

    if (tracked.size === 0) {
      if (options.exitWhenIdle && followedAnything) return;
      if (!announcedWaiting) {
        announcedWaiting = true;
        console.error(`waiting for a sub-agent session on ${url} — Ctrl-C to stop`);
      }
    }

    isFirstPoll = false;
    await delay(intervalMs);
  }
}

/**
 * Follows one session when given an id, and otherwise the whole server — see
 * `watchOneSession` / `watchAllSessions` for the two shapes.
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
    if (sessionId) {
      await watchOneSession(client, sessionId, options, intervalMs);
      return;
    }
    await watchAllSessions(client, url, options, intervalMs);
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
