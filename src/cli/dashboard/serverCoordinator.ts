import type { AgentMCPConfig } from '../../config/schema.js';
import { fingerprintAgentMCPConfig } from '../../config/fingerprint.js';
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
  configAuthority: 'local' | 'external';
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

class IncompatibleDashboardServerError extends Error {}

async function connectClient(
  url: string,
  createClient: DashboardCoordinatorDependencies['createClient'],
  timeoutMs: number
): Promise<{
  client: DashboardRemoteClient;
  configFingerprint: string;
}> {
  const client = createClient(url);
  let timeout: NodeJS.Timeout | undefined;
  let mcpConnected = false;
  try {
    const identity = await Promise.race([
      (async () => {
        await client.connect();
        mcpConnected = true;
        const validatedIdentity = await client.validateDashboardServer();
        await client.listSessions();
        return validatedIdentity;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Connection probe timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    return { client, configFingerprint: identity.configFingerprint };
  } catch (error) {
    await client.close().catch(() => undefined);
    if (mcpConnected) {
      throw new IncompatibleDashboardServerError(
        error instanceof Error ? error.message : String(error)
      );
    }
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
      const { client } = await connectClient(
        resolution.url,
        deps.createClient,
        deps.probeTimeoutMs
      );
      return {
        url: resolution.url,
        mode: 'existing',
        configAuthority: 'external',
        client,
        close: () => client.close(),
      };
    } catch (error) {
      throw new Error(formatDashboardConnectionFailure(resolution.url, error));
    }
  }

  const localFingerprint = fingerprintAgentMCPConfig(config);
  try {
    const connected = await connectClient(
      resolution.url,
      deps.createClient,
      deps.probeTimeoutMs
    );
    if (connected.configFingerprint !== localFingerprint) {
      await connected.client.close().catch(() => undefined);
      throw new IncompatibleDashboardServerError(
        'The server uses a different agent-rack configuration.'
      );
    }
    return {
      url: resolution.url,
      mode: 'existing',
      configAuthority: 'local',
      client: connected.client,
      close: () => connected.client.close(),
    };
  } catch (error) {
    if (error instanceof IncompatibleDashboardServerError) {
      throw new Error(
        `The server already listening at ${resolution.url} uses a different agent-rack configuration or lacks required dashboard tools. Stop that server, or use --connect intentionally to treat its configuration as external. ${error.message}`
      );
    }
    // Nothing reachable is an MCP server, so this dashboard owns the server it starts below.
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
    const connected = await connectClient(
      ownedServer.url,
      deps.createClient,
      deps.probeTimeoutMs
    );
    if (connected.configFingerprint !== localFingerprint) {
      throw new Error('Auto-started server returned an unexpected configuration identity.');
    }
    client = connected.client;
  } catch (error) {
    await ownedServer.close().catch(() => undefined);
    throw new Error(`The auto-started dashboard server could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }

  let closePromise: Promise<void> | undefined;
  return {
    url: ownedServer.url,
    mode: 'auto-started',
    configAuthority: 'local',
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
