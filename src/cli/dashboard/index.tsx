import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../../config/loader.js';
import { DashboardApp } from './App.js';
import { dashboardTTYError } from './tty.js';
import { getPackageVersion } from '../version.js';
import { formatDashboardConnectionFailure, resolveDashboardServerUrl } from './connection.js';
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
    console.error(formatDashboardConnectionFailure(resolution.url, err));
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
        serverMode="existing"
      />
    );
    await waitUntilExit();
  } finally {
    await remoteClient.close();
  }
}
