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

export class ClaudeStreamJsonAdapter implements AgentAdapter {
  readonly transportType = 'claude_stream_json';

  /**
   * The prompt is a positional argv argument and the process exits when the turn ends, so
   * there is no second turn to send follow-up input to. `--permission-mode plan` does give a
   * genuine read-only run.
   */
  readonly capabilities: AgentCapabilities = {
    supportsFollowUp: false,
    supportsStreaming: true,
    supportsNativeReadOnly: true,
    promptTransport: 'argv',
  };

  private buffer = '';

  constructor(private defaultArgs: string[] = ['--output-format', 'json']) {}

  getCLIArgs(prompt: string, mode?: string): string[] {
    const args = [...this.defaultArgs];

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
