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

async function connectSessionClient(
  options: Pick<SessionCommandOptions, 'config' | 'connect'>
): Promise<{ client: DashboardRemoteClient; url: string }> {
  const { config } = loadConfig(options.config);
  const { url } = resolveDashboardServerUrl(config, options.connect);
  const client = new DashboardRemoteClient(url);
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Could not reach an agent-rack server at ${url}. This command polls an already-running ` +
        `SSE server — start one first with 'agent-rack start --transport sse' or ` +
        `'agent-rack dashboard', or pass --connect <url>. ` +
        `Connection error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { client, url };
}

/** One diffable line per session, safe to compare across polls in a shell loop. */
function formatSessionLine(info: AgentSessionInfo): string {
  const summary = (info.summary || '').replace(/\s+/g, ' ').trim();
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
    const offset = Math.max(info.eventCount - count, 0);
    const events = await client.getSessionLogs(sessionId, offset);

    if (options.json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    if (events.length === 0) {
      console.log(`sessionId=${sessionId} status=${info.status} (no events yet)`);
      return;
    }
    for (const event of events) console.log(formatEventLine(event));
  } finally {
    await client.close();
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
