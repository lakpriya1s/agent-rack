import {
  AgentAdapter,
  AgentCapabilities,
  ParsedAgentEvent,
  FormattedResult,
  appendToolCallsBlock,
  describeEmptyResult,
} from './base.js';

/**
 * Valid values for Claude Code's `--permission-mode` flag (verified against CLI 2.1.220:
 * `--permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions",
 * "manual", "dontAsk", "plan")`).
 *
 * Note: this adapter previously emitted `--mode <mode>`, which is not a Claude Code flag
 * at all ("error: unknown option '--mode'"), so every read-only review against a
 * claude_stream_json agent failed outright. `print` is likewise NOT a permission mode and
 * is therefore no longer forwarded — passing it would have made the CLI exit non-zero.
 */
const CLAUDE_PERMISSION_MODES = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);

/**
 * Whether these args make Claude Code emit incremental events.
 *
 * Accepts both `--output-format stream-json` and `--output-format=stream-json`. Note the CLI
 * additionally requires `--verbose` for this combination, so args that request stream-json
 * without it will not actually run — the check is deliberately about intent, since a config that
 * cannot start is a separate, loud failure.
 */
export function claudeArgsStream(args: string[]): boolean {
  return args.some((arg, index) => {
    if (arg === '--output-format') return args[index + 1] === 'stream-json';
    return arg === '--output-format=stream-json';
  });
}

/** Flags that already pin the conversation, so this adapter must not add its own. */
function claudeArgsPinConversation(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === '--session-id' ||
      arg.startsWith('--session-id=') ||
      arg === '--resume' ||
      arg.startsWith('--resume=') ||
      arg === '-r' ||
      arg === '--continue' ||
      arg === '-c'
  );
}

export class ClaudeStreamJsonAdapter implements AgentAdapter {
  readonly transportType = 'claude_stream_json';

  /**
   * The prompt is a positional argv argument and the process exits when the turn ends — but that
   * is not the end of the *conversation*. Claude Code accepts `--session-id <uuid>` to name a
   * session and `--resume <uuid>` to rejoin it in a later process, so follow-up input works by
   * starting a new turn against the same session id (verified against CLI 2.1.221: turn two
   * correctly recalled turn one's answer). `--permission-mode plan` gives a genuine read-only run.
   *
   * `supportsStreaming` is derived from the configured args rather than hardcoded, because this
   * transport only streams under `--output-format stream-json`. With the default
   * `--output-format json`, Claude Code buffers the entire run and emits one JSON object at
   * exit — so a whole multi-turn task produces a single event and `agent_session_logs` stays
   * empty until it finishes. Reporting `true` there advertised progress visibility that does
   * not exist.
   */
  readonly capabilities: AgentCapabilities;

  private buffer = '';
  /**
   * The conversation id to resume, learned from `session_id` in the CLI's own output.
   *
   * Deliberately parsed rather than assigned up front with `--session-id`: this transport is
   * "speaks Claude Code's stream JSON protocol", not "is the claude binary", so a configured
   * command may be a wrapper that rejects flags we invent — `node -e '…' --session-id <uuid>`
   * fails outright with "bad option". Parsing leaves the first turn's argv exactly as configured,
   * so nothing that works today can break; only a follow-up, which the caller asked for, adds
   * a flag.
   */
  private conversationId?: string;
  /** True when the caller's own args already decide the conversation — see `capabilities`. */
  private readonly conversationPinnedByConfig: boolean;

  constructor(private defaultArgs: string[] = ['--output-format', 'json']) {
    this.conversationPinnedByConfig = claudeArgsPinConversation(defaultArgs);
    this.capabilities = {
      // No follow-up when the config already pins a conversation: a second `--resume` would
      // conflict with the caller's own flag, and silently overriding it is worse than refusing.
      supportsFollowUp: !this.conversationPinnedByConfig,
      followUp: this.conversationPinnedByConfig ? 'none' : 'resume',
      supportsStreaming: claudeArgsStream(defaultArgs),
      supportsNativeReadOnly: true,
      promptTransport: 'argv',
    };
  }

  getCLIArgs(prompt: string, mode?: string): string[] {
    const args = [...this.defaultArgs];

    if (CLAUDE_PERMISSION_MODES.has(mode ?? '')) {
      args.push('--permission-mode', mode as string);
    }

    args.push(prompt);
    return args;
  }

