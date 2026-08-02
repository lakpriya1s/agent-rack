import React from 'react';
import { render } from 'ink';
import { loadConfig as loadAgentRackConfig } from '../../config/loader.js';
import { DashboardApp } from './App.js';
import { dashboardTTYError } from './tty.js';
import { getPackageVersion } from '../version.js';
import {
  coordinateDashboardServer,
  type DashboardConnection,
} from './serverCoordinator.js';
import {
  ensureClaudeDashboardRegistration,
  type ClaudeSetupResult,
} from './claudeSetup.js';

export interface DashboardRenderProps {
  config: ReturnType<typeof loadAgentRackConfig>['config'];
  configPath?: string;
  version: string;
  remoteClient: DashboardConnection['client'];
  serverMode: DashboardConnection['mode'];
  configAuthority: DashboardConnection['configAuthority'];
  launchMetadata: DashboardConnection['launchMetadata'];
  startupMessage?: string;
}

export interface DashboardStartupDependencies {
  stdin: { isTTY?: boolean };
  loadConfig: typeof loadAgentRackConfig;
  coordinate: typeof coordinateDashboardServer;
  setupClaude(
    url: string,
    configAuthority: DashboardConnection['configAuthority']
  ): Promise<ClaudeSetupResult>;
  renderDashboard(props: DashboardRenderProps): Promise<void>;
  reportError(message: string): void;
  setExitCode(code: number): void;
}

export function isDashboardSetupAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const defaultDependencies: DashboardStartupDependencies = {
  stdin: process.stdin,
  loadConfig: loadAgentRackConfig,
  coordinate: coordinateDashboardServer,
  setupClaude: (url, configAuthority) =>
    ensureClaudeDashboardRegistration(url, {
      externalConnection: configAuthority === 'external',
    }),
  renderDashboard: async (props) => {
    const { waitUntilExit } = render(<DashboardApp {...props} />, { exitOnCtrlC: false });
    await waitUntilExit();
  },
  reportError: (message) => console.error(message),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export async function startDashboard(
  customConfigPath?: string,
  connectFlag?: string,
  dependencies: Partial<DashboardStartupDependencies> = {}
): Promise<void> {
  const deps = { ...defaultDependencies, ...dependencies };

  // Ink requires a real terminal; this guard must precede config loading and every side effect.
  const ttyError = dashboardTTYError(deps.stdin);
  if (ttyError) {
    deps.reportError(ttyError);
    deps.setExitCode(1);
    return;
  }

  const { config, filePath } = deps.loadConfig(customConfigPath);
  let connection: DashboardConnection;
  try {
    connection = await deps.coordinate(config, connectFlag);
  } catch (error) {
    deps.reportError(error instanceof Error ? error.message : String(error));
    deps.setExitCode(1);
    return;
  }

  try {
    let setup: ClaudeSetupResult;
    try {
      setup = await deps.setupClaude(connection.url, connection.configAuthority);
    } catch (error) {
      if (isDashboardSetupAbort(error)) return;
      setup = {
        warning: `Claude Code MCP setup failed: ${error instanceof Error ? error.message : String(error)}. The dashboard will still open.`,
      };
    }

    await deps.renderDashboard({
      config,
      configPath: filePath || undefined,
      version: getPackageVersion(),
      remoteClient: connection.client,
      serverMode: connection.mode,
      configAuthority: connection.configAuthority,
      launchMetadata: connection.launchMetadata,
      startupMessage: setup.warning ?? setup.notice,
    });
  } finally {
    await connection.close();
  }
}
