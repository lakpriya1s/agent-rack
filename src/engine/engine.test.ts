import { describe, it, expect } from 'vitest';
import { EventRingBuffer } from './buffer.js';
import { getDefaultConfig } from '../config/loader.js';
import { SessionManager } from './session.js';

describe('EventRingBuffer', () => {
  it('respects capacity limit', () => {
    const buffer = new EventRingBuffer(3);
    buffer.push({ type: 'text', content: '1', timestamp: 1 });
    buffer.push({ type: 'text', content: '2', timestamp: 2 });
    buffer.push({ type: 'text', content: '3', timestamp: 3 });
    buffer.push({ type: 'text', content: '4', timestamp: 4 });

    expect(buffer.size()).toBe(3);
    const events = buffer.getAll();
    expect(events[0].content).toBe('2');
    expect(events[2].content).toBe('4');
  });
});

describe('SessionManager', () => {
  it('instantiates and enforces max concurrent limit', () => {
    const config = getDefaultConfig();
    config.security.maxConcurrentSessions = 1;
    const manager = new SessionManager(config);

    // Mock echo command for testing
    config.agents['test_echo'] = {
      name: 'Echo Test',
      command: 'echo',
      args: [],
      transport: 'pty_interactive',
      env: {},
    };

    const session1 = manager.createSession('test_echo', 'hello');
    expect(session1.status).toBe('running');

    expect(() => manager.createSession('test_echo', 'world')).toThrow(/Maximum concurrent sessions limit/);
  });
});
