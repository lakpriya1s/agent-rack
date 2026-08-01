import { z } from 'zod';

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
