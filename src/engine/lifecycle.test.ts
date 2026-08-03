import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from './session.js';
import { EventRingBuffer } from './buffer.js';
import { getDefaultConfig } from '../config/loader.js';
import { waitForSessionCompletion } from '../test-helpers/session.js';
import type { AgentConfig, AgentMCPConfig } from '../config/schema.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rack-lifecycle-'));
}

/** An agent that exits immediately, for testing terminal-state bookkeeping. */
function instantAgent(dir: string): AgentConfig {
  const script = path.join(dir, 'instant.cjs');
  fs.writeFileSync(script, "console.log(JSON.stringify({ type: 'assistant', text: 'done' }));\n");
  return {
    name: 'Instant',
    command: 'node',
    args: [script],
    transport: 'claude_stream_json',
    env: {},
  };
}

/** An agent that never exits on its own, so cancellation behaviour is observable. */
function hangingAgent(dir: string): AgentConfig {
  const script = path.join(dir, 'hang.cjs');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  return {
    name: 'Hanging',
    command: 'node',
    args: [script],
    transport: 'claude_stream_json',
    env: {},
  };
}

/** A PTY agent, the only transport that can accept follow-up input. */
function ptyAgent(dir: string): AgentConfig {
  const script = path.join(dir, 'pty.cjs');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  return {
    name: 'Pty',
    command: 'node',
    args: [script],
    transport: 'pty_interactive',
    env: {},
  };
}

function configFor(dir: string, overrides: Partial<AgentMCPConfig['security']> = {}): AgentMCPConfig {
  const config = getDefaultConfig(dir);
  config.security = { ...config.security, ...overrides };
  return config;
}

