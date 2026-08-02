import { DEFAULT_SSE_PORT, type AgentMCPConfig } from '../../config/schema.js';

export interface DashboardServerResolution {
  url: string;
}

/** Explicit --connect wins; otherwise the dashboard owns/discovers loopback on the loaded port. */
export function resolveDashboardServerUrl(
  config: AgentMCPConfig,
  connectFlag: string | undefined
): DashboardServerResolution {
  if (connectFlag) return { url: connectFlag };
  const port = config.port ?? DEFAULT_SSE_PORT;
  return { url: `http://127.0.0.1:${port}/sse` };
}

export function formatDashboardConnectionFailure(serverUrl: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    `Could not connect to the agent-rack server at ${serverUrl}.`,
    '--connect is external-only, so agent-rack did not start or stop that server.',
    `Connection error: ${detail}`,
  ].join('\n');
}

export function formatDashboardListenFailure(port: number, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    `Cannot auto-start the dashboard server on 127.0.0.1:${port}.`,
    'Another process may already own the port but is not a compatible agent-rack SSE server.',
    `Listen error: ${detail}`,
  ].join('\n');
}
