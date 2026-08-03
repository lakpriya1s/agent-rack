import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDefaultConfig } from '../config/loader.js';
import { SessionManager } from '../engine/session.js';
import { waitForSessionCompletion } from '../test-helpers/session.js';
import { registerUnifiedTools } from './unified.js';
import { fingerprintAgentMCPConfig } from '../config/fingerprint.js';

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
      expect(sessionManager.listSessions()).toHaveLength(1);
      expect(sessionManager.listSessions()[0].status).toBe('completed');
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

describe('agent_server_identity tool', () => {
  it('exposes agent-rack identity and the effective config fingerprint', async () => {
    const config = getDefaultConfig('/tmp/agent-rack-identity');
    const tools = registerUnifiedTools(config, new SessionManager(config));
    const identityTool = tools.find((tool) => tool.name === 'agent_server_identity');

    expect(identityTool).toBeDefined();
    const response = await identityTool!.handler({});
    expect(JSON.parse((response.content as any)[0].text)).toEqual({
      server: 'agent-rack',
      identityVersion: 1,
      configFingerprint: fingerprintAgentMCPConfig(config),
      launchMetadata: {
        agents: Object.keys(config.agents),
        allowedWorkspaces: config.allowedWorkspaces,
      },
    });
  });
});

describe('agent_session_create', () => {
  /**
   * `kind: 'review'` used to be accepted here, producing a session the dashboard displayed as a
   * review while it ran with ordinary write authority — none of agent_review's read-only mode,
   * escape-hatch stripping, or git precheck applied. Only agent_review may mint a review now.
   */
  it('ignores a caller-supplied kind and always creates a task session', async () => {
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

      expect(sessionInfo.kind).toBe('task');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not advertise a kind parameter at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-unified-tool-'));
    try {
      const config = getDefaultConfig(dir);
      const tools = registerUnifiedTools(config, new SessionManager(config));
      const schema = tools.find((t) => t.name === 'agent_session_create')!.inputSchema as {
        properties: Record<string, unknown>;
      };

      expect(schema.properties.kind).toBeUndefined();
      // The README promised agent_session_create took the same execution params as agent_run,
      // but timeoutSeconds was missing from the schema entirely.
      expect(schema.properties.timeoutSeconds).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours a per-session timeoutSeconds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-unified-tool-'));
    try {
      const config = getDefaultConfig(dir);
      config.agents['echoer'] = echoArgsAgentConfig(dir);
      const sessionManager = new SessionManager(config);
      const created: Array<Record<string, unknown> | undefined> = [];
      const original = sessionManager.createSession.bind(sessionManager);
      sessionManager.createSession = ((agentId, prompt, workspace, mode, options) => {
        created.push(options as Record<string, unknown>);
        return original(agentId, prompt, workspace, mode, options);
      }) as typeof sessionManager.createSession;

      const tools = registerUnifiedTools(config, sessionManager);
      await tools
        .find((t) => t.name === 'agent_session_create')!
        .handler({ agent: 'echoer', prompt: 'hi', workspace: dir, timeoutSeconds: 42 });

      expect(created[0]?.timeoutSeconds).toBe(42);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
