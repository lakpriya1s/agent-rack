import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type http from 'http';
import { startAgentMCPServer } from '../../server.js';
import { DashboardRemoteClient } from './remoteClient.js';

let runningServer: http.Server | undefined;

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
  return `http://localhost:${port}/sse`;
}

describe('DashboardRemoteClient', () => {
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
      const url = await startTestServer(configPath);
      client = new DashboardRemoteClient(url);
      await client.connect();

      const created = await client.createSession('echoer', 'hello', dir, 'task');
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
      expect(logs.some((e) => e.content.includes('pong'))).toBe(true);
    } finally {
      try {
        await client?.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
