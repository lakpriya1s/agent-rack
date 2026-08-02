import { createHash } from 'node:crypto';
import type { AgentMCPConfig } from './schema.js';
import { DEFAULT_SSE_PORT } from './schema.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

/** A deterministic, non-reversible identity for the complete effective server configuration. */
export function fingerprintAgentMCPConfig(config: AgentMCPConfig): string {
  const effectiveConfig = {
    ...config,
    port: config.port ?? DEFAULT_SSE_PORT,
  };
  const canonical = JSON.stringify(canonicalize(effectiveConfig));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
