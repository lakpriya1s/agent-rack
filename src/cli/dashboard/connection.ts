import type { AgentMCPConfig } from '../../config/schema.js';

export type DashboardServerResolution = { url: string } | { error: string };

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
    return {
      error: [
        'agent-rack dashboard needs a shared server to connect to, but the loaded config has',
        "transport: 'stdio'.",
        'Set "transport": "sse" and a "port" in agent-rack.config.json, start the server with',
        '`agent-rack start`, then run the dashboard again (or pass --connect <url> explicitly).',
      ].join('\n'),
    };
  }

  const port = config.port ?? 8987;
  return { url: `http://localhost:${port}/sse` };
}
