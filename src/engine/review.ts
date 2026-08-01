import { z } from 'zod';
import { AgentTransportType } from '../config/schema.js';

export const ReviewFindingSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().min(1),
  body: z.string().min(1),
  file: z.string().min(1),
  line_start: z.number().int().min(1),
  line_end: z.number().int().min(1),
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

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}

function extractOutermostJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
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
  const candidateText = extractOutermostJsonObject(stripCodeFences(rawText));
  if (!candidateText) {
    return parseErrorFallback(rawText);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidateText);
  } catch {
    return parseErrorFallback(rawText);
  }

  const result = ReviewOutputSchema.safeParse(parsedJson);
  if (!result.success) {
    return parseErrorFallback(rawText);
  }

  return result.data;
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

  const readOnlyInstruction = options.readOnlyEnforced
    ? 'This review is read-only by configuration.'
    : 'This review MUST be read-only: do not modify, create, or delete any files. Only inspect the repository and report findings.';

  return `${stanceBlock}

${scopeInstruction}

${readOnlyInstruction}

${REVIEW_JSON_CONTRACT}`;
}