describe('EventRingBuffer cursors', () => {
  it('keeps totalEvents monotonic after eviction, unlike the retained length', () => {
    const buffer = new EventRingBuffer({ maxEvents: 3 });
    for (let i = 0; i < 10; i++) {
      buffer.push({ type: 'text', content: `e${i}`, timestamp: 0 });
    }

    expect(buffer.size()).toBe(3);
    // The bug this replaces: size() plateaus at the cap, so polling it detects no progress.
    expect(buffer.totalEvents()).toBe(10);
    expect(buffer.droppedEvents()).toBe(7);
  });

  it('returns only events after a cursor, across an eviction boundary', () => {
    const buffer = new EventRingBuffer({ maxEvents: 5 });
    for (let i = 0; i < 5; i++) buffer.push({ type: 'text', content: `e${i}`, timestamp: 0 });

    const first = buffer.getSince(0);
    expect(first.events.map((e) => e.content)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
    expect(first.nextCursor).toBe(5);

    for (let i = 5; i < 8; i++) buffer.push({ type: 'text', content: `e${i}`, timestamp: 0 });

    const next = buffer.getSince(first.nextCursor);
    expect(next.events.map((e) => e.content)).toEqual(['e5', 'e6', 'e7']);
    expect(next.droppedCount).toBe(0);
  });

  it('reports droppedCount when a cursor has fallen out of the retained window', () => {
    const buffer = new EventRingBuffer({ maxEvents: 2 });
    for (let i = 0; i < 6; i++) buffer.push({ type: 'text', content: `e${i}`, timestamp: 0 });

    const page = buffer.getSince(0);
    expect(page.events.map((e) => e.content)).toEqual(['e4', 'e5']);
    expect(page.oldestCursor).toBe(4);
    expect(page.droppedCount).toBe(4);
  });

  it('evicts on the byte budget, since one event can be enormous', () => {
    const buffer = new EventRingBuffer({ maxEvents: 1000, maxBytes: 1000 });
    for (let i = 0; i < 20; i++) {
      buffer.push({ type: 'tool_result', content: 'x'.repeat(200), timestamp: 0 });
    }

    expect(buffer.size()).toBeLessThan(20);
    expect(buffer.retainedBytes()).toBeLessThanOrEqual(1000);
    expect(buffer.totalEvents()).toBe(20);
  });

  it('never evicts a lone oversized event, which would leave nothing readable', () => {
    const buffer = new EventRingBuffer({ maxEvents: 10, maxBytes: 10 });
    buffer.push({ type: 'text', content: 'x'.repeat(5000), timestamp: 0 });

    expect(buffer.size()).toBe(1);
    expect(buffer.getSince(0).events).toHaveLength(1);
  });

  it('serves a tail without the caller tracking cursors', () => {
    const buffer = new EventRingBuffer({ maxEvents: 100 });
    for (let i = 0; i < 10; i++) buffer.push({ type: 'text', content: `e${i}`, timestamp: 0 });

    expect(buffer.getTail(3).events.map((e) => e.content)).toEqual(['e7', 'e8', 'e9']);
  });
});

describe('session retention', () => {
  it('prunes finished sessions past the retention window', async () => {
    const dir = tempDir();
    try {
      const config = configFor(dir, { sessionRetentionMinutes: 60 });
      config.agents['instant'] = instantAgent(dir);
      const manager = new SessionManager(config);

      const first = manager.createSession('instant', 'go', dir);
      await waitForSessionCompletion(manager, first.id);

      // Backdate it past the window; pruning runs on the next createSession.
      manager.getSession(first.id)!.finishedAt = new Date(Date.now() - 61 * 60_000).toISOString();

      const second = manager.createSession('instant', 'go', dir);
      await waitForSessionCompletion(manager, second.id);

      expect(manager.getSession(first.id)).toBeUndefined();
      expect(manager.getSession(second.id)).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trims oldest-first to maxRetainedSessions regardless of age', async () => {
    const dir = tempDir();
    try {
      const config = configFor(dir, { maxRetainedSessions: 2 });
      config.agents['instant'] = instantAgent(dir);
      const manager = new SessionManager(config);

      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const session = manager.createSession('instant', 'go', dir);
        await waitForSessionCompletion(manager, session.id);
        ids.push(session.id);
      }

      // The 4th create prunes down to the cap, so at most 2 finished sessions survive plus
      // the one just created.
      expect(manager.listSessions().length).toBeLessThanOrEqual(3);
      expect(manager.getSession(ids[0])).toBeUndefined();
      expect(manager.getSession(ids[ids.length - 1])).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never prunes a running session, however old', async () => {
    const dir = tempDir();
    try {
      const config = configFor(dir, { sessionRetentionMinutes: 1, maxRetainedSessions: 1 });
      config.agents['hanging'] = hangingAgent(dir);
      config.agents['instant'] = instantAgent(dir);
      const manager = new SessionManager(config);

      const running = manager.createSession('hanging', 'wait', dir);
      const done = manager.createSession('instant', 'go', dir);
      await waitForSessionCompletion(manager, done.id);

      expect(manager.getSession(running.id)).toBeDefined();
      expect(manager.getSession(running.id)!.status).toBe('running');

      manager.cancelSession(running.id);
      await manager.shutdown();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes a finished session on request but refuses a live one', async () => {
    const dir = tempDir();
    try {
      const config = configFor(dir);
      config.agents['instant'] = instantAgent(dir);
      config.agents['hanging'] = hangingAgent(dir);
      const manager = new SessionManager(config);

      const finished = manager.createSession('instant', 'go', dir);
      await waitForSessionCompletion(manager, finished.id);
      manager.deleteSession(finished.id);
      expect(manager.getSession(finished.id)).toBeUndefined();

      const running = manager.createSession('hanging', 'wait', dir);
      expect(() => manager.deleteSession(running.id)).toThrow(/cancel it before deleting/);

      await manager.shutdown();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cancellation and concurrency', () => {
  it('reports cancelling while the child is still being torn down', async () => {
    const dir = tempDir();
    try {
      const config = configFor(dir);
      config.agents['hanging'] = hangingAgent(dir);
      const manager = new SessionManager(config);

      const session = manager.createSession('hanging', 'wait', dir);
      manager.cancelSession(session.id);

      // Previously this flipped straight to 'cancelled' even though the process was alive.
      expect(session.status).toBe('cancelling');

      const settled = await waitForSessionCompletion(manager, session.id);
      expect(settled.status).toBe('cancelled');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still counts a cancelling session against maxConcurrentSessions', async () => {
    const dir = tempDir();
    try {
      const config = configFor(dir, { maxConcurrentSessions: 1 });
      config.agents['hanging'] = hangingAgent(dir);
      const manager = new SessionManager(config);

      const session = manager.createSession('hanging', 'wait', dir);
      manager.cancelSession(session.id);

      // The bug: 'cancelled' was excluded from the active count immediately, so during the
      // SIGINT->SIGKILL grace period the limit could be exceeded.
      expect(() => manager.createSession('hanging', 'wait', dir)).toThrow(
        /Maximum concurrent sessions limit \(1\) reached/
      );

      await manager.shutdown();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('follow-up input capability gate', () => {
  it('refuses agent_session_send for one-shot argv transports with an explanatory error', async () => {
    const dir = tempDir();
    try {
      const config = configFor(dir);
      config.agents['hanging'] = hangingAgent(dir);
      const manager = new SessionManager(config);

      const session = manager.createSession('hanging', 'wait', dir);

      // Previously this produced 'Process is not running or stdin is unavailable', which
      // read like a transient failure rather than a permanent property of the transport.
      expect(() => manager.sendToSession(session.id, 'more')).toThrow(
        /does not support follow-up input/
      );
      expect(session.getInfo().supportsFollowUp).toBe(false);

      manager.cancelSession(session.id);
      await manager.shutdown();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('advertises follow-up support for the PTY transport', async () => {
    const dir = tempDir();
    try {
      const config = configFor(dir);
      config.agents['pty'] = ptyAgent(dir);
      const manager = new SessionManager(config);

      const session = manager.createSession('pty', 'wait', dir);
      expect(session.getInfo().supportsFollowUp).toBe(true);

      manager.cancelSession(session.id);
      await manager.shutdown();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
