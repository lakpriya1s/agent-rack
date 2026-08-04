import { describe, it, expect } from 'vitest';
import { ClaudeStreamJsonAdapter } from './claude.js';
import { AgyStreamAdapter } from './agy.js';
import { PtyTerminalAdapter } from './pty.js';
import { CodexExecJsonAdapter } from './codex.js';
import { createAdapter } from './index.js';

describe('ClaudeStreamJsonAdapter', () => {
  it('parses JSON stream events correctly', () => {
    const adapter = new ClaudeStreamJsonAdapter();
    const chunk = JSON.stringify({ type: 'text', text: 'Hello from Claude' }) + '\n' +
                  JSON.stringify({ type: 'tool_use', name: 'Edit', input: { file: 'app.ts' } }) + '\n';

    const events = adapter.parseChunk(chunk);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('text');
    expect(events[0].content).toBe('Hello from Claude');
    expect(events[1].type).toBe('tool_call');
    expect(events[1].toolName).toBe('Edit');
  });

  it('emits --permission-mode (not --mode) for plan mode', () => {
    const adapter = new ClaudeStreamJsonAdapter(['--output-format', 'json']);
    const args = adapter.getCLIArgs('review this', 'plan');

    expect(args).toEqual(['--output-format', 'json', '--permission-mode', 'plan', 'review this']);
    expect(args).not.toContain('--mode');
  });

  it('does not forward modes that are not valid Claude permission modes', () => {
    const adapter = new ClaudeStreamJsonAdapter(['--output-format', 'json']);

    // 'print' is not a --permission-mode choice; forwarding it would make the CLI exit non-zero.
    expect(adapter.getCLIArgs('do it', 'print')).toEqual(['--output-format', 'json', 'do it']);
    expect(adapter.getCLIArgs('do it', 'nonsense')).toEqual(['--output-format', 'json', 'do it']);
    expect(adapter.getCLIArgs('do it')).toEqual(['--output-format', 'json', 'do it']);
  });

  it('formats structured summary response', () => {
    const adapter = new ClaudeStreamJsonAdapter();
    const chunk = JSON.stringify({ type: 'text', text: 'Task completed successfully' }) + '\n' +
                  JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }) + '\n';

    const events = adapter.parseChunk(chunk);
    const result = adapter.formatResponse(events, 0);

    expect(result.summary).toContain('Task completed successfully');
    expect(result.summary).toContain('`Bash`');
    expect(result.toolCalls.length).toBe(1);
    expect(result.exitCode).toBe(0);
  });
});

describe('AgyStreamAdapter', () => {
  it('parses agy events and text lines', () => {
    const adapter = new AgyStreamAdapter();
    const chunk = 'Executing tool: git_status\nCompleted step 1\n';
    const events = adapter.parseChunk(chunk);

    expect(events.length).toBe(2);
    expect(events[0].type).toBe('tool_call');
    expect(events[0].toolName).toBe('git_status');
    expect(events[1].type).toBe('text');
  });
});

describe('PtyTerminalAdapter', () => {
  it('strips ANSI color codes', () => {
    const adapter = new PtyTerminalAdapter();
    const chunk = '\u001b[31mError:\u001b[0m File not found\n';
    const events = adapter.parseChunk(chunk);

    expect(events[0].content).toBe('Error: File not found');
  });
});

describe('CodexExecJsonAdapter', () => {
  it('parses agent_message and command_execution events', () => {
    const adapter = new CodexExecJsonAdapter();
    const chunk =
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n' +
      JSON.stringify({ type: 'turn.started' }) + '\n' +
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command: 'echo hello', status: 'in_progress' },
      }) + '\n' +
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'command_execution', command: 'echo hello', aggregated_output: 'hello\n', exit_code: 0 },
      }) + '\n' +
      JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'It printed hello' } }) + '\n' +
      JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n';

    const events = adapter.parseChunk(chunk);

    expect(events.length).toBe(3);
    expect(events[0].type).toBe('tool_call');
    expect(events[0].toolName).toBe('shell');
    expect(events[1].type).toBe('tool_result');
    expect(events[1].content).toBe('hello\n');
    expect(events[2].type).toBe('text');
    expect(events[2].content).toBe('It printed hello');
  });

  it('formats a turn.failed event as an error summary', () => {
    const adapter = new CodexExecJsonAdapter();
    const chunk = JSON.stringify({ type: 'turn.failed', error: { message: 'model not supported' } }) + '\n';

    const events = adapter.parseChunk(chunk);
    const result = adapter.formatResponse(events, 1);

    expect(events[0].type).toBe('error');
    expect(result.summary).toContain('model not supported');
  });

  it('resumes the thread id from thread.started, splicing `resume` in after `exec`', () => {
    const adapter = new CodexExecJsonAdapter();
    expect(adapter.capabilities.followUp).toBe('resume');
    // thread.started is the only place the id appears, so nothing is resumable before it.
    expect(adapter.getResumeArgs('follow up')).toBeNull();

    adapter.parseChunk(JSON.stringify({ type: 'thread.started', thread_id: 'th-42' }) + '\n');

    // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` — configured flags stay as options of
    // the resumed run rather than trailing the prompt.
    expect(adapter.getResumeArgs('follow up')).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      'th-42',
      'follow up',
    ]);
  });

  it('keeps the sandbox flag on a resumed turn', () => {
    const adapter = new CodexExecJsonAdapter(['exec', '--json']);
    adapter.parseChunk(JSON.stringify({ type: 'thread.started', thread_id: 'th-7' }) + '\n');

    expect(adapter.getResumeArgs('again', 'read-only')).toEqual([
      'exec',
      'resume',
      '--json',
      '--sandbox',
      'read-only',
      'th-7',
      'again',
    ]);
  });
});

