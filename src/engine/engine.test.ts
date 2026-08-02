import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventRingBuffer } from './buffer.js';
import { getDefaultConfig } from '../config/loader.js';
import { SessionManager } from './session.js';
import { waitForSessionCompletion } from '../test-helpers/session.js';

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

describe('SessionManager.listSessions', () => {
  it('returns an empty array when no sessions exist', () => {
    const config = getDefaultConfig();
    const manager = new SessionManager(config);
    expect(manager.listSessions()).toEqual([]);
  });

  it('returns sessions sorted by createdAt descending, and each includes its kind', async () => {
    const config = getDefaultConfig();
    config.agents['test_echo'] = {
      name: 'Echo Test',
      command: 'echo',
      args: [],
      transport: 'pty_interactive',
      env: {},
    };
    const manager = new SessionManager(config);

    const first = manager.createSession('test_echo', 'one');
    await waitForSessionCompletion(manager, first.id);
    const second = manager.createSession('test_echo', 'two', undefined, undefined, { kind: 'review' });
    await waitForSessionCompletion(manager, second.id);

    const listed = manager.listSessions();
    expect(listed.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(listed[0].getInfo().kind).toBe('review');
    expect(listed[1].getInfo().kind).toBe('task');
  });
});

describe('SessionManager shutdown', () => {
  it('cancels a long-running child and awaits process settlement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rack-shutdown-'));
    const pidFile = path.join(dir, 'child.pid');
    const config = getDefaultConfig(dir);
    config.agents['long_running'] = {
      name: 'Long Running',
      command: 'node',
      args: [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      transport: 'claude_stream_json',
      env: {},
    };
    const manager = new SessionManager(config);

    const session = manager.createSession('long_running', 'wait', dir);
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));

    await manager.shutdown();

    expect(session.status).toBe('cancelled');
    expect(() => process.kill(pid, 0)).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a timed-out PTY child tracked through forced termination', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rack-pty-shutdown-'));
    const pidFile = path.join(dir, 'child.pid');
    const config = getDefaultConfig(dir);
    config.agents['stubborn_pty'] = {
      name: 'Stubborn PTY',
      command: 'node',
      args: [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => {}); setInterval(() => {}, 1000)`,
      ],
      transport: 'pty_interactive',
      env: {},
    };
    const manager = new SessionManager(config);
    let pid: number | undefined;

    try {
      const session = manager.createSession('stubborn_pty', 'wait', dir, undefined, {
        timeoutSeconds: 0.05,
      });
      const deadline = Date.now() + 2000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fs.existsSync(pidFile)).toBe(true);
      pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(session.status).toBe('running');

      await manager.shutdown();

      expect(session.status).toBe('cancelled');
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The shutdown path already terminated it.
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('atomically rejects creates once shutdown begins and awaits the raced run', async () => {
    const config = getDefaultConfig();
    config.agents['long_running'] = {
      name: 'Long Running',
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      transport: 'claude_stream_json',
      env: {},
    };
    const manager = new SessionManager(config);
    const raced = manager.createSession('long_running', 'wait');

    const shuttingDown = manager.shutdown();
    expect(() => manager.createSession('long_running', 'too late')).toThrow(
      /shutting down/
    );
    await shuttingDown;
    expect(raced.status).toBe('cancelled');
  });
});

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
