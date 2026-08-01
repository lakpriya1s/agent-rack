import { AgentAdapter, ParsedAgentEvent, FormattedResult } from './base.js';

// Regex to strip ANSI escape codes from terminal outputs
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nary=>]/g;

export class PtyTerminalAdapter implements AgentAdapter {
  readonly transportType = 'pty_interactive';

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
    const cleanText = chunk.replace(ANSI_REGEX, '');
    const lines = cleanText.split('\n');

    const events: ParsedAgentEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      events.push({
        type: 'text',
        content: trimmed,
        timestamp: Date.now(),
      });
    }

    return events;
  }

  formatResponse(events: ParsedAgentEvent[], exitCode: number = 0): FormattedResult {
    const lines = events.map((e) => e.content);
    const summary = lines.join('\n').trim();

    return {
      summary: summary || `Terminal execution completed with exit code ${exitCode}.`,
      rawText: summary,
      toolCalls: [],
      events,
      exitCode,
    };
  }
}
