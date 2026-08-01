import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Root of the installed package (two levels up from this compiled file at `dist/cli/version.js`). */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

/** Reads the version straight from package.json so it can never drift from what's published. */
export function getPackageVersion(): string {
  const pkgPath = path.join(packageRoot(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}
