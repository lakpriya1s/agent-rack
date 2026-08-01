import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDefaultConfig } from '../config/loader.js';
import { SessionManager } from '../engine/session.js';
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

async function waitForSessionCompletion(manager: SessionManager, sessionId: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = manager.getSession(sessionId);
    if (session && session.status !== 'running') return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for session to complete');
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
