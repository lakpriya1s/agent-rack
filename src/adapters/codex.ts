import {
  AgentAdapter,
  AgentCapabilities,
  ParsedAgentEvent,
  FormattedResult,
  appendToolCallsBlock,
  describeEmptyResult,
} from './base.js';

export class CodexExecJsonAdapter implements AgentAdapter {
  readonly transportType = 'codex_exec_json';

  /**
   * `codex exec` is one-shot with the prompt as argv. Its `--sandbox` flag is a real
   * OS-level sandbox, making it the only transport that can guarantee a read-only run.
   */
  readonly capabilities: AgentCapabilities = {
    supportsFollowUp: false,
    supportsStreaming: true,
    supportsNativeReadOnly: true,
    promptTransport: 'argv',
  };

  private buffer = '';

  constructor(private defaultArgs: string[] = ['exec', '--json', '--skip-git-repo-check']) {}

  getCLIArgs(prompt: string, mode?: string): string[] {
    const args = [...this.defaultArgs];

    if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') {
      args.push('--sandbox', mode);
    }

    args.push(prompt);
    return args;
  }

  parseChunk(chunk: string): ParsedAgentEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    const events: ParsedAgentEvent[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const data = JSON.parse(trimmed);
        events.push(...this.processJsonMessage(data));
      } catch {
        // Codex prints plain-text status banners (e.g. "Reading additional input from
        // stdin...") outside the JSONL protocol. These aren't model output, so they must
        // not be treated as 'text' or they'll clobber the real summary/error events.
        events.push({ type: 'status', content: trimmed, timestamp: Date.now() });
      }
    }

    return events;
  }

  /** Emits a final unterminated JSONL line so a last-gasp error event is not lost. */
  flush(): ParsedAgentEvent[] {
    const tail = this.buffer.trim();
    this.buffer = '';
    if (!tail) return [];

    try {
      return this.processJsonMessage(JSON.parse(tail));
    } catch {
      return [{ type: 'status', content: tail, timestamp: Date.now() }];
    }
  }

  private processJsonMessage(data: Record<string, unknown>): ParsedAgentEvent[] {
    const timestamp = Date.now();
    const type = String(data.type || '');

    if (type === 'item.started' || type === 'item.completed') {
      const item = (data.item || {}) as Record<string, unknown>;
      const itemType = String(item.type || '');

      if (itemType === 'agent_message') {
        if (type === 'item.completed') {
          return [{ type: 'text', content: String(item.text || ''), timestamp }];
        }
        return [];
      }

      if (itemType === 'command_execution') {
        // Carry codex's own item id through so formatResponse can pair a result with the call
        // it belongs to. Concurrent commands interleave started/completed events, so
        // "attach to the most recent tool_call" attributes output to the wrong command.
        const itemId = item.id === undefined ? undefined : String(item.id);

        if (type === 'item.started') {
          return [
            {
              type: 'tool_call',
              content: `Tool Call: shell`,
              toolName: 'shell',
              input: item.command,
              metadata: itemId ? { itemId } : undefined,
              timestamp,
            },
          ];
        }
        return [
          {
            type: 'tool_result',
            content: String(item.aggregated_output || ''),
            output: { exitCode: item.exit_code, output: item.aggregated_output },
            metadata: itemId ? { itemId } : undefined,
            timestamp,
          },
        ];
      }

      if (itemType === 'error') {
        return [{ type: 'error', content: String(item.message || 'Unknown error'), timestamp }];
      }

      // Unrecognized item type (e.g. file_change, reasoning, web_search) — fall back to generic text.
      if (type === 'item.completed') {
        const text = item.text || item.message || item.command || JSON.stringify(item);
        return [{ type: 'text', content: String(text), timestamp }];
      }
      return [];
    }

    if (type === 'error' || type === 'turn.failed') {
      const errorObj = data.error as Record<string, unknown> | undefined;
      const message = data.message || errorObj?.message || JSON.stringify(data);
      return [{ type: 'error', content: String(message), metadata: data, timestamp }];
    }

    // thread.started / turn.started / turn.completed carry no user-facing content.
    return [];
  }

  formatResponse(events: ParsedAgentEvent[], exitCode: number = 0): FormattedResult {
    let rawText = '';
    const toolCalls: Array<{ name: string; input: unknown; output?: unknown }> = [];
    const textBlocks: string[] = [];
    const errors: string[] = [];
    /** itemId -> index in toolCalls, so a result lands on its own call rather than the newest. */
    const callsByItemId = new Map<string, number>();

    for (const ev of events) {
      if (ev.type === 'text') {
        textBlocks.push(ev.content);
        rawText += ev.content + '\n';
      } else if (ev.type === 'tool_call') {
        const itemId = ev.metadata?.itemId;
        if (typeof itemId === 'string') callsByItemId.set(itemId, toolCalls.length);
        toolCalls.push({ name: ev.toolName || 'shell', input: ev.input });
      } else if (ev.type === 'tool_result') {
        const itemId = ev.metadata?.itemId;
        const index =
          typeof itemId === 'string' && callsByItemId.has(itemId)
            ? callsByItemId.get(itemId)!
            : toolCalls.length - 1;
        const target = toolCalls[index];
        if (target) target.output = ev.output;
      } else if (ev.type === 'error') {
        errors.push(ev.content);
      }
    }

    let summary = textBlocks.join('\n\n').trim();
    if (!summary && errors.length > 0) {
      summary = `Error: ${errors.join('\n')}`;
    } else if (!summary) {
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
