import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPackageVersion } from './version.js';

/**
 * The npm package reached 0.6.1 while the Claude Code plugin and marketplace manifests were
 * still declaring 0.1.3 — five minor releases of drift, invisible because nothing compared
 * them. These assertions are the cheapest possible guard against that recurring.
 *
 * Plugin and marketplace versions are conceptually independent of the package version, but they
 * must match each other and are released together, so pinning all three to one value is the
 * only arrangement that cannot silently rot.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8'));
}

describe('release version synchronization', () => {
  const packageVersion = getPackageVersion();

  it('reports a real semver version from package.json', () => {
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('keeps the Claude Code plugin manifest at the package version', () => {
    const plugin = readJson('plugins/agent-rack/.claude-plugin/plugin.json');
    expect(plugin.version).toBe(packageVersion);
  });

  it('pins the plugin .mcp.json to this exact package version', () => {
    // An unpinned `npx -y agent-rack start` silently upgrades the plugin's server on any future
    // publish, so plugin behaviour could change without the plugin changing.
    const mcp = readJson('plugins/agent-rack/.mcp.json');
    expect(mcp['agent-rack'].args).toContain(`agent-rack@${packageVersion}`);
  });

  it('keeps the marketplace manifest and its plugin entry at the package version', () => {
    const marketplace = readJson('.claude-plugin/marketplace.json');
    expect(marketplace.metadata.version).toBe(packageVersion);

    const entry = marketplace.plugins.find((p: { name: string }) => p.name === 'agent-rack');
    expect(entry).toBeDefined();
    expect(entry.version).toBe(packageVersion);
  });
});
