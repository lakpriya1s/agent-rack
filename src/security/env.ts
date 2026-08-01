/**
 * Sensitive environment variable key patterns to sanitize by default.
 */
const SENSITIVE_KEY_PATTERNS = [
  /SECRET/i,
  /PRIVATE_KEY/i,
  /PASSWORD/i,
  /AUTH_TOKEN/i,
];

/**
 * Clean environment variables passed to child agent runtimes.
 */
export function sanitizeEnvironment(
  customEnv: Record<string, string> = {},
  sanitize: boolean = true
): Record<string, string> {
  const baseEnv = { ...process.env };
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;

    if (sanitize) {
      const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitive) {
        continue;
      }
    }

    sanitized[key] = value;
  }

  // Set predictable defaults
  sanitized['PAGER'] = 'cat';
  sanitized['CI'] = '1';

  // Merge user-specified custom environment variables (takes precedence)
  for (const [key, value] of Object.entries(customEnv)) {
    sanitized[key] = value;
  }

  return sanitized;
}
