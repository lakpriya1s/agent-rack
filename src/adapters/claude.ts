import { AgentAdapter, ParsedAgentEvent, FormattedResult } from './base.js';

export class ClaudeStreamJsonAdapter implements AgentAdapter {
  readonly transportType = 'claude_stream_json';
  private buffer = '';

  constructor(private defaultArgs: string[] = ['--dangerously-skip-permissions', '--output-format', 'json']) {}

  getCLIArgs(prompt: string, mode?: string): string[] {
    const args = [...this.defaultArgs];

    if (mode === 'print' || mode === 'plan') {
      args.push('--mode', mode);
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
      summary = `Execution completed with exit code ${exitCode}. Executed ${toolCalls.length} tool calls.`;
    }

    if (toolCalls.length > 0) {
      summary += `\n\n### Tool Calls Executed (${toolCalls.length}):\n`;
      for (const tc of toolCalls) {
        summary += `- \`${tc.name}\`: ${JSON.stringify(tc.input)}\n`;
      }
    }

    return {
      summary,
      rawText,
      toolCalls,
      events,
      exitCode,
    };
  }
}
