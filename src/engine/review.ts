import { z } from 'zod';
import { execa } from 'execa';
import { AgentConfig, AgentTransportType } from '../config/schema.js';

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

function parseErrorFallback(rawText: string): ReviewOutput {
  return {
    verdict: 'needs-attention',
    summary: rawText,
    findings: [],
    next_steps: [],
    parseError: true,
    raw: rawText,
  };
}

export function extractAndValidateReview(rawText: string): ReviewOutput {
  // Try each fenced block first (most agents wrap the payload in ```json), then the
  // whole raw text. The first candidate that parses AND validates wins.
  const candidates = [...collectFencedBlocks(rawText), rawText];

  for (const candidate of candidates) {
    const review = findValidReviewObject(candidate);
    if (review) {
      return review;
    }
  }

  return parseErrorFallback(rawText);
}

export function getReadOnlyMode(transport: AgentTransportType): string | undefined {
  switch (transport) {
    case 'codex_exec_json':
      return 'read-only';
    case 'claude_stream_json':
      return 'plan';
    default:
      return undefined;
  }
}

/**
 * Maps a transport to the "escape hatch" CLI flag that disables its sandbox/permission
 * enforcement. These live in the default agent configs (so normal `agent_run` tasks can
 * actually edit files), but they nullify the read-only flags `agent_review` requests.
 */
const ESCAPE_HATCH_ARGS: Partial<Record<AgentTransportType, string>> = {
  claude_stream_json: '--dangerously-skip-permissions',
  codex_exec_json: '--dangerously-bypass-approvals-and-sandbox',
};

/**
 * Returns a shallow copy of `agentConfig` with the transport's escape-hatch flag removed
 * from `args`. Transports with no known escape hatch are returned unchanged.
 */
export function stripEscapeHatchArgs(agentConfig: AgentConfig): AgentConfig {
  const escapeHatch = ESCAPE_HATCH_ARGS[agentConfig.transport];
  if (!escapeHatch || !agentConfig.args.includes(escapeHatch)) {
    return agentConfig;
  }

  return {
    ...agentConfig,
    args: agentConfig.args.filter((arg) => arg !== escapeHatch),
  };
}

export interface ReviewPromptOptions {
  scope: 'working-tree' | 'branch';
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
      ? `Review the changes on the current branch compared to the base ref \`${options.baseRef}\`. Run \`git diff ${options.baseRef}...HEAD\` yourself to see the full diff.`
      : `Review the current uncommitted working-tree changes. Run \`git status\` and \`git diff\` (including \`--cached\`) yourself to see what changed.`;

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
    options.readOnlyEnforced ? 'This review is read-only by configuration.' : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `${stanceBlock}

${scopeInstruction}

${readOnlyInstruction}

${REVIEW_JSON_CONTRACT}`;
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
    const { stdout } = await execa('git', ['diff', '--shortstat', `${baseRef}...HEAD`], { cwd: workspace });
    return stdout.trim().length > 0;
  }

  // `git status --short --untracked-files=all` already reports staged, unstaged, and
  // untracked changes, so the extra `git diff --shortstat` calls were redundant.
  const { stdout } = await execa('git', ['status', '--short', '--untracked-files=all'], { cwd: workspace });
  return stdout.trim().length > 0;
}
