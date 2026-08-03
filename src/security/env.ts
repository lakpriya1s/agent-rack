/**
 * Environment variable key patterns treated as sensitive by the denylist fallback.
 *
 * A denylist can never be complete — that is exactly why `AgentConfig.inheritEnv` exists and
 * is the recommended setting. This list is the best-effort default for users who have not
 * declared an allowlist, and it deliberately covers the credential shapes that actually show
 * up in a developer shell rather than only the word "SECRET".
 */
const SENSITIVE_KEY_PATTERNS = [
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /PRIVATE_KEY/i,
  /(^|_)TOKEN($|_)/i,
  /TOKEN$/i,
  /API_KEY/i,
  /APIKEY/i,
  /ACCESS_KEY/i,
  /SECRET_KEY/i,
  /CREDENTIAL/i,
  /(^|_)AUTH($|_)/i,
  /SESSION_KEY/i,
  /COOKIE/i,
  /(^|_)PAT($|_)/i,
  /^AWS_/i,
  /^GH_/i,
  /^GITHUB_/i,
  /^NPM_/i,
  /^GITLAB_/i,
  /^DOCKER_/i,
  /^SLACK_/i,
  /^STRIPE_/i,
  /^TWILIO_/i,
  /^SENTRY_/i,
  /^VERCEL_/i,
  /^CLOUDFLARE_/i,
  /^DATABASE_URL$/i,
  /^KUBECONFIG$/i,
  /_DSN$/i,
];

/**
 * Variables always passed through when an allowlist is in effect. Without these a spawned CLI
 * cannot find its own binary, home directory, or terminal, so an allowlist of ["OPENAI_API_KEY"]
 * would otherwise produce a process that fails before it starts.
 */
const ALWAYS_INHERITED = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
];

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** Replaces a secret's value with a length-preserving marker for logs and diagnostics. */
export function redactEnvValue(value: string): string {
  return value.length === 0 ? '' : `<redacted:${value.length}>`;
}

/**
 * Returns a copy of `env` with every value whose key looks sensitive replaced by a redaction
 * marker. Used anywhere an effective config is rendered for a human (`config-check`, `agents`,
 * dashboard panes) so inspecting configuration never prints a credential.
 */
export function redactSensitiveEnv(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = isSensitiveEnvKey(key) ? redactEnvValue(value) : value;
  }
  return redacted;
}

export interface SanitizeEnvironmentOptions {
  /** Per-agent `env` block; always wins over inherited values. */
  customEnv?: Record<string, string>;
  /** Apply the pattern denylist. Ignored when `inheritEnv` is set — an allowlist supersedes it. */
  sanitize?: boolean;
  /**
   * Explicit allowlist of parent environment variable names. When provided, nothing outside it
   * (plus ALWAYS_INHERITED) reaches the child, regardless of `sanitize`.
   */
  inheritEnv?: string[];
}

/**
 * Builds the environment for a child agent process.
 *
 * Two modes, in precedence order:
 *  1. `inheritEnv` set  → allowlist. Only named variables (plus the baseline needed to run at
 *     all) are inherited. This is the only mode that can promise a given secret never leaks.
 *  2. otherwise         → denylist via SENSITIVE_KEY_PATTERNS when `sanitize` is true.
 *
 * Either way `PAGER=cat` and `CI=1` are forced so agent CLIs behave non-interactively, and the
 * agent's own `env` block is merged last.
 */
export function sanitizeEnvironment(
  options: SanitizeEnvironmentOptions = {}
): Record<string, string> {
  const customEnv = options.customEnv ?? {};
  const shouldSanitize = options.sanitize ?? true;
  const allowlist = options.inheritEnv;

  const sanitized: Record<string, string> = {};

  if (allowlist) {
    const allowed = new Set([...ALWAYS_INHERITED, ...allowlist]);
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (allowed.has(key)) sanitized[key] = value;
    }
  } else {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (shouldSanitize && isSensitiveEnvKey(key)) continue;
      sanitized[key] = value;
    }
  }

  sanitized['PAGER'] = 'cat';
  sanitized['CI'] = '1';

  for (const [key, value] of Object.entries(customEnv)) {
    sanitized[key] = value;
  }

  return sanitized;
}
