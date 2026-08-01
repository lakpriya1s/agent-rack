import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../../config/loader.js';
import { DashboardApp } from './App.js';
import { dashboardTTYError } from './tty.js';
import { getPackageVersion } from '../version.js';

export async function startDashboard(customConfigPath?: string): Promise<void> {
  const ttyError = dashboardTTYError(process.stdin);
  if (ttyError) {
    console.error(ttyError);
    process.exitCode = 1;
    return;
  }

  const { config, filePath } = loadConfig(customConfigPath);
  const { waitUntilExit } = render(
    <DashboardApp config={config} configPath={filePath || undefined} version={getPackageVersion()} />
  );
  await waitUntilExit();
}
