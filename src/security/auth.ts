import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bearer-token auth for the SSE transport.
 *
 * Why this is needed even though the server binds to 127.0.0.1: loopback is reachable by
 * anything on the machine, including a web page in the user's browser. Without a token and an
 * Origin check, a visited site could `fetch()` this server and start agents with whatever
 * authority the config grants, read every session log, or cancel work. Binding to loopback
 * limits *who can route* to the port; it says nothing about *who may drive it*.
 *
 * What this does and does not protect:
 *  - Blocks browser-origin and unauthenticated local requests. This is the realistic attack.
 *  - Does NOT isolate the user from themselves: a process running as the same user can read the
 *    token file, just as it could read the config or attach to the process. Same-user isolation
 *    is not achievable here and is not claimed.
 */

const TOKEN_BYTES = 32;

export interface ServerAuth {
  token: string;
  /** Where the token was published for local clients, or null when auth is disabled. */
  tokenFilePath: string | null;
  authorizeHeaders(headers: Record<string, string | string[] | undefined>): AuthResult;
  dispose(): void;
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** Constant-time comparison so a wrong token cannot be discovered byte-by-byte via timing. */
export function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(provided, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Runtime directory for token files, one per bound port. */
export function runtimeDir(): string {
  return path.join(os.homedir(), '.config', 'agent-rack', 'runtime');
}

export function tokenFilePath(port: number): string {
  return path.join(runtimeDir(), `sse-${port}.json`);
}

/**
 * Publishes the token so same-user clients (the dashboard, `agent-rack session ...`) can
 * connect without the user copying a secret around. Written 0600 in a 0700 directory, which
 * keeps it away from *other* users on a shared machine.
 */
export function publishToken(port: number, token: string): string {
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Pre-existing directory with a different mode; the file mode below still applies.
  }

  const filePath = tokenFilePath(port);
  // Open with an explicit restrictive mode rather than writeFileSync's default, so the token
  // is never briefly world-readable between creation and a later chmod.
  const handle = fs.openSync(filePath, 'w', 0o600);
  try {
    fs.writeFileSync(
      handle,
      `${JSON.stringify({ port, token, pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
      'utf-8'
    );
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort; the file was created with the right mode already.
  }
  return filePath;
}

/**
 * Reads a token for a locally running server. `$AGENT_RACK_TOKEN` wins so a user can drive a
 * server they started elsewhere (another container, another account) explicitly.
 */
export function readLocalToken(port: number): string | undefined {
  if (process.env.AGENT_RACK_TOKEN) return process.env.AGENT_RACK_TOKEN;

  try {
    const parsed = JSON.parse(fs.readFileSync(tokenFilePath(port), 'utf-8')) as { token?: unknown };
    return typeof parsed.token === 'string' ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

export function removeTokenFile(port: number): void {
  try {
    fs.rmSync(tokenFilePath(port), { force: true });
  } catch {
    // Nothing to clean up.
  }
}

/**
 * Case-insensitive header lookup. Node lowercases incoming header names, but this is also
 * called with hand-built header maps (tests, and any future in-process transport), so relying
 * on that normalization would make a correct `Authorization` header silently invisible.
 */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * A Host header must name loopback. This is the DNS-rebinding defence: an attacker's domain
 * can be made to resolve to 127.0.0.1, but the browser still sends *their* hostname in Host,
 * so requiring a loopback Host rejects the request even though the packet reached us.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed) {
    // [::1] or [::1]:8987
    host = bracketed[1];
  } else if (host.split(':').length === 2) {
    // host:port. A bare IPv6 literal has more than one colon, so stripping ':\d+$'
    // unconditionally would turn '::1' into ':' and reject genuine loopback.
    host = host.slice(0, host.lastIndexOf(':'));
  }

  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // All of 127.0.0.0/8 is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Any Origin at all means a browser sent this, and no browser page has business driving a local
 * agent runner — so an Origin header is rejected outright rather than allowlisted.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === 'null';
}

export interface CreateServerAuthOptions {
  port: number;
  required: boolean;
  /** Reuse a specific token instead of generating one (e.g. from $AGENT_RACK_TOKEN). */
  token?: string;
  /** Skip writing the token file — used by tests that pass the token in directly. */
  publish?: boolean;
}

export function createServerAuth(options: CreateServerAuthOptions): ServerAuth {
  const token = options.token ?? generateToken();

  if (!options.required) {
    return {
      token,
      tokenFilePath: null,
      // Header checks still apply with auth off: they cost nothing and stop drive-by browser
      // requests, which is the one attack that does not need the token at all.
      authorizeHeaders: (headers) => checkHeaders(headers, undefined),
      dispose: () => undefined,
    };
  }

  const published = options.publish === false ? null : publishToken(options.port, token);

  return {
    token,
    tokenFilePath: published,
    authorizeHeaders: (headers) => checkHeaders(headers, token),
    dispose: () => {
      if (published) removeTokenFile(options.port);
    },
  };
}

function checkHeaders(
  headers: Record<string, string | string[] | undefined>,
  expectedToken: string | undefined
): AuthResult {
  if (!isAllowedOrigin(headerValue(headers, 'origin'))) {
    return { ok: false, status: 403, reason: 'Cross-origin requests are not permitted.' };
  }
  if (!isLoopbackHost(headerValue(headers, 'host'))) {
    return { ok: false, status: 403, reason: 'Host header must address a loopback address.' };
  }
  if (!expectedToken) return { ok: true };

  const provided = extractBearerToken(headers);
  if (!provided) {
    return { ok: false, status: 401, reason: 'Missing bearer token.' };
  }
  if (!tokensMatch(expectedToken, provided)) {
    return { ok: false, status: 401, reason: 'Invalid bearer token.' };
  }
  return { ok: true };
}

/**
 * Accepts `Authorization: Bearer <token>` or `X-Agent-Rack-Token: <token>`. The second exists
 * because SSE clients that cannot set Authorization on the EventSource handshake still need a
 * way in, and it carries exactly the same weight.
 */
/** Headers a client must send. Empty when there is no token, so callers need no branching. */
export function bearerHeaders(token?: string): Record<string, string> {
  if (!token) return {};
  return {
    Authorization: `Bearer ${token}`,
    'X-Agent-Rack-Token': token,
  };
}

/**
 * Transport options for an authenticated SSE MCP client.
 *
 * Both halves are required: `requestInit` covers the POSTs to /message, while
 * `eventSourceInit.fetch` is the only way to attach headers to the SSE handshake itself —
 * without it the stream connects unauthenticated and fails with a bare 401.
 */
export function sseTransportInit(token?: string): {
  requestInit: { headers: Record<string, string> };
  eventSourceInit: { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> };
} {
  const headers = bearerHeaders(token);
  return {
    requestInit: { headers },
    eventSourceInit: {
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: { ...((init?.headers as Record<string, string>) ?? {}), ...headers },
        }),
    },
  };
}

export function extractBearerToken(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  const authorization = headerValue(headers, 'authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  return headerValue(headers, 'x-agent-rack-token')?.trim();
}
