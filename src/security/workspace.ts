import path from 'path';
import fs from 'fs';

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Validates whether targetPath is within one of the allowedWorkspaces.
 * Performs canonical path resolution to prevent symlink and relative path traversal bypasses.
 */
export function validateWorkspacePath(
  targetPath: string,
  allowedWorkspaces: string[]
): { valid: true; canonicalPath: string } {
  if (!targetPath) {
    throw new SecurityError('Workspace path cannot be empty.');
  }

  const resolvedTarget = path.resolve(targetPath);

  let canonicalTarget = resolvedTarget;
  if (fs.existsSync(resolvedTarget)) {
    try {
      canonicalTarget = fs.realpathSync(resolvedTarget);
    } catch {
      canonicalTarget = resolvedTarget;
    }
  }

  const isAllowed = allowedWorkspaces.some((allowed) => {
    const resolvedAllowed = path.resolve(allowed);
    let canonicalAllowed = resolvedAllowed;

    if (fs.existsSync(resolvedAllowed)) {
      try {
        canonicalAllowed = fs.realpathSync(resolvedAllowed);
      } catch {
        canonicalAllowed = resolvedAllowed;
      }
    }

    // Check if target matches allowed directory or is a subdirectory of allowed directory
    const relative = path.relative(canonicalAllowed, canonicalTarget);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });

  if (!isAllowed) {
    throw new SecurityError(
      `Workspace path '${targetPath}' [resolved: '${canonicalTarget}'] is not within allowedWorkspaces: [${allowedWorkspaces.join(
        ', '
      )}]`
    );
  }

  return { valid: true, canonicalPath: canonicalTarget };
}
