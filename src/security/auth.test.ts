import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  bearerHeaders,
  createServerAuth,
  extractBearerToken,
  generateToken,
  isAllowedOrigin,
  isLoopbackHost,
  readLocalToken,
  removeTokenFile,
  tokenFilePath,
  tokensMatch,
} from './auth.js';

// A port unlikely to collide with a real server's published token file.
const TEST_PORT = 59_871;

afterEach(() => {
  removeTokenFile(TEST_PORT);
  delete process.env.AGENT_RACK_TOKEN;
});

describe('generateToken', () => {
  it('produces a long, unpredictable hex token', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('tokensMatch', () => {
  it('accepts an exact match and rejects anything else', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
    expect(tokensMatch('abc123', 'abc124')).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    // timingSafeEqual throws on unequal lengths, so the guard has to come first.
    expect(tokensMatch('abc', 'abcdef')).toBe(false);
    expect(tokensMatch('abcdef', '')).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('accepts loopback names and addresses, with or without a port', () => {
    for (const host of ['localhost', 'localhost:8987', '127.0.0.1', '127.0.0.1:8987', '[::1]:8987', '::1']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('rejects a rebound attacker domain that resolves to loopback', () => {
    // This is the DNS-rebinding case: the packet arrives, but Host still names their domain.
    expect(isLoopbackHost('evil.example.com')).toBe(false);
    expect(isLoopbackHost('evil.example.com:8987')).toBe(false);
    expect(isLoopbackHost('192.168.1.10:8987')).toBe(false);
  });

  it('rejects a missing Host header', () => {
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('allows requests with no Origin, which is what non-browser clients send', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('null')).toBe(true);
  });

  it('rejects any browser origin, including a loopback page', () => {
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it('reads a case-insensitive Authorization: Bearer header', () => {
    expect(extractBearerToken({ authorization: 'Bearer tok123' })).toBe('tok123');
    expect(extractBearerToken({ authorization: 'bearer tok123' })).toBe('tok123');
  });

  it('falls back to the custom header used by the SSE handshake', () => {
    expect(extractBearerToken({ 'x-agent-rack-token': 'tok123' })).toBe('tok123');
  });

  it('returns undefined when no credential is present', () => {
    expect(extractBearerToken({})).toBeUndefined();
    expect(extractBearerToken({ authorization: 'Basic abc' })).toBeUndefined();
  });
});

describe('createServerAuth with auth required', () => {
  it('rejects a request with no token', () => {
    const auth = createServerAuth({ port: TEST_PORT, required: true, publish: false });
    const result = auth.authorizeHeaders({ host: '127.0.0.1:8987' });
    expect(result).toEqual({ ok: false, status: 401, reason: 'Missing bearer token.' });
  });

  it('rejects a wrong token', () => {
    const auth = createServerAuth({ port: TEST_PORT, required: true, publish: false });
    const result = auth.authorizeHeaders({
      host: '127.0.0.1:8987',
      authorization: 'Bearer not-the-token',
    });
    expect(result).toEqual({ ok: false, status: 401, reason: 'Invalid bearer token.' });
  });

  it('accepts the real token', () => {
    const auth = createServerAuth({ port: TEST_PORT, required: true, publish: false });
    expect(
      auth.authorizeHeaders({ host: '127.0.0.1:8987', ...bearerHeaders(auth.token) })
    ).toEqual({ ok: true });
  });

  it('rejects a browser-origin request even when the token is correct', () => {
    // A page that somehow learned the token still must not be able to drive the server.
    const auth = createServerAuth({ port: TEST_PORT, required: true, publish: false });
    const result = auth.authorizeHeaders({
      host: '127.0.0.1:8987',
      origin: 'https://evil.example.com',
      ...bearerHeaders(auth.token),
    });
    expect(result).toEqual({ ok: false, status: 403, reason: 'Cross-origin requests are not permitted.' });
  });

  it('rejects a non-loopback Host even with a correct token', () => {
    const auth = createServerAuth({ port: TEST_PORT, required: true, publish: false });
    const result = auth.authorizeHeaders({
      host: 'evil.example.com',
      ...bearerHeaders(auth.token),
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 403 });
  });
});

describe('createServerAuth with auth disabled', () => {
  it('still blocks browser origins, which need no token to attack', () => {
    const auth = createServerAuth({ port: TEST_PORT, required: false });
    expect(auth.authorizeHeaders({ host: '127.0.0.1:8987', origin: 'https://evil.example.com' })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('allows an ordinary local client with no credential', () => {
    const auth = createServerAuth({ port: TEST_PORT, required: false });
    expect(auth.authorizeHeaders({ host: '127.0.0.1:8987' })).toEqual({ ok: true });
  });
});

describe('token file publication', () => {
  it('writes the token 0600 so other users on the machine cannot read it', () => {
    const auth = createServerAuth({ port: TEST_PORT, required: true });
    try {
      expect(auth.tokenFilePath).toBe(tokenFilePath(TEST_PORT));
      const mode = fs.statSync(auth.tokenFilePath!).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(readLocalToken(TEST_PORT)).toBe(auth.token);
    } finally {
      auth.dispose();
    }
  });

  it('removes the token file on dispose so a stale token cannot be reused', () => {
    const auth = createServerAuth({ port: TEST_PORT, required: true });
    auth.dispose();
    expect(fs.existsSync(tokenFilePath(TEST_PORT))).toBe(false);
    expect(readLocalToken(TEST_PORT)).toBeUndefined();
  });

  it('prefers AGENT_RACK_TOKEN over the token file', () => {
    const auth = createServerAuth({ port: TEST_PORT, required: true });
    try {
      process.env.AGENT_RACK_TOKEN = 'explicit-token';
      expect(readLocalToken(TEST_PORT)).toBe('explicit-token');
    } finally {
      auth.dispose();
    }
  });
});
