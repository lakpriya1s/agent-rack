import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

export type TargetClient = 'claude' | 'cursor' | 'antigravity' | 'agy' | 'codex' | 'opencode';

export const KNOWN_TARGETS: Record<string, { label: string; projectSkillsDir: string; userSkillsDir: string }> = {
  claude: {
    label: 'Claude Code CLI',
    projectSkillsDir: path.join('.claude', 'skills'),
    userSkillsDir: path.join(os.homedir(), '.claude', 'skills'),
  },
  cursor: {
    label: 'Cursor',
    projectSkillsDir: path.join('.cursor', 'skills'),
    userSkillsDir: path.join(os.homedir(), '.cursor', 'skills'),
  },
  antigravity: {
    label: 'Antigravity',
    projectSkillsDir: path.join('.gemini', 'skills'),
    userSkillsDir: path.join(os.homedir(), '.gemini', 'config', 'skills'),
  },
  agy: {
    label: 'Antigravity',
    projectSkillsDir: path.join('.gemini', 'skills'),
    userSkillsDir: path.join(os.homedir(), '.gemini', 'config', 'skills'),
  },
  codex: {
    label: 'Codex CLI',
    projectSkillsDir: path.join('.agents', 'skills'),
    userSkillsDir: path.join(os.homedir(), '.codex', 'skills'),
  },
  opencode: {
    label: 'OpenCode',
    projectSkillsDir: path.join('.opencode', 'skills'),
    userSkillsDir: path.join(os.homedir(), '.config', 'opencode', 'skills'),
  },
};

export function getPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

export interface ResolveSkillsDirOptions {
  target?: string;
  scope?: 'user' | 'project';
  projectBase?: string;
}

/**
 * Resolves the destination skills directory based on target client, scope, and project root.
 */
export function resolveSkillsDir(options: ResolveSkillsDirOptions): string {
  const scope = options.scope || 'project';
  const projectBase = path.resolve(options.projectBase || process.cwd());
  const target = options.target?.toLowerCase();

  if (target && KNOWN_TARGETS[target]) {
    const config = KNOWN_TARGETS[target];
    if (scope === 'user') {
      return config.userSkillsDir;
    }
    return path.join(projectBase, config.projectSkillsDir);
  }

  if (target) {
    throw new Error(
      `Unknown target client '${target}'. Supported targets: ${Object.keys(KNOWN_TARGETS).join(', ')}`
    );
  }

  // Default when no target is specified but projectBase is given
  return path.join(projectBase, '.claude', 'skills');
}

export interface CopySkillsOptions {
  destSkillsDir: string;
  skillName?: string;
  prefix?: string;
  packageRootPath?: string;
}

/**
 * Copies agent-rack skills into the destination skills directory.
 * Returns an array of copied skill names.
 */
export function copySkills(options: CopySkillsOptions): string[] {
  const pkgRoot = options.packageRootPath || getPackageRoot();
  const sourceRoot = path.join(pkgRoot, 'plugins', 'agent-rack', 'skills');
  const prefix = options.prefix !== undefined ? options.prefix : 'agent-rack-';

  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`Source skills directory not found at: ${sourceRoot}`);
  }

  const availableSkills = fs
    .readdirSync(sourceRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  if (availableSkills.length === 0) {
    return [];
  }

  let skillsToCopy = availableSkills;
  if (options.skillName && options.skillName !== 'all') {
    const requested = options.skillName.toLowerCase();
    const match = availableSkills.find(
      (s) => s.toLowerCase() === requested || `agent-rack-${s.toLowerCase()}` === requested
    );
    if (!match) {
      throw new Error(
        `Skill '${options.skillName}' not found. Available skills: ${availableSkills.join(', ')}`
      );
    }
    skillsToCopy = [match];
  }

  const copiedSkills: string[] = [];

  for (const name of skillsToCopy) {
    const sourceDir = path.join(sourceRoot, name);
    const destName = name.startsWith(prefix) ? name : `${prefix}${name}`;
    const destDir = path.join(options.destSkillsDir, destName);

    fs.mkdirSync(destDir, { recursive: true });

    // Recursively copy contents of the skill folder
    fs.cpSync(sourceDir, destDir, { recursive: true });
    copiedSkills.push(destName);
  }

  return copiedSkills;
}

