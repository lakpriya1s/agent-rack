import { describe, it, expect } from 'vitest';
import { dashboardTTYError } from './tty.js';

describe('dashboardTTYError', () => {
  it('returns a friendly error message when stdin is not a TTY', () => {
    const message = dashboardTTYError({ isTTY: false });
    expect(message).toContain('interactive terminal');
    expect(message).toContain('agent-rack dashboard');
  });

  it('returns a friendly error message when isTTY is undefined (piped/redirected stdin)', () => {
    const message = dashboardTTYError({ isTTY: undefined });
    expect(message).toContain('interactive terminal');
  });

  it('returns null when stdin is a real TTY', () => {
    expect(dashboardTTYError({ isTTY: true })).toBeNull();
  });
});
