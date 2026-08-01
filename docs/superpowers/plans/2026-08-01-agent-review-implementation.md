# agent_review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `agent_review` MCP tool to agent-mcp that runs a read-only, structured code review (normal or adversarial) over the working tree or a branch diff, using any configured agent (claude, codex, opencode, agy), synchronously or in the background.

**Architecture:** New standalone review logic in `src/engine/review.ts` (schema, prompt building, read-only mode mapping, git pre-check, output parsing) consumed by a new tool file `src/tools/review.ts` (mirroring the existing `src/tools/unified.ts` pattern) and by an additive extension to `src/engine/session.ts` (session "kind" tagging so background reviews get parsed automatically). `src/server.ts` registers the new tool alongside the existing two.

**Tech Stack:** TypeScript (ESM), `zod` (already a dependency) for schema validation, `execa` (already a dependency) for git/subprocess calls, `vitest` for tests.

**Spec:** `docs/superpowers/specs/2026-08-01-agent-review-design.md`

## Global Constraints

- Use the existing `zod` dependency for schema validation — do not add new dependencies.
- All new/modified TypeScript files use ESM `.js`-suffixed relative imports, matching existing files (e.g. `import { X } from './y.js'`).
- Tests use real spawned processes (`node -e`, `git`, `echo`) rather than module mocking — nothing in this codebase currently uses `vi.mock`; follow that convention.
- Read-only mode mapping is exactly: `codex_exec_json` → `'read-only'`, `claude_stream_json` → `'plan'`, all other transports → `undefined`.
- `ReviewOutputSchema` field names are exactly: `verdict`, `summary`, `findings` (each with `severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`), `next_steps` — this is a public tool-output contract, match it verbatim.
- `SessionManager.createSession` stays backward compatible: the new options parameter is optional and its absence produces identical behavior to today (`kind` defaults to `'task'`).

---

### Task 1: Review output schema and JSON extraction/validation

**Files:**
- Create: `src/engine/review.ts`
- Test: `src/engine/review.test.ts`

**Interfaces:**
- Produces: `ReviewFindingSchema` (zod), `ReviewOutputSchema` (zod), `ReviewFinding` (type), `ReviewOutput` (type: `z.infer<typeof ReviewOutputSchema> & { parseError?: boolean; raw?: string }`), `extractAndValidateReview(rawText: string): ReviewOutput`.

- [ ] **Step 1: Write the failing tests**

Create `src/engine/review.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractAndValidateReview, ReviewOutputSchema } from './review.js';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/engine/review.test.ts`
Expected: FAIL — `src/engine/review.ts` does not exist / exports are undefined.

- [ ] **Step 3: Implement the schema and extraction logic**

