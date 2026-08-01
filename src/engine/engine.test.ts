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

async function waitForSessionCompletion(manager: SessionManager, sessionId: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = manager.getSession(sessionId);
    if (session && session.status !== 'running') return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for session to complete');
}

describe('SessionManager review sessions', () => {
  it('tags a session as kind "task" by default', () => {
    const config = getDefaultConfig();
    config.agents['test_echo'] = {
      name: 'Echo Test',
      command: 'echo',
      args: [],
      transport: 'pty_interactive',
      env: {},
    };
    const manager = new SessionManager(config);

    const session = manager.createSession('test_echo', 'hello');
    expect(session.kind).toBe('task');
    expect(session.getInfo().review).toBeUndefined();
  });

  it('parses and attaches structured review output for kind "review" sessions', async () => {
    const config = getDefaultConfig();
    const reviewPayload = JSON.stringify({
      verdict: 'approve',
      summary: 'Nothing concerning found.',
      findings: [],
      next_steps: [],
    });
    config.agents['fake_reviewer'] = {
      name: 'Fake Reviewer',
      command: 'node',
      args: ['-e', `console.log(JSON.stringify({ type: 'text', text: ${JSON.stringify(reviewPayload)} }))`],
      transport: 'claude_stream_json',
      env: {},
    };
    const manager = new SessionManager(config);

    const session = manager.createSession('fake_reviewer', 'review this', undefined, undefined, { kind: 'review' });
    const completed = await waitForSessionCompletion(manager, session.id);

    expect(completed.status).toBe('completed');
    expect(completed.getInfo().review?.verdict).toBe('approve');
  });
});
