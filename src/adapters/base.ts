export type EventType = 'text' | 'tool_call' | 'tool_result' | 'thought' | 'status' | 'error';

export interface ParsedAgentEvent {
  type: EventType;
  content: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface FormattedResult {
  summary: string;
  rawText: string;
  toolCalls: Array<{ name: string; input: unknown; output?: unknown }>;
  events: ParsedAgentEvent[];
  exitCode?: number;
}

export interface AgentAdapter {
  readonly transportType: string;
  getCLIArgs(prompt: string, mode?: string): string[];
  parseChunk(chunk: string): ParsedAgentEvent[];
  formatResponse(events: ParsedAgentEvent[], exitCode?: number): FormattedResult;
}

/**
 * Appends the human-readable tool-call manifest that JSON-stream adapters add to their
 * summary. Returns `summary` untouched when no tools ran.
 *
 * Note this block is deliberately absent from `FormattedResult.rawText` — `agent_review`
 * parses rawText precisely because this trailer would otherwise corrupt JSON extraction.
 */
export function appendToolCallsBlock(
  summary: string,
  toolCalls: FormattedResult['toolCalls']
): string {
  if (toolCalls.length === 0) return summary;

  let output = `${summary}\n\n### Tool Calls Executed (${toolCalls.length}):\n`;
  for (const tc of toolCalls) {
    output += `- \`${tc.name}\`: ${JSON.stringify(tc.input)}\n`;
  }
  return output;
}
