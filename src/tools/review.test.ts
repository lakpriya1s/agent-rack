import { describe, it, expect, vi } from 'vitest';
import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDefaultConfig } from '../config/loader.js';
import { SessionManager } from '../engine/session.js';
import { waitForSessionCompletion } from '../test-helpers/session.js';
import { registerReviewTools } from './review.js';

async function makeTempGitRepoWithChange(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-review-tool-'));
  await execa('git', ['init'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execa('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'changed.txt'), 'uncommitted change');
  return dir;
}

function fakeReviewerConfig(reviewPayload: Record<string, unknown>) {
  const jsonText = JSON.stringify(reviewPayload);
  return {
    name: 'Fake Reviewer',
    command: 'node',
    args: ['-e', `console.log(${JSON.stringify(jsonText)})`],
    transport: 'pty_interactive' as const,
    env: {},
  };
}

describe('agent_review tool', () => {
  it('returns a validated review synchronously', async () => {
    const dir = await makeTempGitRepoWithChange();
    try {
      const config = getDefaultConfig(dir);
      config.agents['fake_reviewer'] = fakeReviewerConfig({
        verdict: 'needs-attention',
        summary: 'Found one issue.',
        findings: [
          {
            severity: 'medium',
            title: 'Missing null check',
            body: 'Guard against null input.',
            file: 'changed.txt',
            line_start: 1,
            line_end: 1,
            confidence: 0.7,
            recommendation: 'Add a null check.',
          },
        ],
        next_steps: ['Add the null check.'],
      });
      const sessionManager = new SessionManager(config);
      const [reviewTool] = registerReviewTools(config, sessionManager);

      const response = await reviewTool.handler({ agent: 'fake_reviewer', workspace: dir });
      const review = JSON.parse((response.content as any)[0].text);

      expect(review.verdict).toBe('needs-attention');
      expect(review.findings).toHaveLength(1);
      expect(review.findings[0].file).toBe('changed.txt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('short-circuits with an approve verdict when there is nothing to review', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-review-empty-'));
    await execa('git', ['init'], { cwd: dir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
    await execa('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir });

    try {
      const config = getDefaultConfig(dir);
      config.agents['fake_reviewer'] = fakeReviewerConfig({
        verdict: 'needs-attention',
        summary: 'should not be reached',
        findings: [],
        next_steps: [],
      });
      const sessionManager = new SessionManager(config);
      const [reviewTool] = registerReviewTools(config, sessionManager);

      const response = await reviewTool.handler({ agent: 'fake_reviewer', workspace: dir });
      const review = JSON.parse((response.content as any)[0].text);

      expect(review.verdict).toBe('approve');
      expect(review.summary).toBe('Nothing to review.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs in the background and surfaces the parsed review via the session', async () => {
    const dir = await makeTempGitRepoWithChange();
    try {
      const config = getDefaultConfig(dir);
      config.agents['fake_reviewer'] = fakeReviewerConfig({
        verdict: 'approve',
        summary: 'Looks fine.',
        findings: [],
        next_steps: [],
      });
      const sessionManager = new SessionManager(config);
      const [reviewTool] = registerReviewTools(config, sessionManager);

      const response = await reviewTool.handler({ agent: 'fake_reviewer', workspace: dir, background: true });
      const sessionInfo = JSON.parse((response.content as any)[0].text);
      expect(sessionInfo.sessionId).toBeDefined();

      const completed = await waitForSessionCompletion(sessionManager, sessionInfo.sessionId);
      expect(completed.getInfo().review?.verdict).toBe('approve');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on an invalid scope value instead of silently reviewing the working tree', async () => {
    const dir = await makeTempGitRepoWithChange();
    try {
      const config = getDefaultConfig(dir);
      config.agents['fake_reviewer'] = fakeReviewerConfig({
        verdict: 'approve',
        summary: 'x',
        findings: [],
        next_steps: [],
      });
      const sessionManager = new SessionManager(config);
      const [reviewTool] = registerReviewTools(config, sessionManager);

      await expect(
        reviewTool.handler({ agent: 'fake_reviewer', workspace: dir, scope: 'brnach' })
      ).rejects.toThrow(/scope must be 'working-tree' or 'branch'/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips the escape-hatch flag when a native read-only mode is requested (sync)', async () => {
    const dir = await makeTempGitRepoWithChange();
    try {
      const config = getDefaultConfig(dir);
      // Echo the received argv back as the agent's text output so we can inspect it.
      // A script file (not `node -e`) is required so node stops parsing its own options
      // and forwards flags like `--sandbox` to the script untouched.
      const echoScript = path.join(dir, 'echo-args.cjs');
      fs.writeFileSync(
        echoScript,
        "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: process.argv.slice(2).join(' ') } }));\n"
      );
      config.agents['codexish'] = {
        name: 'Codex-ish',
        command: 'node',
        args: [echoScript, '--dangerously-bypass-approvals-and-sandbox'],
        transport: 'codex_exec_json' as const,
        env: {},
      };
      const sessionManager = new SessionManager(config);
      const [reviewTool] = registerReviewTools(config, sessionManager);

      const response = await reviewTool.handler({ agent: 'codexish', workspace: dir });
      const review = JSON.parse((response.content as any)[0].text);

      // No valid review JSON came back, so the raw agent text is preserved in `raw`.
      expect(review.parseError).toBe(true);
      expect(review.raw).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(review.raw).toContain('--sandbox read-only');
      // The configured agent entry itself must not be mutated.
      expect(config.agents['codexish'].args).toContain('--dangerously-bypass-approvals-and-sandbox');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends --model <value> to the spawned args when model is given (sync)', async () => {
    const dir = await makeTempGitRepoWithChange();
    try {
      const config = getDefaultConfig(dir);
      const echoScript = path.join(dir, 'echo-args.cjs');
      fs.writeFileSync(
        echoScript,
        "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: process.argv.slice(2).join(' ') } }));\n"
      );
      config.agents['codexish'] = {
        name: 'Codex-ish',
        command: 'node',
        args: [echoScript],
        transport: 'codex_exec_json' as const,
        env: {},
      };
      const sessionManager = new SessionManager(config);
      const [reviewTool] = registerReviewTools(config, sessionManager);

      const response = await reviewTool.handler({ agent: 'codexish', workspace: dir, model: 'gpt-5.5' });
      const review = JSON.parse((response.content as any)[0].text);

      expect(review.raw).toContain('--model gpt-5.5');
      // The configured agent entry itself must not be mutated.
      expect(config.agents['codexish'].args).not.toContain('--model');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('threads timeoutSeconds through to the background session', async () => {
    const dir = await makeTempGitRepoWithChange();
    try {
      const config = getDefaultConfig(dir);
      config.agents['fake_reviewer'] = fakeReviewerConfig({
        verdict: 'approve',
        summary: 'ok',
        findings: [],
        next_steps: [],
      });
      const sessionManager = new SessionManager(config);
      const [reviewTool] = registerReviewTools(config, sessionManager);

      const createSpy = vi.spyOn(sessionManager, 'createSession');

      await reviewTool.handler({
        agent: 'fake_reviewer',
        workspace: dir,
        background: true,
        timeoutSeconds: 42,
      });

      const options = createSpy.mock.calls[0][4];
      expect(options?.timeoutSeconds).toBe(42);
      expect(options?.kind).toBe('review');
      // pty_interactive has no native read-only mode and no model override was requested,
      // so the override is a no-op — same args as the configured agent.
      expect(options?.agentConfigOverride?.args).toEqual(config.agents['fake_reviewer'].args);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when scope is branch and baseRef is missing', async () => {
    const dir = await makeTempGitRepoWithChange();
    try {
      const config = getDefaultConfig(dir);
      config.agents['fake_reviewer'] = fakeReviewerConfig({
        verdict: 'approve',
        summary: 'x',
        findings: [],
        next_steps: [],
      });
      const sessionManager = new SessionManager(config);
      const [reviewTool] = registerReviewTools(config, sessionManager);

      await expect(
        reviewTool.handler({ agent: 'fake_reviewer', workspace: dir, scope: 'branch' })
      ).rejects.toThrow(/baseRef is required/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
