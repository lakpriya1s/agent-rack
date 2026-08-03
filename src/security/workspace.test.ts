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
    const result = sanitizeEnvironment({ customEnv: { MY_VAR: '123' }, sanitize: true });
    expect(result['MY_VAR']).toBe('123');
    expect(result['PAGER']).toBe('cat');
  });

  it('drops credential-shaped variables the old denylist missed', () => {
    process.env.AGENT_RACK_TEST_OPENAI_API_KEY = 'sk-test';
    process.env.GITHUB_TOKEN = 'ghp-test';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-test';
    try {
      const result = sanitizeEnvironment({ sanitize: true });
      expect(result['AGENT_RACK_TEST_OPENAI_API_KEY']).toBeUndefined();
      expect(result['GITHUB_TOKEN']).toBeUndefined();
      expect(result['AWS_ACCESS_KEY_ID']).toBeUndefined();
    } finally {
      delete process.env.AGENT_RACK_TEST_OPENAI_API_KEY;
      delete process.env.GITHUB_TOKEN;
      delete process.env.AWS_ACCESS_KEY_ID;
    }
  });

  it('inheritEnv acts as an allowlist that excludes everything unnamed', () => {
    process.env.AGENT_RACK_TEST_WANTED = 'yes';
    process.env.AGENT_RACK_TEST_UNWANTED = 'no';
    try {
      const result = sanitizeEnvironment({ inheritEnv: ['AGENT_RACK_TEST_WANTED'] });
      expect(result['AGENT_RACK_TEST_WANTED']).toBe('yes');
      expect(result['AGENT_RACK_TEST_UNWANTED']).toBeUndefined();
      // The baseline a spawned CLI needs to run at all is always inherited.
      expect(result['PATH']).toBe(process.env.PATH);
    } finally {
      delete process.env.AGENT_RACK_TEST_WANTED;
      delete process.env.AGENT_RACK_TEST_UNWANTED;
    }
  });

  it('allowlist wins over a credential that would pass the denylist', () => {
    process.env.AGENT_RACK_TEST_PLAIN = 'visible';
    try {
      const result = sanitizeEnvironment({ inheritEnv: [] });
      expect(result['AGENT_RACK_TEST_PLAIN']).toBeUndefined();
    } finally {
      delete process.env.AGENT_RACK_TEST_PLAIN;
    }
  });
});