describe('Adapter Factory', () => {
  it('instantiates correct adapter by transport config', () => {
    const adapter = createAdapter({
      name: 'Test Claude',
      command: 'claude',
      args: [],
      transport: 'claude_stream_json',
      env: {},
    });

    expect(adapter.transportType).toBe('claude_stream_json');
  });
});

describe('claude streaming capability', () => {
  it('reports no streaming under --output-format json, which buffers until exit', () => {
    // The bug: this was hardcoded true, so a whole multi-turn run advertised progress
    // visibility while producing exactly one event at exit.
    const adapter = new ClaudeStreamJsonAdapter(['--output-format', 'json']);
    expect(adapter.capabilities.supportsStreaming).toBe(false);
  });

  it('reports streaming under --output-format stream-json', () => {
    expect(
      new ClaudeStreamJsonAdapter(['--output-format', 'stream-json', '--verbose']).capabilities
        .supportsStreaming
    ).toBe(true);
  });

  it('accepts the --output-format=stream-json spelling', () => {
    expect(
      new ClaudeStreamJsonAdapter(['--output-format=stream-json', '--verbose']).capabilities
        .supportsStreaming
    ).toBe(true);
  });

  it('does not mistake a stream-json input format for output streaming', () => {
    expect(
      new ClaudeStreamJsonAdapter(['--input-format', 'stream-json', '--output-format', 'json'])
        .capabilities.supportsStreaming
    ).toBe(false);
  });

  it('keeps the other capabilities fixed regardless of output format', () => {
    for (const args of [['--output-format', 'json'], ['--output-format', 'stream-json']]) {
      const caps = new ClaudeStreamJsonAdapter(args).capabilities;
      expect(caps.supportsFollowUp).toBe(true);
      expect(caps.followUp).toBe('resume');
      expect(caps.supportsNativeReadOnly).toBe(true);
      expect(caps.promptTransport).toBe('argv');
    }
  });
});

describe('ClaudeStreamJsonAdapter conversation resume', () => {
  it('has nothing to resume until the stream reveals a session_id', () => {
    const adapter = new ClaudeStreamJsonAdapter();
    expect(adapter.getResumeArgs('follow up')).toBeNull();
  });

  it('resumes the session_id the CLI reported, leaving the first turn args untouched', () => {
    const adapter = new ClaudeStreamJsonAdapter(['--output-format', 'json']);

    // The first turn must add no flags of its own: this transport may be driven by a wrapper
    // command that rejects invented options (`node -e '…' --session-id <uuid>` → "bad option").
    expect(adapter.getCLIArgs('do the thing')).toEqual([
      '--output-format',
      'json',
      'do the thing',
    ]);

    adapter.parseChunk(
      JSON.stringify({ type: 'assistant', session_id: 'abc-123', content: [] }) + '\n'
    );

    expect(adapter.getResumeArgs('and now this')).toEqual([
      '--output-format',
      'json',
      '--resume',
      'abc-123',
      'and now this',
    ]);
  });

  it('forwards a permission mode on the resumed turn too', () => {
    const adapter = new ClaudeStreamJsonAdapter([]);
    adapter.parseChunk(JSON.stringify({ type: 'result', session_id: 'sid-9' }) + '\n');

    expect(adapter.getResumeArgs('again', 'plan')).toEqual([
      '--resume',
      'sid-9',
      '--permission-mode',
      'plan',
      'again',
    ]);
  });

  it('refuses to resume when the configured args already pin a conversation', () => {
    for (const pinned of [['--continue'], ['-c'], ['--resume', 'other'], ['--session-id', 'x']]) {
      const adapter = new ClaudeStreamJsonAdapter(pinned);
      expect(adapter.capabilities.followUp).toBe('none');
      expect(adapter.capabilities.supportsFollowUp).toBe(false);

      adapter.parseChunk(JSON.stringify({ type: 'result', session_id: 'sid-1' }) + '\n');
      // Adding our own --resume alongside the caller's own flag would conflict; refusing is the
      // honest outcome, not silently overriding what they asked for.
      expect(adapter.getResumeArgs('follow up')).toBeNull();
    }
  });
});
