import { AgentAdapter, ParsedAgentEvent, FormattedResult } from './base.js';

export class AgyStreamAdapter implements AgentAdapter {
  readonly transportType = 'agy_stream';
  private buffer = '';

  constructor(private defaultArgs: string[] = ['--print']) {}

  getCLIArgs(prompt: string, mode?: string): string[] {
    const args = [...this.defaultArgs];
    if (mode) {
      args.push('--mode', mode);
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

      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const data = JSON.parse(trimmed);
          events.push({
            type: data.type || 'text',
            content: data.content || data.message || trimmed,
            toolName: data.toolName || data.tool,
            input: data.input,
            output: data.output,
            timestamp: Date.now(),
          });
          continue;
        } catch {
          // Fall through to plain text
        }
      }

      // Plain AGY stdout line parsing
      if (trimmed.includes('Executing tool:')) {
        const toolName = trimmed.split('Executing tool:')[1]?.trim();
        events.push({
          type: 'tool_call',
          content: trimmed,
          toolName,
          timestamp: Date.now(),
        });
      } else {
        events.push({
          type: 'text',
          content: trimmed,
          timestamp: Date.now(),
        });
      }
    }

    return events;
  }

  formatResponse(events: ParsedAgentEvent[], exitCode: number = 0): FormattedResult {
    const textBlocks: string[] = [];
    const toolCalls: Array<{ name: string; input: unknown; output?: unknown }> = [];

    for (const ev of events) {
      if (ev.type === 'text') {
        textBlocks.push(ev.content);
      } else if (ev.type === 'tool_call') {
        toolCalls.push({
          name: ev.toolName || 'agy_tool',
          input: ev.input || ev.content,
          output: ev.output,
        });
      }
    }

    let summary = textBlocks.join('\n').trim();
    if (!summary) {
      summary = `AGY execution completed with exit code ${exitCode}.`;
    }

    return {
      summary,
      rawText: textBlocks.join('\n'),
      toolCalls,
      events,
      exitCode,
    };
  }
}
