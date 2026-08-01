import { AgentAdapter } from './base.js';
import { ClaudeStreamJsonAdapter } from './claude.js';
import { AgyStreamAdapter } from './agy.js';
import { PtyTerminalAdapter } from './pty.js';
import { CodexExecJsonAdapter } from './codex.js';
import { AgentConfig } from '../config/schema.js';

export * from './base.js';
export * from './claude.js';
export * from './agy.js';
export * from './pty.js';
export * from './codex.js';

export function createAdapter(agentConfig: AgentConfig): AgentAdapter {
  switch (agentConfig.transport) {
    case 'claude_stream_json':
      return new ClaudeStreamJsonAdapter(agentConfig.args);
    case 'agy_stream':
      return new AgyStreamAdapter(agentConfig.args);
    case 'pty_interactive':
      return new PtyTerminalAdapter(agentConfig.args);
    case 'codex_exec_json':
      return new CodexExecJsonAdapter(agentConfig.args);
    default:
      throw new Error(`Unsupported transport type: ${agentConfig.transport}`);
  }
}
