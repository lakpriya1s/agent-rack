import { z } from 'zod';
import { execa } from 'execa';
import { FormattedResult } from '../adapters/base.js';

export const ReviewFindingSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().min(1),
  body: z.string().min(1),
  file: z.string().min(1),
  // 0 means "no specific line" (whole-file, deleted-file, or architectural findings).
  // Requiring >= 1 caused an otherwise well-formed review to be discarded entirely.
  line_start: z.number().int().min(0),
  line_end: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  recommendation: z.string(),
});

export const ReviewOutputSchema = z.object({
  verdict: z.enum(['approve', 'needs-attention']),
  summary: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
  next_steps: z.array(z.string().min(1)),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewOutput = z.infer<typeof ReviewOutputSchema> & {
  parseError?: boolean;
  raw?: string;
};

/**
 * Collects the contents of every markdown-fenced block in `text`.
 * Agents routinely emit prose, then a ```json fence, then more prose; and adapters
 * append their own trailing blocks (e.g. "### Tool Calls Executed"), so we cannot
 * assume the first fence is the right one.
 */
function collectFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fenceRegex = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

// Guard against pathological O(n^2) scanning on very large outputs.
const MAX_JSON_END_ATTEMPTS = 200;

/**
 * Searches `text` for a JSON object that both parses AND satisfies ReviewOutputSchema.
 * Starts at the first `{` and walks the closing brace backwards from the last `}`,
 * so trailing non-JSON prose (or an appended tool-calls block) doesn't defeat extraction.
 */
function findValidReviewObject(text: string): ReviewOutput | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let end = text.lastIndexOf('}');
  let attempts = 0;

  while (end > start && attempts < MAX_JSON_END_ATTEMPTS) {
    attempts++;
    const candidate = text.slice(start, end + 1);

    try {
      const parsed = JSON.parse(candidate);
      const result = ReviewOutputSchema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
    } catch {
      // Not valid JSON at this boundary — try an earlier closing brace.
    }

    end = text.lastIndexOf('}', end - 1);
  }

  return null;
}

/** Cap on the raw text echoed back on a parse failure, so one runaway reply can't dominate. */
const MAX_RAW_FALLBACK_CHARS = 20_000;

function truncateRaw(rawText: string): string {
  if (rawText.length <= MAX_RAW_FALLBACK_CHARS) return rawText;
  return `${rawText.slice(0, MAX_RAW_FALLBACK_CHARS)}\n\n[truncated ${rawText.length - MAX_RAW_FALLBACK_CHARS} more characters]`;
}

function parseErrorFallback(rawText: string): ReviewOutput {
  const truncated = truncateRaw(rawText);
  return {
    verdict: 'needs-attention',
    summary: truncated,
    findings: [],
    next_steps: [],
    parseError: true,
    raw: truncated,
  };
}

/**
 * Repairs internally inconsistent reviews rather than rejecting them.
 *
 * Agents produce two contradictions often enough to matter: a reversed line range, and an
 * "approve" verdict sitting above findings they themselves called critical. Both are cheap to
 * fix and expensive to discard — failing schema validation here would throw away every finding
 * in the reply and fall back to raw text, which is strictly worse than correcting the verdict.
 */
export function normalizeReview(review: ReviewOutput): ReviewOutput {
  const findings = review.findings.map((finding) =>
    finding.line_end < finding.line_start ? { ...finding, line_end: finding.line_start } : finding
  );

  const hasBlocking = findings.some(
    (finding) => finding.severity === 'critical' || finding.severity === 'high'
  );
  const verdict = review.verdict === 'approve' && hasBlocking ? 'needs-attention' : review.verdict;

  return { ...review, findings, verdict };
}

export function extractAndValidateReview(rawText: string): ReviewOutput {
  // Try each fenced block first (most agents wrap the payload in ```json), then the
  // whole raw text. The first candidate that parses AND validates wins.
  const candidates = [...collectFencedBlocks(rawText), rawText];

  for (const candidate of candidates) {
    const review = findValidReviewObject(candidate);
    if (review) {
      return normalizeReview(review);
    }
  }

  return parseErrorFallback(rawText);
}

/**
 * Extracts the structured review from a completed agent run.
 *
 * Reads `rawText`, not `summary`: adapters append a "### Tool Calls Executed" block to
 * summary, which corrupts JSON extraction (the review prompt guarantees the agent runs git
 * commands, so there are always tool calls).
 */
export function reviewFromResult(result: FormattedResult): ReviewOutput {
  return extractAndValidateReview(result.rawText || result.summary);
}

export interface ReviewPromptOptions {
  scope: 'working-tree' | 'branch';
  /**
   * The commit SHA the diff is taken against, already resolved via `resolveBaseRefToSha`.
   * A SHA rather than the caller's ref string: this value is interpolated into a command the
   * sub-agent is told to run, so it must be one git produced, not one a client supplied.
   */
  baseRef?: string;
  adversarial: boolean;
  focus?: string;
  readOnlyEnforced: boolean;
}

const REVIEW_JSON_CONTRACT = `Return ONLY valid JSON matching this schema, with no prose before or after it:
{
  "verdict": "approve" | "needs-attention",
  "summary": string,
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": string,
      "body": string,
      "file": string,
      "line_start": number,
      "line_end": number,
      "confidence": number (0-1),
      "recommendation": string
    }
  ],
  "next_steps": string[]
}

Use "needs-attention" if there is any material issue worth blocking on. Use "approve" only if you found nothing worth blocking on.`;

export function buildReviewPrompt(options: ReviewPromptOptions): string {
  const scopeInstruction =
    options.scope === 'branch'
      ? `Review the changes on the current branch compared to base commit \`${options.baseRef}\`. Run \`git diff ${options.baseRef}...HEAD\` yourself to see the full diff.`
      : `Review the current uncommitted working-tree changes. Run \`git status --short --untracked-files=all\` and \`git diff\` (including \`--cached\`) yourself to see what changed. Untracked files are part of the change: read their contents too, since they will not appear in \`git diff\`.`;

  const stanceBlock = options.adversarial
    ? `You are performing an ADVERSARIAL review. Your job is to break confidence in the change, not validate it.
Default to skepticism. Assume the change can fail in subtle, high-cost, or user-visible ways until proven otherwise.
Prioritize: auth/permission/trust-boundary issues, data loss or corruption, rollback safety, race conditions and re-entrancy, empty/null/timeout/degraded-dependency behavior, and observability gaps.
Actively try to disprove the change rather than summarize it.${options.focus ? `\nUser focus: ${options.focus}` : ''}`
    : `Perform a standard code review. Look for correctness bugs, missing error handling, security issues, and test coverage gaps.`;

  // The explicit instruction is ALWAYS included: native read-only enforcement varies by
  // transport and CLI version, so prompt-level enforcement must never be dropped.
  const readOnlyInstruction = [
    'This review MUST be read-only: do not modify, create, or delete any files. Only inspect the repository and report findings.',
    options.readOnlyEnforced
      ? 'This review is read-only by configuration.'
      : 'Your runtime cannot enforce this, so complying is entirely your responsibility.',
  ].join('\n');

  return `${stanceBlock}

${scopeInstruction}

${readOnlyInstruction}

${REVIEW_JSON_CONTRACT}`;
}

/**
 * Conservative subset of git's legal ref characters. agent-rack's own git calls pass argument
 * arrays and are safe, but `baseRef` is also interpolated into the prompt as a command for the
 * sub-agent to run — and that agent will very likely execute it through a shell. Anything that
 * could terminate a command or start another one must never get that far.
 */
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export class InvalidGitRefError extends Error {
  constructor(ref: string) {
    super(
      `baseRef '${ref}' is not a valid git ref name. Use a plain branch, tag, or commit ` +
        `(letters, digits, '.', '_', '/', '-'), e.g. 'main' or 'origin/main'.`
    );
    this.name = 'InvalidGitRefError';
  }
}

export function assertSafeGitRef(ref: string): string {
  // `..` would turn a single ref into a range, and a leading '-' would be read as a flag.
  if (!SAFE_GIT_REF.test(ref) || ref.includes('..') || ref.endsWith('.lock')) {
    throw new InvalidGitRefError(ref);
  }
  return ref;
}

/**
 * Resolves a ref to an immutable commit SHA. The SHA — not the user-supplied string — is what
 * goes into the review prompt, so the sub-agent runs a command built from a value git itself
 * validated, and the review cannot shift under a concurrently-moving branch.
 */
export async function resolveBaseRefToSha(workspace: string, baseRef: string): Promise<string> {
  assertSafeGitRef(baseRef);

  try {
    const { stdout } = await execa('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
      cwd: workspace,
    });
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`git rev-parse returned an unexpected value for '${baseRef}': '${sha}'`);
    }
    return sha;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('git rev-parse returned')) throw error;
    throw new Error(
      `baseRef '${baseRef}' does not resolve to a commit in ${workspace}. ` +
        `Fetch it first, or pass a ref that exists locally.`
    );
  }
}

export interface GitPreCheckOptions {
  workspace: string;
  scope: 'working-tree' | 'branch';
  baseRef?: string;
}

export async function hasChangesToReview(options: GitPreCheckOptions): Promise<boolean> {
  const { workspace, scope, baseRef } = options;

  if (scope === 'branch') {
    if (!baseRef) {
      throw new Error("baseRef is required when scope is 'branch'.");
    }
    assertSafeGitRef(baseRef);
    const { stdout } = await execa('git', ['diff', '--shortstat', `${baseRef}...HEAD`], { cwd: workspace });
    return stdout.trim().length > 0;
  }

  // `git status --short --untracked-files=all` already reports staged, unstaged, and
  // untracked changes, so the extra `git diff --shortstat` calls were redundant.
  const { stdout } = await execa('git', ['status', '--short', '--untracked-files=all'], { cwd: workspace });
  return stdout.trim().length > 0;
}
