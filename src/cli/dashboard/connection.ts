import { DEFAULT_SSE_PORT, type AgentMCPConfig } from '../../config/schema.js';

export type DashboardServerResolution = { url: string } | { error: string };

const DEFAULT_DASHBOARD_URL = `http://localhost:${DEFAULT_SSE_PORT}/sse`;

export function formatSharedDashboardHelp(
  serverUrl: string = DEFAULT_DASHBOARD_URL
): string {
  let startInstruction = `Ensure the shared MCP server at ${serverUrl} is running.`;

  try {
    const parsed = new URL(serverUrl);
    if (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    ) {
      const port = parsed.port || String(DEFAULT_SSE_PORT);
      startInstruction = [
        'Terminal 1:',
        `  npx agent-rack@latest start --transport sse --port ${port}`,
      ].join('\n');
    }
  } catch {
    // The MCP client reports malformed URLs during connection; preserve the value in guidance.
  }

  return [
    'The dashboard is optional and requires a shared SSE server.',
    '',
    startInstruction,
    '',
    'Terminal 2:',
    `  npx agent-rack@latest dashboard --connect ${serverUrl}`,
    '',
    'Only sessions created through that SSE server—or by MCP clients configured to its URL—appear in the dashboard.',
    '',
    'For sessions in your normal private stdio setup, ask Claude Code to use',
    'agent_session_list, agent_session_status, or agent_session_logs.',
  ].join('\n');
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
