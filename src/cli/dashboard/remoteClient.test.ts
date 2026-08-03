import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type http from 'http';
import { startAgentMCPServer, type ManagedAgentMCPServer } from '../../server.js';
import { DashboardRemoteClient } from './remoteClient.js';
import { loadConfig } from '../../config/loader.js';
import { fingerprintAgentMCPConfig } from '../../config/fingerprint.js';

let runningServer: ManagedAgentMCPServer | undefined;

afterEach(async () => {
  if (!runningServer) return;

  const server = runningServer;
  runningServer = undefined;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
});

async function startTestServer(configPath: string) {
  runningServer = await startAgentMCPServer({ transport: 'sse', port: 0, configPath });
  const port = (runningServer!.address() as AddressInfo).port;
  // Auth is on by default, so the token has to come along or every call 401s.
  return { url: `http://localhost:${port}/sse`, token: runningServer!.agentRackToken };
}

describe('DashboardRemoteClient', () => {
  it('passes an SDK timeout to session-list tool calls', async () => {
    const dashboard = new DashboardRemoteClient('http://127.0.0.1:8987/sse');
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: '[]' }],
    }));
    (dashboard as unknown as { client: { callTool: typeof callTool } }).client.callTool = callTool;

    await dashboard.listSessions();

    expect(callTool).toHaveBeenCalledWith(
      { name: 'agent_session_list', arguments: {} },
      undefined,
      { timeout: 3000 }
    );
  });

  it('passes an SDK timeout to cancellation tool calls', async () => {
    const dashboard = new DashboardRemoteClient('http://127.0.0.1:8987/sse');
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'cancelled' }],
    }));
    (dashboard as unknown as { client: { callTool: typeof callTool } }).client.callTool = callTool;

    await dashboard.cancelSession('session-1');

    expect(callTool).toHaveBeenCalledWith(
      { name: 'agent_session_cancel', arguments: { sessionId: 'session-1' } },
      undefined,
      { timeout: 3000 }
    );
  });

  it('creates a session, lists it, and reads its logs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-remote-client-'));
    const echoScript = path.join(dir, 'echo.cjs');
    fs.writeFileSync(
      echoScript,
      "console.log(JSON.stringify({ type: 'assistant', text: 'pong' }));\n"
    );
    const configPath = path.join(dir, 'agent-rack.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        transport: 'sse',
        allowedWorkspaces: [dir],
        agents: {
          echoer: { name: 'Echoer', command: 'node', args: [echoScript], transport: 'claude_stream_json', env: {} },
        },
      })
    );

    let client: DashboardRemoteClient | undefined;
    try {
      const { url, token } = await startTestServer(configPath);
      client = new DashboardRemoteClient(url, token);
      await client.connect();

      await expect(client.validateDashboardServer()).resolves.toEqual({
        server: 'agent-rack',
        identityVersion: 1,
        configFingerprint: fingerprintAgentMCPConfig(loadConfig(configPath).config),
        launchMetadata: {
          agents: ['echoer'],
          allowedWorkspaces: [dir],
        },
      });

      const created = await client.createSession('echoer', 'hello', dir);
      expect(created.agentId).toBe('echoer');
      expect(created.kind).toBe('task');

      let sessions = await client.listSessions();
      const deadline = Date.now() + 5000;
      while (sessions.find((s) => s.sessionId === created.sessionId)?.status === 'running' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        sessions = await client.listSessions();
      }

      const found = sessions.find((s) => s.sessionId === created.sessionId);
      expect(found?.status).toBe('completed');

      const logs = await client.getSessionLogs(created.sessionId);
      expect(logs.events.some((e) => e.content.includes('pong'))).toBe(true);
      expect(logs.nextCursor).toBe(logs.totalEvents);
    } finally {
      try {
        await client?.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('keeps later events visible when bounded log history rolls over', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-log-rollover-'));
    const scriptPath = path.join(dir, 'rollover.cjs');
    const triggerPath = path.join(dir, 'continue');
    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('fs');",
        "for (let i = 0; i < 512; i++) console.log(JSON.stringify({ type: 'assistant', text: `initial-${i}` }));",
        'const timer = setInterval(() => {',
        `  if (!fs.existsSync(${JSON.stringify(triggerPath)})) return;`,
        '  clearInterval(timer);',
        "  for (let i = 512; i < 528; i++) console.log(JSON.stringify({ type: 'assistant', text: `rollover-${i}` }));",
        '  process.exit(0);',
        '}, 10);',
      ].join('\n')
    );
    const configPath = path.join(dir, 'agent-rack.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        transport: 'sse',
        allowedWorkspaces: [dir],
        agents: {
          emitter: {
            name: 'Emitter',
            command: 'node',
            args: [scriptPath],
            transport: 'claude_stream_json',
            env: {},
          },
        },
      })
    );

    let client: DashboardRemoteClient | undefined;
    try {
      const started = await startTestServer(configPath);
      client = new DashboardRemoteClient(started.url, started.token);
      await client.connect();
      const created = await client.createSession('emitter', 'emit', dir);

      let initialSnapshot = await client.getSessionLogs(created.sessionId);
      const initialDeadline = Date.now() + 5000;
      while (
        initialSnapshot.events.at(-1)?.content !== 'initial-511' &&
        Date.now() < initialDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        initialSnapshot = await client.getSessionLogs(created.sessionId);
      }
      expect(initialSnapshot.events).toHaveLength(512);
      expect(initialSnapshot.events.at(-1)?.content).toBe('initial-511');
      expect(initialSnapshot.totalEvents).toBe(512);

      // The retained window is full. This is the point where the old offset-based
      // eventCount pinned at 512 and stopped changing, so a poller watching it concluded
      // the agent had gone quiet exactly when it was still producing output.
      const statusAtCap = await client.getSessionStatus(created.sessionId);
      expect(statusAtCap.eventCount).toBe(512);

      fs.writeFileSync(triggerPath, 'continue');
      let status = await client.getSessionStatus(created.sessionId);
      const completionDeadline = Date.now() + 5000;
      while (status.status === 'running' && Date.now() < completionDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        status = await client.getSessionStatus(created.sessionId);
      }
      expect(status.status).toBe('completed');

      // 16 more events arrived after the cap: the monotonic total must reflect them.
      expect(status.eventCount).toBe(528);
      expect(status.eventCount).toBeGreaterThan(statusAtCap.eventCount);
      expect(status.droppedEventCount).toBe(16);

      const rolledSnapshot = await client.getSessionLogs(created.sessionId);
      expect(rolledSnapshot.events).toHaveLength(512);
      expect(rolledSnapshot.events[0]?.content).toBe('initial-16');
      expect(rolledSnapshot.events.at(-1)?.content).toBe('rollover-527');
      expect(rolledSnapshot.oldestCursor).toBe(16);
      expect(rolledSnapshot.droppedCount).toBe(16);

      // A cursor handed back earlier still resolves to only the events after it.
      const incremental = await client.getSessionLogs(created.sessionId, initialSnapshot.nextCursor);
      expect(incremental.events).toHaveLength(16);
      expect(incremental.events[0]?.content).toBe('rollover-512');
    } finally {
      try {
        await client?.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
