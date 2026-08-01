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
