import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDefaultConfig } from '../config/loader.js';
import { SessionManager } from '../engine/session.js';
import { waitForSessionCompletion } from '../test-helpers/session.js';
import { registerUnifiedTools } from './unified.js';

function echoArgsAgentConfig(dir: string) {
  const echoScript = path.join(dir, 'echo-args.cjs');
  fs.writeFileSync(
    echoScript,
    "console.log(JSON.stringify({ type: 'assistant', text: process.argv.slice(2).join(' ') }));\n"
  );
  return {
    name: 'Echo Args',
    command: 'node',
    args: [echoScript],
    transport: 'claude_stream_json' as const,
    env: {},
  };
}

describe('agent_run tool', () => {
  it('appends --model <value> to the spawned args when model is given', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-unified-tool-'));
    try {
      const config = getDefaultConfig(dir);
      config.agents['echoer'] = echoArgsAgentConfig(dir);
      const sessionManager = new SessionManager(config);
      const [, agentRunTool] = registerUnifiedTools(config, sessionManager);

      const response = await agentRunTool.handler({
        agent: 'echoer',
        prompt: 'hello',
        workspace: dir,
        model: 'gpt-5.5',
      });

      expect((response.content as any)[0].text).toContain('--model gpt-5.5');
      // The configured agent entry itself must not be mutated.
      expect(config.agents['echoer'].args).not.toContain('--model');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the agent config default model when none is given at call time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-unified-tool-'));
    try {
      const config = getDefaultConfig(dir);
      config.agents['echoer'] = { ...echoArgsAgentConfig(dir), model: 'gpt-5.6-sol' };
      const sessionManager = new SessionManager(config);
      const [, agentRunTool] = registerUnifiedTools(config, sessionManager);

      const response = await agentRunTool.handler({ agent: 'echoer', prompt: 'hello', workspace: dir });

      expect((response.content as any)[0].text).toContain('--model gpt-5.6-sol');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent_session_create tool', () => {
  it('appends --model <value> for the background session when model is given', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-unified-tool-'));
    try {
      const config = getDefaultConfig(dir);
      config.agents['echoer'] = echoArgsAgentConfig(dir);
      const sessionManager = new SessionManager(config);
      const [, , sessionCreateTool] = registerUnifiedTools(config, sessionManager);

      const response = await sessionCreateTool.handler({
        agent: 'echoer',
        prompt: 'hello',
        workspace: dir,
        model: 'gpt-5.5',
      });
      const sessionInfo = JSON.parse((response.content as any)[0].text);

      const completed = await waitForSessionCompletion(sessionManager, sessionInfo.sessionId);
      expect(completed.getInfo().summary).toContain('--model gpt-5.5');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent_session_list tool', () => {
  it('lists every session with its kind, most recent first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-unified-tool-'));
    try {
      const config = getDefaultConfig(dir);
      config.agents['echoer'] = echoArgsAgentConfig(dir);
      const sessionManager = new SessionManager(config);
      const tools = registerUnifiedTools(config, sessionManager);
      const sessionCreateTool = tools.find((t) => t.name === 'agent_session_create')!;
      const sessionListTool = tools.find((t) => t.name === 'agent_session_list')!;

      const created = await sessionCreateTool.handler({ agent: 'echoer', prompt: 'hello', workspace: dir });
      const sessionInfo = JSON.parse((created.content as any)[0].text);
      await waitForSessionCompletion(sessionManager, sessionInfo.sessionId);

      const listed = await sessionListTool.handler({});
      const sessions = JSON.parse((listed.content as any)[0].text);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(sessionInfo.sessionId);
      expect(sessions[0].kind).toBe('task');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent_session_create tool kind param', () => {
  it('creates a review-kind session when kind: "review" is passed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-unified-tool-'));
    try {
      const config = getDefaultConfig(dir);
      config.agents['echoer'] = echoArgsAgentConfig(dir);
      const sessionManager = new SessionManager(config);
      const tools = registerUnifiedTools(config, sessionManager);
      const sessionCreateTool = tools.find((t) => t.name === 'agent_session_create')!;

      const response = await sessionCreateTool.handler({
        agent: 'echoer',
        prompt: 'hello',
        workspace: dir,
        kind: 'review',
      });
      const sessionInfo = JSON.parse((response.content as any)[0].text);

      expect(sessionInfo.kind).toBe('review');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