export interface CpCommandOptions {
  target?: string;
  scope?: 'user' | 'project';
  skill?: string;
  prefix?: string;
}

/**
 * Executes the `cp` command logic for copying skills to projects or agents.
 */
export function handleCpCommand(destArg?: string, options: CpCommandOptions = {}): void {
  const scope = options.scope || 'project';
  const prefix = options.prefix !== undefined ? options.prefix : 'agent-rack-';
  const skillName = options.skill;

  let destinations: Array<{ label: string; dir: string }> = [];

  // Check if destArg itself is a known target keyword (e.g., `agent-rack cp cursor`)
  const destAsTarget = destArg?.toLowerCase();

  if (destAsTarget && KNOWN_TARGETS[destAsTarget]) {
    const targetConfig = KNOWN_TARGETS[destAsTarget];
    const dir = resolveSkillsDir({ target: destAsTarget, scope });
    destinations.push({ label: targetConfig.label, dir });
  } else if (options.target) {
    const targetConfig = KNOWN_TARGETS[options.target.toLowerCase()];
    const projectBase = destArg ? path.resolve(destArg) : process.cwd();
    const dir = resolveSkillsDir({ target: options.target, scope, projectBase });
    destinations.push({ label: targetConfig ? targetConfig.label : options.target, dir });
  } else if (destArg) {
    const resolvedPath = path.resolve(destArg);
    // If destArg is a direct skills directory or custom folder path
    if (resolvedPath.endsWith('skills') || fs.existsSync(resolvedPath)) {
      const stats = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath) : null;
      if (stats && !stats.isDirectory()) {
        throw new Error(`Destination path '${destArg}' is not a directory.`);
      }
      // If it looks like a project root with client folders, copy to detected client skills dirs
      const projectHits = Object.entries(KNOWN_TARGETS).filter(([, cfg]) =>
        fs.existsSync(path.join(resolvedPath, cfg.projectSkillsDir.split(path.sep)[0]))
      );

      if (projectHits.length > 0) {
        for (const [tKey, cfg] of projectHits) {
          destinations.push({
            label: cfg.label,
            dir: path.join(resolvedPath, cfg.projectSkillsDir),
          });
        }
      } else {
        // Direct custom directory path
        destinations.push({ label: resolvedPath, dir: resolvedPath });
      }
    } else {
      destinations.push({ label: resolvedPath, dir: resolvedPath });
    }
  } else {
    // No target or destArg specified: autodetect clients in current working directory
    const cwd = process.cwd();
    const detected = Object.entries(KNOWN_TARGETS).filter(([, cfg]) =>
      fs.existsSync(path.join(cwd, cfg.projectSkillsDir.split(path.sep)[0]))
    );

    if (detected.length > 0) {
      for (const [, cfg] of detected) {
        const dir = scope === 'user' ? cfg.userSkillsDir : path.join(cwd, cfg.projectSkillsDir);
        destinations.push({ label: cfg.label, dir });
      }
    } else {
      // Default fallback target (Claude)
      const dir = resolveSkillsDir({ target: 'claude', scope, projectBase: cwd });
      destinations.push({ label: KNOWN_TARGETS.claude.label, dir });
    }
  }

  for (const dest of destinations) {
    try {
      const copied = copySkills({
        destSkillsDir: dest.dir,
        skillName,
        prefix,
      });
      console.log(`✓ Copied ${copied.length} skill(s) into ${dest.label} at:\n  ${dest.dir}`);
      for (const s of copied) {
        console.log(`  - ${s}`);
      }
    } catch (err) {
      console.error(`✗ Failed to copy skills into ${dest.label}:`, err instanceof Error ? err.message : String(err));
    }
  }
}
