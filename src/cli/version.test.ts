import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPackageVersion } from './version.js';

describe('getPackageVersion', () => {
  it('matches the version field in package.json (not a stale hardcoded string)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    expect(getPackageVersion()).toBe(pkg.version);
  });
});
