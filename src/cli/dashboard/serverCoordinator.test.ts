import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../config/loader.js';
import { createServerContextFromConfig, startSSEServer, type AgentMCPHTTPServer } from '../../server.js';
import { DashboardRemoteClient } from './remoteClient.js';
import { coordinateDashboardServer } from './serverCoordinator.js';

const ownedHandles: AgentMCPHTTPServer[] = [];
const httpServers: http.Server[] = [];

afterEach(async () => {
  await Promise.allSettled(ownedHandles.splice(0).map((handle) => handle.close()));
  await Promise.allSettled(
    httpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function listen(server: http.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

describe('coordinateDashboardServer', () => {
  it('auto-starts from the exact loaded config and releases the port on close', async () => {
    const config = getDefaultConfig('/tmp/agent-rack-dashboard-sentinel');
    config.port = 0;
    let receivedConfig: typeof config | undefined;

    const connection = await coordinateDashboardServer(config, undefined, {
      startServer: async (loadedConfig, port) => {
        receivedConfig = loadedConfig;
        const handle = await startSSEServer(createServerContextFromConfig(loadedConfig), port);
        ownedHandles.push(handle);
        return handle;
      },
    });

    expect(receivedConfig).toBe(config);
    expect(connection.mode).toBe('auto-started');
    expect(connection.configAuthority).toBe('local');
    expect(await connection.client.listSessions()).toEqual([]);
    const port = new URL(connection.url).port;

    await connection.close();
    ownedHandles.splice(0);

    const rebound = net.createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(Number(port), '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
  });

  it('connects to an existing server without closing it', async () => {
    const config = getDefaultConfig();
    const existing = await startSSEServer(createServerContextFromConfig(config), 0);
    ownedHandles.push(existing);
    config.port = Number(new URL(existing.url).port);

    const connection = await coordinateDashboardServer(config);
    expect(connection.mode).toBe('existing');
    expect(connection.configAuthority).toBe('local');
    await connection.close();

    const verifier = new DashboardRemoteClient(existing.url);
    try {
      await verifier.connect();
      expect(await verifier.listSessions()).toEqual([]);
    } finally {
      await verifier.close();
    }
  });

  it('rejects an implicit existing server with a different effective config', async () => {
    const serverConfig = getDefaultConfig('/tmp/project-a');
    const existing = await startSSEServer(createServerContextFromConfig(serverConfig), 0);
    ownedHandles.push(existing);

    const localConfig = getDefaultConfig('/tmp/project-b');
    localConfig.port = Number(new URL(existing.url).port);

    await expect(coordinateDashboardServer(localConfig)).rejects.toThrow(
      /different agent-rack configuration/
    );

    const verifier = new DashboardRemoteClient(existing.url);
    try {
      await verifier.connect();
      expect(await verifier.listSessions()).toEqual([]);
    } finally {
      await verifier.close();
    }
  });

  it('allows an explicit --connect to a distinct config but marks it external', async () => {
    const serverConfig = getDefaultConfig('/tmp/project-a');
    const existing = await startSSEServer(createServerContextFromConfig(serverConfig), 0);
    ownedHandles.push(existing);
    const localConfig = getDefaultConfig('/tmp/project-b');

    const connection = await coordinateDashboardServer(localConfig, existing.url);
    expect(connection.mode).toBe('existing');
    expect(connection.configAuthority).toBe('external');
    await connection.close();
  });

  it('never auto-starts for an explicit --connect URL', async () => {
    const startServer = vi.fn();
    const config = getDefaultConfig();

    await expect(
      coordinateDashboardServer(config, 'http://127.0.0.1:1/sse', { startServer })
    ).rejects.toThrow('--connect is external-only');
    expect(startServer).not.toHaveBeenCalled();
  });

  it('times out a hanging local probe and reports the occupied listen port promptly', async () => {
    const hanging = http.createServer(() => {
      // Accept the SSE probe but intentionally never send headers or a response.
    });
    httpServers.push(hanging);
    const port = await listen(hanging);
    const config = getDefaultConfig();
    config.port = port;

    await expect(
      Promise.race([
        coordinateDashboardServer(config, undefined, { probeTimeoutMs: 50 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('coordinator timed out')), 250)),
      ])
    ).rejects.toThrow(`Cannot auto-start the dashboard server on 127.0.0.1:${port}`);
  });

  it('rejects promptly with a friendly error when its port is occupied', async () => {
    const occupied = http.createServer((_req, res) => res.writeHead(404).end());
    httpServers.push(occupied);
    const port = await listen(occupied);
    const config = getDefaultConfig();
    config.port = port;

    await expect(
      Promise.race([
        coordinateDashboardServer(config),
        new Promise((_, reject) => setTimeout(() => reject(new Error('coordinator timed out')), 1000)),
      ])
    ).rejects.toThrow(`Cannot auto-start the dashboard server on 127.0.0.1:${port}`);
  });
});
