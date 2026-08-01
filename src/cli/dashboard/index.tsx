import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../../config/loader.js';
import { DashboardApp } from './App.js';

export async function startDashboard(customConfigPath?: string): Promise<void> {
  const { config, filePath } = loadConfig(customConfigPath);
  const { waitUntilExit } = render(<DashboardApp config={config} configPath={filePath || undefined} />);
  await waitUntilExit();
}
