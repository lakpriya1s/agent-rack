import { describe, it, expect } from 'vitest';
import path from 'path';
import { validateWorkspacePath, SecurityError } from './workspace.js';
import { sanitizeEnvironment } from './env.js';

describe('Workspace Security Guard', () => {
  const allowed = [path.resolve('/tmp/test-workspace')];

  it('allows paths inside allowedWorkspaces', () => {
    const result = validateWorkspacePath('/tmp/test-workspace/subfolder', allowed);
    expect(result.valid).toBe(true);
  });

  it('rejects paths outside allowedWorkspaces', () => {
    expect(() => validateWorkspacePath('/etc/passwd', allowed)).toThrow(SecurityError);
  });

  it('prevents path traversal bypasses', () => {
    expect(() => validateWorkspacePath('/tmp/test-workspace/../../etc', allowed)).toThrow(SecurityError);
  });
});

describe('Environment Sanitizer', () => {
  it('passes custom env vars and sets defaults', () => {
    const result = sanitizeEnvironment({ MY_VAR: '123' }, true);
    expect(result['MY_VAR']).toBe('123');
    expect(result['PAGER']).toBe('cat');
  });
});
