import { describe, it, expect } from 'vitest';
import { startDashboard } from './dashboard/index.js';

describe('CLI Dashboard Module', () => {
  it('exports startDashboard function', () => {
    expect(typeof startDashboard).toBe('function');
  });
});
