import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../config/loader.js';
import type { DashboardConnection } from './serverCoordinator.js';
import { startDashboard, type DashboardStartupDependencies } from './index.js';

function connection(overrides: Partial<DashboardConnection> = {}): DashboardConnection {
  return {
    url: 'http://127.0.0.1:8987/sse',
    mode: 'auto-started',
    configAuthority: 'local',
    client: {} as DashboardConnection['client'],
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<DashboardStartupDependencies> = {}
): DashboardStartupDependencies {
  const config = getDefaultConfig('/tmp/dashboard-startup-test');
  return {
    stdin: { isTTY: true },
    loadConfig: () => ({ config, filePath: null }),
    coordinate: async () => connection(),
    setupClaude: async () => ({}),
    renderDashboard: async () => undefined,
    reportError: vi.fn(),
    setExitCode: vi.fn(),
    ...overrides,
  };
}

describe('startDashboard orchestration', () => {
  it('keeps the TTY guard before config loading or side effects', async () => {
    const loadConfig = vi.fn(() => ({ config: getDefaultConfig(), filePath: null }));
    const coordinate = vi.fn();
    const setupClaude = vi.fn();
    const deps = dependencies({
      stdin: { isTTY: false },
      loadConfig,
      coordinate,
      setupClaude,
    });

    await startDashboard(undefined, undefined, deps);

    expect(loadConfig).not.toHaveBeenCalled();
    expect(coordinate).not.toHaveBeenCalled();
    expect(setupClaude).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledWith(expect.stringContaining('interactive terminal'));
    expect(deps.setExitCode).toHaveBeenCalledWith(1);
  });

  it('coordinates, configures Claude after reachability, and renders the lifecycle state', async () => {
    const order: string[] = [];
    const shared = connection();
    const renderDashboard = vi.fn(async (props) => {
      order.push('render');
      expect(props.serverMode).toBe('auto-started');
      expect(props.startupMessage).toContain('Restart or reconnect');
    });
    const deps = dependencies({
      coordinate: async () => {
        order.push('coordinate');
        return shared;
      },
      setupClaude: async (_url, authority) => {
        order.push('setup');
        expect(authority).toBe('local');
        return { notice: 'Restart or reconnect once.' };
      },
      renderDashboard,
    });

    await startDashboard(undefined, undefined, deps);

    expect(order).toEqual(['coordinate', 'setup', 'render']);
    expect(shared.close).toHaveBeenCalledOnce();
  });

  it('identifies an explicit external connection before Claude setup', async () => {
    const setupClaude = vi.fn(async () => ({}));
    const deps = dependencies({
      coordinate: async () => connection({
        mode: 'existing',
        configAuthority: 'external',
      }),
      setupClaude,
    });

    await startDashboard(undefined, 'http://127.0.0.1:9999/sse', deps);

    expect(setupClaude).toHaveBeenCalledWith(
      'http://127.0.0.1:8987/sse',
      'external'
    );
  });

  it('opens with a warning and cleans up when setup fails', async () => {
    const shared = connection();
    const renderDashboard = vi.fn(async (props) => {
      expect(props.startupMessage).toContain('setup exploded');
    });
    const deps = dependencies({
      coordinate: async () => shared,
      setupClaude: async () => {
        throw new Error('setup exploded');
      },
      renderDashboard,
    });

    await startDashboard(undefined, undefined, deps);
    expect(renderDashboard).toHaveBeenCalledOnce();
    expect(shared.close).toHaveBeenCalledOnce();
  });

  it('cleans the connection when Ink rendering fails', async () => {
    const shared = connection();
    const deps = dependencies({
      coordinate: async () => shared,
      renderDashboard: async () => {
        throw new Error('render failed');
      },
    });

    await expect(startDashboard(undefined, undefined, deps)).rejects.toThrow('render failed');
    expect(shared.close).toHaveBeenCalledOnce();
  });
});
