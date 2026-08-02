import { DEFAULT_SSE_PORT, type AgentMCPConfig } from '../../config/schema.js';

export type DashboardServerResolution = { url: string } | { error: string };

const DEFAULT_DASHBOARD_URL = `http://localhost:${DEFAULT_SSE_PORT}/sse`;
const SHELL_SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

function quoteShellArgument(value: string): string {
  if (SHELL_SAFE_ARGUMENT.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getLocallyStartablePort(serverUrl: string): string | undefined {
  try {
    const parsed = new URL(serverUrl);
    if (
      parsed.protocol !== 'http:' ||
      (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') ||
      parsed.pathname !== '/sse'
    ) {
      return undefined;
    }

    const port = parsed.port || '80';
    const portNumber = Number(port);
    return Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
      ? port
      : undefined;
  } catch {
    return undefined;
  }
}

export function formatSharedDashboardHelp(
  serverUrl: string = DEFAULT_DASHBOARD_URL
): string {
  const localPort = getLocallyStartablePort(serverUrl);
  const startInstruction = localPort
    ? ['Terminal 1:', `  npx agent-rack@latest start --transport sse --port ${localPort}`].join(
        '\n'
      )
    : `Ensure the shared MCP server at ${serverUrl} is running.`;

  return [
    'The dashboard is optional and requires a shared SSE server.',
    '',
    startInstruction,
    '',
    'Terminal 2:',
    `  npx agent-rack@latest dashboard --connect ${quoteShellArgument(serverUrl)}`,
    '',
    'Only sessions created through that SSE server—or by MCP clients configured to its URL—appear in the dashboard.',
    '',
    'For sessions in your normal private stdio setup, ask Claude Code to use',
    'agent_session_list, agent_session_status, or agent_session_logs.',
  ].join('\n');
}

export function formatDashboardConnectionFailure(serverUrl: string, error: unknown): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return (
    `Could not reach the agent-rack server at ${serverUrl}.\n\n` +
    `${formatSharedDashboardHelp(serverUrl)}\n\n` +
    `Connection error: ${errorMessage}`
  );
}

/**
 * The dashboard is always a client of a shared server (see the shared-dashboard-sessions
 * design) — it never falls back to a private local SessionManager. An explicit `--connect`
 * flag always wins; otherwise the URL is derived from the same config used everywhere else, so
 * `agent-rack start` and `agent-rack dashboard` agree on it without extra flags in the common
 * case.
 */
export function resolveDashboardServerUrl(
  config: AgentMCPConfig,
  connectFlag: string | undefined
): DashboardServerResolution {
  if (connectFlag) {
    return { url: connectFlag };
  }

  if (config.transport !== 'sse') {
    return { error: formatSharedDashboardHelp() };
  }

  const port = config.port ?? DEFAULT_SSE_PORT;
  return { url: `http://localhost:${port}/sse` };
}
