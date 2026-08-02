import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../../config/loader.js';
import { DashboardApp } from './App.js';
import { dashboardTTYError } from './tty.js';
import { getPackageVersion } from '../version.js';
import { resolveDashboardServerUrl } from './connection.js';
import { DashboardRemoteClient } from './remoteClient.js';

export async function startDashboard(customConfigPath?: string, connectFlag?: string): Promise<void> {
  const ttyError = dashboardTTYError(process.stdin);
  if (ttyError) {
    console.error(ttyError);
    process.exitCode = 1;
    return;
  }

  const { config, filePath } = loadConfig(customConfigPath);
  const resolution = resolveDashboardServerUrl(config, connectFlag);
  if ('error' in resolution) {
    console.error(resolution.error);
    process.exitCode = 1;
    return;
  }

  const remoteClient = new DashboardRemoteClient(resolution.url);
  try {
    await remoteClient.connect();
    await remoteClient.listSessions();
  } catch (err) {
    console.error(
      `Could not reach the agent-rack server at ${resolution.url}.\n` +
        `Start it first with: agent-rack start --transport sse --port <port>\n` +
        `(${err instanceof Error ? err.message : String(err)})`
    );
    process.exitCode = 1;
    await remoteClient.close();
    return;
  }

  try {
    const { waitUntilExit } = render(
      <DashboardApp
        config={config}
        configPath={filePath || undefined}
        version={getPackageVersion()}
        remoteClient={remoteClient}
      />
    );
    await waitUntilExit();
  } finally {
    await remoteClient.close();
  }
}