  /**
   * Verified against CLI 2.1.221: a second process started with `--resume <session_id>` rejoins
   * the conversation and can recall the first turn's answer.
   */
  getResumeArgs(prompt: string, mode?: string): string[] | null {
    if (!this.conversationId || this.conversationPinnedByConfig) return null;

    const args = [...this.defaultArgs, '--resume', this.conversationId];

    if (CLAUDE_PERMISSION_MODES.has(mode ?? '')) {
      args.push('--permission-mode', mode as string);
    }

    args.push(prompt);
    return args;
  }

  parseChunk(chunk: string): ParsedAgentEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // keep incomplete tail

    const events: ParsedAgentEvent[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const data = JSON.parse(trimmed);
        events.push(...this.processJsonMessage(data));
      } catch {
        // Non-JSON fallback line
        events.push({
          type: 'text',
          content: trimmed,
          timestamp: Date.now(),
        });
      }
    }

    return events;
  }

  /**
   * `claude --output-format json` emits one JSON object and may exit without a trailing
   * newline, in which case the whole response sits in `buffer` and would be dropped.
   */
  flush(): ParsedAgentEvent[] {
    const tail = this.buffer.trim();
    this.buffer = '';
    if (!tail) return [];

    try {
      return this.processJsonMessage(JSON.parse(tail));
    } catch {
      return [{ type: 'text', content: tail, timestamp: Date.now() }];
    }
  }

  private processJsonMessage(data: Record<string, unknown>): ParsedAgentEvent[] {
    const timestamp = Date.now();
    const events: ParsedAgentEvent[] = [];

    // Every event of a real claude run carries the session id (`system`/`assistant`/`result`
    // alike), so a follow-up has something to resume as soon as the first line arrives.
    if (typeof data.session_id === 'string' && data.session_id) {
      this.conversationId = data.session_id;
    }

    const type = String(data.type || data.event || '');

    if (type === 'assistant' || type === 'message') {
      const content = data.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            events.push({ type: 'text', content: String(block.text || ''), timestamp });
          } else if (block.type === 'tool_use') {
            events.push({
              type: 'tool_call',
              content: `Tool Call: ${block.name}`,
              toolName: String(block.name),
              input: block.input,
              timestamp,
            });
          }
        }
      } else if (typeof data.text === 'string') {
        events.push({ type: 'text', content: data.text, timestamp });
      }
    } else if (type === 'tool_use' || type === 'tool_call') {
      events.push({
        type: 'tool_call',
        content: `Tool Call: ${data.name || data.tool}`,
        toolName: String(data.name || data.tool),
        input: data.input || data.parameters,
        timestamp,
      });
    } else if (type === 'tool_result') {
      events.push({
        type: 'tool_result',
        content: String(data.output || data.content || 'Tool execution finished'),
        output: data.output || data.content,
        timestamp,
      });
    } else if (type === 'result' || type === 'summary') {
      events.push({
        type: 'text',
        content: String(data.text || data.result || JSON.stringify(data)),
        metadata: data,
        timestamp,
      });
    } else {
      // General payload
      const text = data.text || data.message || data.content || JSON.stringify(data);
      events.push({
        type: 'text',
        content: String(text),
        timestamp,
      });
    }

    return events;
  }

  formatResponse(events: ParsedAgentEvent[], exitCode: number = 0): FormattedResult {
    let rawText = '';
    const toolCalls: Array<{ name: string; input: unknown; output?: unknown }> = [];
    const textBlocks: string[] = [];

    for (const ev of events) {
      if (ev.type === 'text') {
        textBlocks.push(ev.content);
        rawText += ev.content + '\n';
      } else if (ev.type === 'tool_call') {
        toolCalls.push({
          name: ev.toolName || 'unknown_tool',
          input: ev.input,
          output: ev.output,
        });
      }
    }

    let summary = textBlocks.join('\n\n').trim();
    if (!summary) {
      summary = describeEmptyResult(events, exitCode, toolCalls.length);
    }

    return {
      summary: appendToolCallsBlock(summary, toolCalls),
      rawText,
      toolCalls,
      events,
      exitCode,
    };
  }
}
