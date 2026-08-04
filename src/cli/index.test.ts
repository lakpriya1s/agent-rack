import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { resolveConfigInitTarget } from './index.js';

describe('resolveConfigInitTarget', () => {
  it('plain `config init` (no flags) writes to the given path, scoped to cwd', () => {
    const target = resolveConfigInitTarget({ path: './agent-rack.config.json', global: undefined }, 'default');

    expect(target).toEqual({
      targetPath: './agent-rack.config.json',
      scopeDir: process.cwd(),
      isGlobal: false,
    });
  });

  it('--global alone writes to the resolved homedir path, scoped to the home directory', () => {
    const target = resolveConfigInitTarget({ path: './agent-rack.config.json', global: true }, 'default');

    expect(target).toEqual({
      targetPath: path.resolve(os.homedir(), '.config', 'agent-rack', 'config.json'),
      scopeDir: os.homedir(),
      isGlobal: true,
    });
  });

  it('--global with an explicit --path throws', () => {
    expect(() => resolveConfigInitTarget({ path: './custom.json', global: true }, 'cli')).toThrow(
      'Cannot combine --global with an explicit --path.'
    );
  });

  it('--global with --path redundantly set to the default still throws, since the source is cli', () => {
    expect(() =>
      resolveConfigInitTarget({ path: './agent-rack.config.json', global: true }, 'cli')
    ).toThrow('Cannot combine --global with an explicit --path.');
  });

  it('an explicit --path without --global is unaffected', () => {
    const target = resolveConfigInitTarget({ path: './custom.json', global: undefined }, 'cli');

    expect(target).toEqual({
      targetPath: './custom.json',
      scopeDir: process.cwd(),
      isGlobal: false,
    });
  });
});
