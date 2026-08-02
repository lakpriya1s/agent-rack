import type { AgentMCPConfig } from '../../config/schema.js';
import {
  createServerContextFromConfig,
  startSSEServer,
  type AgentMCPHTTPServer,
} from '../../server.js';
import {
  formatDashboardConnectionFailure,
  formatDashboardListenFailure,
  resolveDashboardServerUrl,
} from './connection.js';
import { DashboardRemoteClient } from './remoteClient.js';

export type DashboardServerMode = 'auto-started' | 'existing';

export interface DashboardConnection {
  url: string;
  mode: DashboardServerMode;
  client: DashboardRemoteClient;
  close(): Promise<void>;
}

export interface DashboardCoordinatorDependencies {
  createClient(url: string): DashboardRemoteClient;
  startServer(config: AgentMCPConfig, port: number): Promise<AgentMCPHTTPServer>;
  probeTimeoutMs: number;
}

const defaults: DashboardCoordinatorDependencies = {
  createClient: (url) => new DashboardRemoteClient(url),
  startServer: (config, port) =>
    startSSEServer(createServerContextFromConfig(config), port),
  probeTimeoutMs: 2000,
};

async function connectClient(
  url: string,
  createClient: DashboardCoordinatorDependencies['createClient'],
  timeoutMs: number
): Promise<DashboardRemoteClient> {
  const client = createClient(url);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        await client.listSessions();
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Connection probe timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function coordinateDashboardServer(
  config: AgentMCPConfig,
  connectUrl?: string,
  dependencies: Partial<DashboardCoordinatorDependencies> = {}
): Promise<DashboardConnection> {
  const deps = { ...defaults, ...dependencies };
  const resolution = resolveDashboardServerUrl(config, connectUrl);

  if (connectUrl) {
    try {
      const client = await connectClient(resolution.url, deps.createClient, deps.probeTimeoutMs);
      return {
        url: resolution.url,
        mode: 'existing',
        client,
        close: () => client.close(),
      };
    } catch (error) {
      throw new Error(formatDashboardConnectionFailure(resolution.url, error));
    }
  }

  try {
    const client = await connectClient(resolution.url, deps.createClient, deps.probeTimeoutMs);
    return {
      url: resolution.url,
      mode: 'existing',
      client,
      close: () => client.close(),
    };
  } catch {
    // Nothing compatible is reachable, so this dashboard owns the server it starts below.
  }

  const port = config.port ?? 8987;
  let ownedServer: AgentMCPHTTPServer;
  try {
    ownedServer = await deps.startServer(config, port);
  } catch (error) {
    throw new Error(formatDashboardListenFailure(port, error));
  }

  let client: DashboardRemoteClient | undefined;
  try {
    client = await connectClient(ownedServer.url, deps.createClient, deps.probeTimeoutMs);
  } catch (error) {
    await ownedServer.close().catch(() => undefined);
    throw new Error(`The auto-started dashboard server could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }

  let closePromise: Promise<void> | undefined;
  return {
    url: ownedServer.url,
    mode: 'auto-started',
    client,
    close: () => {
      closePromise ??= (async () => {
        await client.close().catch(() => undefined);
        await ownedServer.close();
      })();
      return closePromise;
    },
  };
}