Create `src/engine/review.ts`:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/engine/review.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine/review.ts src/engine/review.test.ts
git commit -m "feat: add review output schema and JSON extraction"
```

---

### Task 2: Read-only mode mapping and review prompt builder

**Files:**
- Modify: `src/engine/review.ts`
- Modify: `src/engine/review.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1 (this task adds sibling exports in the same file).
- Produces: `getReadOnlyMode(transport: AgentTransportType): string | undefined`, `ReviewPromptOptions` (interface: `{ scope: 'working-tree' | 'branch'; baseRef?: string; adversarial: boolean; focus?: string; readOnlyEnforced: boolean }`), `buildReviewPrompt(options: ReviewPromptOptions): string`.

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/review.test.ts`:

```typescript
import { getReadOnlyMode, buildReviewPrompt } from './review.js';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/engine/review.test.ts`
Expected: FAIL — `getReadOnlyMode` / `buildReviewPrompt` are not exported.

- [ ] **Step 3: Implement the mode mapping and prompt builder**

Add `import { AgentTransportType } from '../config/schema.js';` to the top of `src/engine/review.ts`, alongside the existing `zod` import. Then append the rest to the file:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/engine/review.test.ts`
Expected: PASS (13 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/engine/review.ts src/engine/review.test.ts
git commit -m "feat: add read-only mode mapping and review prompt builder"
```

---

### Task 3: Git pre-check (short-circuit when nothing to review)

**Files:**
- Modify: `src/engine/review.ts`
- Modify: `src/engine/review.test.ts`

**Interfaces:**
- Produces: `GitPreCheckOptions` (interface: `{ workspace: string; scope: 'working-tree' | 'branch'; baseRef?: string }`), `hasChangesToReview(options: GitPreCheckOptions): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/review.test.ts`:

```typescript
import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hasChangesToReview } from './review.js';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/engine/review.test.ts`
Expected: FAIL — `hasChangesToReview` is not exported.

- [ ] **Step 3: Implement the git pre-check**

Add `import { execa } from 'execa';` to the top of `src/engine/review.ts`, alongside the other imports. Then append the rest to the file:

```typescript
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

  const [statusResult, diffResult, cachedDiffResult] = await Promise.all([
    execa('git', ['status', '--short', '--untracked-files=all'], { cwd: workspace }),
    execa('git', ['diff', '--shortstat'], { cwd: workspace }),
    execa('git', ['diff', '--shortstat', '--cached'], { cwd: workspace }),
  ]);

  return (
    statusResult.stdout.trim().length > 0 ||
    diffResult.stdout.trim().length > 0 ||
    cachedDiffResult.stdout.trim().length > 0
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/engine/review.test.ts`
Expected: PASS (18 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/engine/review.ts src/engine/review.test.ts
git commit -m "feat: add git pre-check for review scope"
```

---

### Task 4: Session manager support for tagged review sessions

**Files:**
- Modify: `src/engine/session.ts`
- Modify: `src/engine/engine.test.ts`

**Interfaces:**
- Consumes: `extractAndValidateReview`, `ReviewOutput` from `src/engine/review.ts` (Task 1).
- Produces: `SessionKind` (type: `'task' | 'review'`), `AgentSession.kind: SessionKind`, `AgentSession.reviewResult?: ReviewOutput`, `AgentSessionInfo.review?: ReviewOutput`, updated signature `SessionManager.createSession(agentId: string, prompt: string, workspace?: string, mode?: string, options?: { kind?: SessionKind }): AgentSession`.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/engine.test.ts`:

```typescript
async function waitForSessionCompletion(manager: SessionManager, sessionId: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = manager.getSession(sessionId);
    if (session && session.status !== 'running') return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for session to complete');
}

describe('SessionManager review sessions', () => {
  it('tags a session as kind "task" by default', () => {
    const config = getDefaultConfig();
    config.agents['test_echo'] = {
      name: 'Echo Test',
      command: 'echo',
      args: [],
      transport: 'pty_interactive',
      env: {},
    };
    const manager = new SessionManager(config);

    const session = manager.createSession('test_echo', 'hello');
    expect(session.kind).toBe('task');
    expect(session.getInfo().review).toBeUndefined();
  });

  it('parses and attaches structured review output for kind "review" sessions', async () => {
    const config = getDefaultConfig();
    const reviewPayload = JSON.stringify({
      verdict: 'approve',
      summary: 'Nothing concerning found.',
      findings: [],
      next_steps: [],
    });
    config.agents['fake_reviewer'] = {
      name: 'Fake Reviewer',
      command: 'node',
      args: ['-e', `console.log(JSON.stringify({ type: 'text', text: ${JSON.stringify(reviewPayload)} }))`],
      transport: 'claude_stream_json',
      env: {},
    };
    const manager = new SessionManager(config);

    const session = manager.createSession('fake_reviewer', 'review this', undefined, undefined, { kind: 'review' });
    const completed = await waitForSessionCompletion(manager, session.id);

    expect(completed.status).toBe('completed');
    expect(completed.getInfo().review?.verdict).toBe('approve');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/engine/engine.test.ts`
Expected: FAIL — `session.kind` is undefined and `getInfo().review` is not produced.

- [ ] **Step 3: Implement the session kind tagging**

Modify `src/engine/session.ts`. Add the import and new type near the top:

```typescript
import { extractAndValidateReview, ReviewOutput } from './review.js';

export type SessionKind = 'task' | 'review';
```

Update `AgentSessionInfo`:

```typescript
export interface AgentSessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  status: SessionStatus;
  createdAt: string;
  workspace: string;
  summary?: string;
  eventCount: number;
  review?: ReviewOutput;
}
```

Update the `AgentSession` class:

```typescript
export class AgentSession {
  public readonly id: string;
  public status: SessionStatus = 'running';
  public readonly createdAt: string;
  public readonly controller: AgentProcessController;
  public result?: FormattedResult;
  public error?: string;
  public reviewResult?: ReviewOutput;

  constructor(
    public readonly agentId: string,
    public readonly agentConfig: AgentConfig,
    public readonly workspace: string,
    public readonly kind: SessionKind = 'task'
  ) {
    this.id = randomUUID();
    this.createdAt = new Date().toISOString();
    const adapter = createAdapter(agentConfig);
    this.controller = new AgentProcessController(agentConfig, adapter);
  }

  getInfo(): AgentSessionInfo {
    return {
      sessionId: this.id,
      agentId: this.agentId,
      agentName: this.agentConfig.name,
      status: this.status,
      createdAt: this.createdAt,
      workspace: this.workspace,
      summary: this.result?.summary || this.error,
      eventCount: this.controller.getBuffer().size(),
      review: this.reviewResult,
    };
  }
}
```

Update `SessionManager.createSession`:

```typescript
createSession(
  agentId: string,
  prompt: string,
  workspace?: string,
  mode?: string,
  options?: { kind?: SessionKind }
): AgentSession {
  const activeCount = Array.from(this.sessions.values()).filter((s) => s.status === 'running').length;
  const maxAllowed = this.config.security?.maxConcurrentSessions || 5;

  if (activeCount >= maxAllowed) {
    throw new Error(`Maximum concurrent sessions limit (${maxAllowed}) reached.`);
  }

  const agentConfig = this.config.agents[agentId];
  if (!agentConfig) {
    throw new Error(`Agent '${agentId}' is not defined in configuration.`);
  }

  const targetWorkspace = workspace || this.config.allowedWorkspaces[0];
  validateWorkspacePath(targetWorkspace, this.config.allowedWorkspaces);

  const session = new AgentSession(agentId, agentConfig, targetWorkspace, options?.kind ?? 'task');
  this.sessions.set(session.id, session);

  const runOptions: ProcessRunOptions = {
    prompt,
    workspace: targetWorkspace,
    mode,
    timeoutSeconds: this.config.security?.defaultTimeoutSeconds || 600,
    sanitizeEnv: this.config.security?.sanitizeEnv !== false,
  };

  session.controller
    .runSync(runOptions)
    .then((result) => {
      session.result = result;
      session.status = 'completed';
      if (session.kind === 'review') {
        session.reviewResult = extractAndValidateReview(result.summary);
      }
    })
    .catch((err) => {
      session.error = err instanceof Error ? err.message : String(err);
      session.status = 'failed';
    });

  return session;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/engine/engine.test.ts`
Expected: PASS (3 tests total)

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `pnpm test`
Expected: PASS — all existing suites (adapters, workspace, server, engine) plus the new review tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/session.ts src/engine/engine.test.ts
git commit -m "feat: tag sessions with kind and attach parsed review output"
```

---

### Task 5: `agent_review` tool registration

**Files:**
- Create: `src/tools/review.ts`
- Create: `src/tools/review.test.ts`

**Interfaces:**
- Consumes: `getReadOnlyMode`, `buildReviewPrompt`, `hasChangesToReview`, `extractAndValidateReview`, `ReviewOutput` from `src/engine/review.ts`; `SessionManager` (with the Task 4 `options.kind` param) from `src/engine/session.ts`; `MCPToolDefinition` from `src/tools/unified.ts`.
- Produces: `registerReviewTools(config: AgentMCPConfig, sessionManager: SessionManager): MCPToolDefinition[]`, exposing a tool named `'agent_review'`.

- [ ] **Step 1: Write the failing tests**

Create `src/tools/review.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/tools/review.test.ts`
Expected: FAIL — `src/tools/review.ts` does not exist.

- [ ] **Step 3: Implement the tool**

Create `src/tools/review.ts`:

```typescript
import { AgentMCPConfig } from '../config/schema.js';
import { SessionManager } from '../engine/session.js';
import { validateWorkspacePath } from '../security/workspace.js';
import { createAdapter } from '../adapters/index.js';
import { AgentProcessController } from '../engine/process.js';
import { MCPToolDefinition } from './unified.js';
import {
  buildReviewPrompt,
  extractAndValidateReview,
  getReadOnlyMode,
  hasChangesToReview,
  ReviewOutput,
} from '../engine/review.js';

export function registerReviewTools(
  config: AgentMCPConfig,
  sessionManager: SessionManager
): MCPToolDefinition[] {
  const tools: MCPToolDefinition[] = [];

  tools.push({
    name: 'agent_review',
    description:
      'Runs a read-only, structured code review (normal or adversarial) over the working tree or a branch diff, using the specified agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'ID of the target agent (e.g. agy, claude, opencode, codex)',
        },
        workspace: {
          type: 'string',
          description: 'Target workspace directory (must be within allowedWorkspaces)',
        },
        scope: {
          type: 'string',
          enum: ['working-tree', 'branch'],
          description: "Review scope (default 'working-tree')",
        },
        baseRef: {
          type: 'string',
          description: "Base ref to diff against; required when scope is 'branch'",
        },
        adversarial: {
          type: 'boolean',
          description: 'Use a skeptical, challenge-the-design review stance (default false)',
        },
        focus: {
          type: 'string',
          description: 'Optional steering text; only used when adversarial is true',
        },
        background: {
          type: 'boolean',
          description: 'Run as a background session instead of blocking (default false)',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Maximum execution time in seconds (default: 600)',
        },
      },
      required: ['agent'],
    },
    handler: async (args) => {
      const agentId = String(args.agent);
      const workspace = args.workspace ? String(args.workspace) : config.allowedWorkspaces[0];
      const scope = args.scope === 'branch' ? 'branch' : 'working-tree';
      const baseRef = args.baseRef ? String(args.baseRef) : undefined;
      const adversarial = args.adversarial === true;
      const focus = args.focus ? String(args.focus) : undefined;
      const background = args.background === true;
      const timeoutSeconds =
        typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : config.security?.defaultTimeoutSeconds || 600;

      if (scope === 'branch' && !baseRef) {
        throw new Error("baseRef is required when scope is 'branch'.");
      }

      const agentConfig = config.agents[agentId];
      if (!agentConfig) {
        throw new Error(`Agent '${agentId}' is not configured in agent-mcp.`);
      }

      validateWorkspacePath(workspace, config.allowedWorkspaces);

      const hasChanges = await hasChangesToReview({ workspace, scope, baseRef });
      if (!hasChanges) {
        const emptyResult: ReviewOutput = {
          verdict: 'approve',
          summary: 'Nothing to review.',
          findings: [],
          next_steps: [],
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(emptyResult, null, 2) }],
        };
      }

      const readOnlyMode = getReadOnlyMode(agentConfig.transport);
      const prompt = buildReviewPrompt({
        scope,
        baseRef,
        adversarial,
        focus,
        readOnlyEnforced: readOnlyMode !== undefined,
      });

      if (background) {
        const session = sessionManager.createSession(agentId, prompt, workspace, readOnlyMode, { kind: 'review' });
        return {
          content: [{ type: 'text', text: JSON.stringify(session.getInfo(), null, 2) }],
        };
      }

      const adapter = createAdapter(agentConfig);
      const controller = new AgentProcessController(agentConfig, adapter);

      const result = await controller.runSync({
        prompt,
        workspace,
        mode: readOnlyMode,
        timeoutSeconds,
        sanitizeEnv: config.security?.sanitizeEnv !== false,
      });

      const review = extractAndValidateReview(result.summary);
      return {
        content: [{ type: 'text', text: JSON.stringify(review, null, 2) }],
      };
    },
  });

  return tools;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/tools/review.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/tools/review.ts src/tools/review.test.ts
git commit -m "feat: add agent_review MCP tool"
```

---

### Task 6: Wire `agent_review` into the server and verify end-to-end

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

**Interfaces:**
- Consumes: `registerReviewTools` from `src/tools/review.ts` (Task 5).

- [ ] **Step 1: Write the failing test**

Append to `src/server.test.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('agent_review tool registration', () => {
  it('lists agent_review among the server tools', async () => {
    const { server } = await createAgentMCPServer();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('agent_review');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/server.test.ts`
Expected: FAIL — `agent_review` is not in the tool list.

- [ ] **Step 3: Wire the tool into the server**

Modify `src/server.ts`. Add the import near the other tool imports:

```typescript
import { registerReviewTools } from './tools/review.js';
```

Update the tool assembly inside `createAgentMCPServer`:

```typescript
  const unifiedTools = registerUnifiedTools(config, sessionManager);
  const agentRunHandler = unifiedTools.find((t) => t.name === 'agent_run')!.handler;
  const shortcutTools = registerShortcutTools(config, agentRunHandler);
  const reviewTools = registerReviewTools(config, sessionManager);

  const allTools = [...unifiedTools, ...shortcutTools, ...reviewTools];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/server.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `pnpm test`
Expected: PASS — every suite (adapters, workspace, engine, server, review) passes with no regressions.

- [ ] **Step 6: Build to confirm no type errors**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: register agent_review on the MCP server"
```

---

## Self-Review Notes

- **Spec coverage:** git pre-check (Task 3) → schema/validation (Task 1) → read-only mapping + prompt (Task 2) → sync execution (Task 5) → background execution via tagged sessions (Tasks 4–5) → server registration (Task 6). All sections of `docs/superpowers/specs/2026-08-01-agent-review-design.md` are covered; rescue/transfer/plugin work is explicitly out of scope per the spec's Roadmap section.
- **Placeholder scan:** no TBD/TODO markers; every step includes real, runnable code.
- **Type consistency:** `ReviewOutput`, `getReadOnlyMode`, `buildReviewPrompt`, `hasChangesToReview`, and `extractAndValidateReview` are defined once in Task 1–3 and referenced with identical names/signatures in Tasks 4–6. `SessionManager.createSession`'s new `options` parameter is used identically in Task 4's test and Task 5's tool implementation.
