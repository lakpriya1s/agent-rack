import {
  AgentAdapter,
  AgentCapabilities,
  ParsedAgentEvent,
  FormattedResult,
  describeEmptyResult,
} from './base.js';

// Regex to strip ANSI escape codes from terminal outputs
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nary=>]/g;

export class PtyTerminalAdapter implements AgentAdapter {
  readonly transportType = 'pty_interactive';

  /**
   * The only transport with a live input channel: a pseudo-terminal stays open, so writing to
   * it is a real second turn. No sandbox flag, so read-only is prompt-level best effort.
   */
  readonly capabilities: AgentCapabilities = {
    supportsFollowUp: true,
    supportsStreaming: true,
    supportsNativeReadOnly: false,
    promptTransport: 'pty',
  };

  /**
   * PTY data arrives in arbitrary-sized chunks that split mid-line, so an unterminated tail is
   * held back until its newline arrives. Without this, one logical line surfaced as several
   * fragmented events (and a word could be cut in half across two of them).
   */
  private buffer = '';

  constructor(private defaultArgs: string[] = ['--non-interactive']) {}

  getCLIArgs(prompt: string, mode?: string): string[] {
    const args = [...this.defaultArgs];
    if (mode) {
      args.push('--mode', mode);
    }
    args.push(prompt);
    return args;
  }

  parseChunk(chunk: string): ParsedAgentEvent[] {
    this.buffer += chunk.replace(ANSI_REGEX, '');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    return PtyTerminalAdapter.toTextEvents(lines);
  }

  /** Emits whatever the process left behind without a trailing newline (e.g. a prompt line). */
  flush(): ParsedAgentEvent[] {
    const tail = this.buffer;
    this.buffer = '';
    return PtyTerminalAdapter.toTextEvents([tail]);
  }

  private static toTextEvents(lines: string[]): ParsedAgentEvent[] {
    const events: ParsedAgentEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      events.push({ type: 'text', content: trimmed, timestamp: Date.now() });
    }
    return events;
  }

  formatResponse(events: ParsedAgentEvent[], exitCode: number = 0): FormattedResult {
    // A PTY merges stderr into the same stream, so every event here is already 'text'.
    const summary = events
      .filter((event) => event.type === 'text')
      .map((event) => event.content)
      .join('\n')
      .trim();

    return {
      summary: summary || describeEmptyResult(events, exitCode, 0),
      rawText: summary,
      toolCalls: [],
      events,
      exitCode,
    };
  }
}
