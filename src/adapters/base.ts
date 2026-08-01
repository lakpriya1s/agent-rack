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

export interface AdapterOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentAdapter {
  readonly transportType: string;
  getCLIArgs(prompt: string, mode?: string): string[];
  parseChunk(chunk: string): ParsedAgentEvent[];
  formatResponse(events: ParsedAgentEvent[], exitCode?: number): FormattedResult;
}
