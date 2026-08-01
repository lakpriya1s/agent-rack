import { describe, it, expect } from 'vitest';
import { extractAndValidateReview, ReviewOutputSchema, getReadOnlyMode, buildReviewPrompt } from './review.js';

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
});

describe('getReadOnlyMode', () => {
  it('maps codex_exec_json to read-only sandbox mode', () => {
    expect(getReadOnlyMode('codex_exec_json')).toBe('read-only');
  });

  it('maps claude_stream_json to plan mode', () => {
    expect(getReadOnlyMode('claude_stream_json')).toBe('plan');
  });

  it('returns undefined for transports without a native read-only mode', () => {
    expect(getReadOnlyMode('agy_stream')).toBeUndefined();
    expect(getReadOnlyMode('pty_interactive')).toBeUndefined();
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
  });
});
