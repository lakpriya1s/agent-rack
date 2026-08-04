import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertSafeGitRef,
  extractAndValidateReview,
  normalizeReview,
  resolveBaseRefToSha,
  ReviewOutputSchema,
  buildReviewPrompt,
  hasChangesToReview,
} from './review.js';
import { ClaudeStreamJsonAdapter } from '../adapters/claude.js';
import { CodexExecJsonAdapter } from '../adapters/codex.js';
import { AgentConfig } from '../config/schema.js';

describe('ReviewOutputSchema', () => {
  it('accepts a fully valid review object', () => {
    const valid = {
      verdict: 'needs-attention',
      summary: 'Found one issue.',
      findings: [
        {
          severity: 'medium',
          title: 'Missing null check',
          body: 'The function does not guard against null input.',
          file: 'src/example.ts',
          line_start: 10,
          line_end: 12,
          confidence: 0.8,
          recommendation: 'Add a null check before use.',
        },
      ],
      next_steps: ['Add the null check and re-run tests.'],
    };

    const result = ReviewOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects an object with an invalid severity value', () => {
    const invalid = {
      verdict: 'approve',
      summary: 'Looks fine.',
      findings: [
        {
          severity: 'catastrophic',
          title: 'x',
          body: 'x',
          file: 'x.ts',
          line_start: 1,
          line_end: 1,
          confidence: 0.5,
          recommendation: 'x',
        },
      ],
      next_steps: [],
    };

    const result = ReviewOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('accepts line_start/line_end of 0 for whole-file or deleted-file findings', () => {
    const wholeFileFinding = {
      verdict: 'needs-attention',
      summary: 'Architectural concern.',
      findings: [
        {
          severity: 'high',
          title: 'Module deleted without migration',
          body: 'The file was removed entirely; no single line applies.',
          file: 'src/legacy.ts',
          line_start: 0,
          line_end: 0,
          confidence: 0.9,
          recommendation: 'Document the migration path.',
        },
      ],
      next_steps: ['Write a migration note.'],
    };

    const result = ReviewOutputSchema.safeParse(wholeFileFinding);
    expect(result.success).toBe(true);
  });

  it('still rejects negative line numbers', () => {
    const negative = {
      verdict: 'approve',
      summary: 'x',
      findings: [
        {
          severity: 'low',
          title: 'x',
          body: 'x',
          file: 'x.ts',
          line_start: -1,
          line_end: 1,
          confidence: 0.5,
          recommendation: 'x',
        },
      ],
      next_steps: [],
    };

    expect(ReviewOutputSchema.safeParse(negative).success).toBe(false);
  });
});

describe('extractAndValidateReview', () => {
  it('parses a bare JSON object', () => {
    const raw = JSON.stringify({
      verdict: 'approve',
      summary: 'All good.',
      findings: [],
      next_steps: [],
    });

    const review = extractAndValidateReview(raw);
    expect(review.parseError).toBeUndefined();
    expect(review.verdict).toBe('approve');
    expect(review.summary).toBe('All good.');
  });

  it('parses JSON wrapped in a markdown code fence', () => {
    const payload = {
      verdict: 'needs-attention',
      summary: 'One issue found.',
      findings: [],
      next_steps: ['Fix it.'],
    };
    const raw = 'Here is my review:\n\n```json\n' + JSON.stringify(payload) + '\n```\n';

    const review = extractAndValidateReview(raw);
    expect(review.parseError).toBeUndefined();
    expect(review.verdict).toBe('needs-attention');
    expect(review.next_steps).toEqual(['Fix it.']);
  });

  it('falls back to a parseError result when no valid JSON is present', () => {
    const raw = 'The agent forgot to return JSON entirely.';

    const review = extractAndValidateReview(raw);
    expect(review.parseError).toBe(true);
    expect(review.verdict).toBe('needs-attention');
    expect(review.findings).toEqual([]);
    expect(review.raw).toBe(raw);
  });

  it('falls back to a parseError result when JSON is present but fails schema validation', () => {
    const raw = JSON.stringify({ verdict: 'approve', summary: 'x' }); // missing findings/next_steps

    const review = extractAndValidateReview(raw);
    expect(review.parseError).toBe(true);
    expect(review.raw).toBe(raw);
  });

  it('recovers the review when a tool-calls block with JSON is appended after it', () => {
    const payload = {
      verdict: 'needs-attention',
      summary: 'Found an issue.',
      findings: [],
      next_steps: ['Fix it.'],
    };
    const raw =
      JSON.stringify(payload) +
      '\n\n### Tool Calls Executed (2):\n' +
      '- `shell`: {"command":["bash","-lc","git status"]}\n' +
      '- `shell`: {"command":["bash","-lc","git diff"]}\n';

    const review = extractAndValidateReview(raw);
    expect(review.parseError).toBeUndefined();
    expect(review.verdict).toBe('needs-attention');
    expect(review.next_steps).toEqual(['Fix it.']);
  });

  it('recovers the review from a later fenced block when an earlier fence holds other JSON', () => {
    const payload = {
      verdict: 'approve',
      summary: 'All clear.',
      findings: [],
      next_steps: [],
    };
    const raw =
      'First, here is the diff I inspected:\n\n```json\n{"files":["a.ts"],"insertions":3}\n```\n\n' +
      'And here is my review:\n\n```json\n' +
      JSON.stringify(payload) +
      '\n```\n\nLet me know if you want more detail.';

    const review = extractAndValidateReview(raw);
    expect(review.parseError).toBeUndefined();
    expect(review.verdict).toBe('approve');
    expect(review.summary).toBe('All clear.');
  });

  it('recovers the review when an echoed fence-heavy diff leaves an odd number of ``` markers', () => {
    // Reproduces a real opencode review of a README change: the agent echoed diff hunks that
    // themselves contained ``` fences, so sequential open/close pairing desynchronized and the
    // review's own ```json opener was left unpaired — its payload belonged to no block at all.
    const payload = {
      verdict: 'approve',
      summary: 'Docs only.',
      findings: [],
      next_steps: [],
    };
    const raw =
      '### Fixed\ndiff --git a/README.md b/README.md\n' +
      '@@ -1,3 +1,4 @@\n+```sh\n+npx agent-rack setup\n+```\n' +
      '@@ -40,2 +41,3 @@\n+```json\n+{ "mcpServers": { "agent-rack": {} } }\n' +
      '\nHere is my review:\n\n```json\n' +
      JSON.stringify(payload, null, 2) +
      '\n```\n';

    // The precondition that used to break extraction: an odd marker count, and a `{` from the
    // echoed diff sitting far ahead of the payload's own.
    expect((raw.match(/```/g) ?? []).length % 2).toBe(1);
    expect(raw.indexOf('{')).toBeLessThan(raw.indexOf('"verdict"'));

    const review = extractAndValidateReview(raw);
    expect(review.parseError).toBeUndefined();
    expect(review.verdict).toBe('approve');
    expect(review.summary).toBe('Docs only.');
  });

  it('anchors on the payload brace when unrelated JSON objects precede it, unfenced', () => {
    const payload = {
      verdict: 'needs-attention',
      summary: 'One issue.',
      findings: [],
      next_steps: ['Fix it.'],
    };
    const raw =
      '$ cat package.json\n{ "name": "agent-rack", "version": "0.10.4" }\n' +
      '$ git log --oneline\n{ not json at all\n' +
      JSON.stringify(payload);

    const review = extractAndValidateReview(raw);
    expect(review.parseError).toBeUndefined();
    expect(review.verdict).toBe('needs-attention');
    expect(review.next_steps).toEqual(['Fix it.']);
  });

  it('recovers the review with both leading and trailing prose and no fences', () => {
    const payload = {
      verdict: 'approve',
      summary: 'Nothing blocking.',
      findings: [],
      next_steps: [],
    };
    const raw = `I reviewed the working tree.\n${JSON.stringify(payload)}\nThat concludes my review.`;

    const review = extractAndValidateReview(raw);
    expect(review.parseError).toBeUndefined();
    expect(review.summary).toBe('Nothing blocking.');
  });
});

describe('extractAndValidateReview against real adapter output', () => {
  it('parses a claude_stream_json review whose summary carries an appended tool-calls block', () => {
    const payload = {
      verdict: 'needs-attention',
      summary: 'One high-severity issue.',
      findings: [
        {
          severity: 'high',
          title: 'Unvalidated input',
          body: 'The handler trusts caller-supplied paths.',
          file: 'src/tools/review.ts',
          line_start: 66,
          line_end: 66,
          confidence: 0.8,
          recommendation: 'Validate the workspace path.',
        },
      ],
      next_steps: ['Add validation.'],
    };

    const adapter = new ClaudeStreamJsonAdapter();
    const chunk =
      JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'git status --short' } }) + '\n' +
      JSON.stringify({ type: 'tool_result', output: ' M src/tools/review.ts\n' }) + '\n' +
      JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'git diff' } }) + '\n' +
      JSON.stringify({ type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' }) + '\n';

    const events = adapter.parseChunk(chunk);
    const result = adapter.formatResponse(events, 0);

    // Sanity: the appended block really is in summary and really is not in rawText.
    expect(result.summary).toContain('### Tool Calls Executed');
    expect(result.rawText).not.toContain('### Tool Calls Executed');

    const review = extractAndValidateReview(result.rawText);
    expect(review.parseError).toBeUndefined();
    expect(review.verdict).toBe('needs-attention');
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].file).toBe('src/tools/review.ts');
  });

  it('parses a codex_exec_json review whose summary carries an appended tool-calls block', () => {
    const payload = {
      verdict: 'approve',
      summary: 'No blocking issues.',
      findings: [],
      next_steps: [],
    };

    const adapter = new CodexExecJsonAdapter();
    const chunk =
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n' +
      JSON.stringify({
        type: 'item.started',
        item: { id: 'i1', type: 'command_execution', command: 'git status --short', status: 'in_progress' },
      }) + '\n' +
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'command_execution', command: 'git status --short', aggregated_output: ' M a.ts\n', exit_code: 0 },
      }) + '\n' +
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i2', type: 'agent_message', text: JSON.stringify(payload) },
      }) + '\n' +
      JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n';

    const events = adapter.parseChunk(chunk);
    const result = adapter.formatResponse(events, 0);

    expect(result.summary).toContain('### Tool Calls Executed');
    expect(result.rawText).not.toContain('### Tool Calls Executed');

    const review = extractAndValidateReview(result.rawText);
    expect(review.parseError).toBeUndefined();
    expect(review.verdict).toBe('approve');
    expect(review.summary).toBe('No blocking issues.');
  });
});

describe('buildReviewPrompt', () => {
  it('builds a standard working-tree review prompt', () => {
    const prompt = buildReviewPrompt({
      scope: 'working-tree',
      adversarial: false,
      readOnlyEnforced: true,
    });

    expect(prompt).toContain('working-tree');
    expect(prompt).toContain('git status');
    expect(prompt).toContain('"verdict"');
    expect(prompt).not.toContain('ADVERSARIAL');
  });

  it('builds a branch-scoped review prompt referencing the base ref', () => {
    const prompt = buildReviewPrompt({
      scope: 'branch',
      baseRef: 'main',
      adversarial: false,
      readOnlyEnforced: true,
    });

    expect(prompt).toContain('main');
    expect(prompt).toContain('git diff');
  });

  it('builds an adversarial prompt including the focus text', () => {
    const prompt = buildReviewPrompt({
      scope: 'working-tree',
      adversarial: true,
      focus: 'challenge the retry logic',
      readOnlyEnforced: true,
    });

    expect(prompt).toContain('ADVERSARIAL');
    expect(prompt).toContain('challenge the retry logic');
  });

  it('adds an explicit no-write instruction when read-only is not natively enforced', () => {
    const prompt = buildReviewPrompt({
      scope: 'working-tree',
      adversarial: false,
      readOnlyEnforced: false,
    });

    expect(prompt).toContain('MUST be read-only');
    expect(prompt).not.toContain('read-only by configuration');
  });

  it('keeps the explicit no-write instruction even when read-only IS natively enforced', () => {
    const prompt = buildReviewPrompt({
      scope: 'working-tree',
      adversarial: false,
      readOnlyEnforced: true,
    });

    expect(prompt).toContain('MUST be read-only');
    expect(prompt).toContain('read-only by configuration');
  });
});

async function makeTempGitRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-review-'));
  await execa('git', ['init'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execa('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: dir });
  return dir;
}

describe('hasChangesToReview', () => {
  it('returns false for working-tree scope with no changes', async () => {
    const dir = await makeTempGitRepo();
    try {
      const result = await hasChangesToReview({ workspace: dir, scope: 'working-tree' });
      expect(result).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true for working-tree scope with an untracked file', async () => {
    const dir = await makeTempGitRepo();
    try {
      fs.writeFileSync(path.join(dir, 'new-file.txt'), 'hello');
      const result = await hasChangesToReview({ workspace: dir, scope: 'working-tree' });
      expect(result).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true for branch scope when HEAD differs from baseRef', async () => {
    const dir = await makeTempGitRepo();
    try {
      const { stdout: baseRef } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'change.txt'), 'change');
      await execa('git', ['add', '.'], { cwd: dir });
      await execa('git', ['commit', '-m', 'second commit'], { cwd: dir });

      const result = await hasChangesToReview({ workspace: dir, scope: 'branch', baseRef });
      expect(result).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for branch scope when HEAD equals baseRef', async () => {
    const dir = await makeTempGitRepo();
    try {
      const result = await hasChangesToReview({ workspace: dir, scope: 'branch', baseRef: 'HEAD' });
      expect(result).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when scope is branch and baseRef is missing', async () => {
    const dir = await makeTempGitRepo();
    try {
      await expect(hasChangesToReview({ workspace: dir, scope: 'branch' })).rejects.toThrow(/baseRef is required/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
