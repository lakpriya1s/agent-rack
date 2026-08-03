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

/**
 * How a transport receives its prompt. `argv` transports are one-shot: the prompt is a
 * command-line argument, the process runs to completion, and there is no channel to say
 * anything more to it.
 */
export type PromptTransport = 'argv' | 'stdin' | 'pty';

/**
 * What a transport can actually do, as opposed to what the MCP tool surface advertises.
 *
 * This exists because `agent_session_send` was described as a general capability while only
 * the PTY transport could ever honour it: stdio transports are spawned with `stdin: 'ignore'`
 * and their CLIs take the prompt as argv, so there is no second turn to send input to. Tools
 * consult these flags and refuse up front rather than failing deep inside the process layer.
 */
export interface AgentCapabilities {
  /** Accepts additional input after the run has started (a real second turn). */
  supportsFollowUp: boolean;
  /** Emits incremental events while running, rather than only a final blob. */
  supportsStreaming: boolean;
  /** The CLI itself can enforce a read-only/sandboxed run (not just prompt-level). */
  supportsNativeReadOnly: boolean;
  /** How the prompt reaches the process. */
  promptTransport: PromptTransport;
}

export interface AgentAdapter {
  readonly transportType: string;
  readonly capabilities: AgentCapabilities;
  getCLIArgs(prompt: string, mode?: string): string[];
  parseChunk(chunk: string): ParsedAgentEvent[];
  formatResponse(events: ParsedAgentEvent[], exitCode?: number): FormattedResult;
  /**
   * Emits any events still held in the adapter's line buffer once the stream has ended.
   *
   * Newline-delimited parsers keep an unterminated tail back waiting for its newline. A CLI
   * that exits without a trailing newline would otherwise lose its final line — which for a
   * single-JSON-object `--output-format json` run is the entire response.
   */
  flush(): ParsedAgentEvent[];
}

/**
 * Appends the human-readable tool-call manifest that JSON-stream adapters add to their
 * summary. Returns `summary` untouched when no tools ran.
 *
 * Note this block is deliberately absent from `FormattedResult.rawText` — `agent_review`
 * parses rawText precisely because this trailer would otherwise corrupt JSON extraction.
 */
/**
 * Joins the process's stderr lines, which `AgentProcessController` records as `status` events
 * tagged `stream: 'stderr'` rather than feeding through the protocol parser.
 *
 * Adapters use this only for their *fallback* summary: stderr must never enter `rawText` (it
 * would corrupt `agent_review`'s JSON extraction), but when a CLI produces no parseable output
 * at all, its stderr is usually the only explanation of why — dropping it would turn every
 * startup failure into a bare "completed with exit code 1".
 */
export function collectStderrText(events: ParsedAgentEvent[]): string {
  return events
    .filter((event) => event.type === 'status' && event.metadata?.stream === 'stderr')
    .map((event) => event.content)
    .join('\n')
    .trim();
}

/** Builds the fallback summary used when an agent produced no parseable text output. */
export function describeEmptyResult(
  events: ParsedAgentEvent[],
  exitCode: number,
  toolCallCount: number
): string {
  const stderr = collectStderrText(events);
  const base = `Execution completed with exit code ${exitCode}. Executed ${toolCallCount} tool calls.`;
  return stderr ? `${base}\n\nProcess stderr:\n${stderr}` : base;
}

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
