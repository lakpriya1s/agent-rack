import { DEFAULT_SSE_PORT, type AgentMCPConfig } from '../../config/schema.js';
import { readLocalToken } from '../../security/auth.js';

export interface DashboardServerResolution {
  url: string;
  /** Bearer token for the resolved server, when one could be discovered locally. */
  token?: string;
}

/**
 * Explicit --connect wins; otherwise the dashboard owns/discovers loopback on the loaded port.
 *
 * The token is read from the runtime token file the server publishes (or `$AGENT_RACK_TOKEN`),
 * so the zero-config local flow still needs no secret handling by the user. A `--connect` URL
 * may carry its own token in the query string for a server whose file we cannot see.
 */
export function resolveDashboardServerUrl(
  config: AgentMCPConfig,
  connectFlag: string | undefined
): DashboardServerResolution {
  if (connectFlag) {
    const parsed = tryParseUrl(connectFlag);
    const inlineToken = parsed?.searchParams.get('token') ?? undefined;
    if (parsed && inlineToken) {
      parsed.searchParams.delete('token');
      return { url: parsed.toString(), token: inlineToken };
    }
    const port = parsed?.port ? Number(parsed.port) : undefined;
    return {
      url: connectFlag,
      token: process.env.AGENT_RACK_TOKEN ?? (port ? readLocalToken(port) : undefined),
    };
  }

  const port = config.port ?? DEFAULT_SSE_PORT;
  return { url: `http://127.0.0.1:${port}/sse`, token: readLocalToken(port) };
}

function tryParseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
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
