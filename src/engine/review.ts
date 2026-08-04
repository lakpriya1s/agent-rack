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

/** Cap on fence markers considered, so a reply full of code blocks can't explode the search. */
const MAX_FENCE_MARKERS = 24;

/** Index just past a fence marker's language tag and newline, where its content begins. */
function fenceContentStart(text: string, marker: number): number {
  const newline = text.indexOf('\n', marker);
  return newline === -1 ? text.length : newline + 1;
}

/**
 * Collects candidate payloads from every markdown fence in `text`.
 *
 * Agents routinely emit prose, then a ```json fence, then more prose; and adapters append their
 * own trailing blocks (e.g. "### Tool Calls Executed"), so the first fence is not necessarily
 * the right one. Sequential open/close pairing is not enough either: a review that echoes a diff
 * of a fence-heavy file (a README, say) emits an *odd* number of ``` markers, which
 * desynchronizes the pairing and can leave the review's own ```json opener without a partner —
 * its payload then belongs to no block at all. So every marker is treated as a potential opener
 * on its own, taking both the text up to the next marker and the text through the end of the
 * reply.
 */
function collectFencedBlocks(text: string): string[] {
  const markers: number[] = [];
  for (let i = text.indexOf('```'); i !== -1; i = text.indexOf('```', i + 3)) {
    markers.push(i);
  }

  // Keep the *last* markers: the review payload is the agent's final word, so dropping early
  // blocks costs less than dropping late ones.
  const considered = markers.slice(-MAX_FENCE_MARKERS);

  const blocks: string[] = [];
  considered.forEach((marker, index) => {
    const contentStart = fenceContentStart(text, marker);
    const next = considered[index + 1];
    if (next !== undefined && next > contentStart) {
      blocks.push(text.slice(contentStart, next));
    }
    blocks.push(text.slice(contentStart));
  });

  return blocks;
}

// Guards against pathological O(n^2) scanning on very large outputs.
const MAX_JSON_END_ATTEMPTS_PER_START = 50;
const MAX_JSON_ATTEMPTS_TOTAL = 400;
/** Cap on distinct `{` anchors tried, so start × end scanning stays bounded. */
const MAX_JSON_START_ATTEMPTS = 12;

/**
 * Candidate opening braces for the payload, best first.
 *
 * The first `{` in the reply is usually the payload's — but not when the agent echoes a diff or
 * a config snippet before answering, in which case that brace belongs to something else
 * entirely and no choice of closing brace can rescue it. `verdict` is required by the schema, so
 * a `{` preceding an occurrence of it is a far better anchor, and the *last* such occurrence
 * best of all (the payload is the agent's final word).
 */
function candidateStartIndices(text: string): number[] {
  const starts: number[] = [];
  const push = (index: number): void => {
    if (index !== -1 && !starts.includes(index) && starts.length < MAX_JSON_START_ATTEMPTS) {
      starts.push(index);
    }
  };

  const verdicts: number[] = [];
  for (let i = text.indexOf('"verdict"'); i !== -1; i = text.indexOf('"verdict"', i + 1)) {
    verdicts.push(i);
  }

  for (const verdict of verdicts.reverse()) {
    const brace = text.lastIndexOf('{', verdict);
    push(brace);
    // One brace further back too, in case `verdict` sits after a nested object.
    if (brace > 0) push(text.lastIndexOf('{', brace - 1));
  }

  push(text.indexOf('{'));

  return starts;
}

/**
 * Searches `text` for a JSON object that both parses AND satisfies ReviewOutputSchema.
 * For each candidate opening brace it walks the closing brace backwards from the last `}`, so
 * neither leading prose (an echoed diff) nor trailing prose (an appended tool-calls block)
 * defeats extraction.
 */
function findValidReviewObject(text: string): ReviewOutput | null {
  let total = 0;

  for (const start of candidateStartIndices(text)) {
    let end = text.lastIndexOf('}');
    let attempts = 0;

    while (end > start && attempts < MAX_JSON_END_ATTEMPTS_PER_START) {
      if (total >= MAX_JSON_ATTEMPTS_TOTAL) return null;
      attempts++;
      total++;
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
