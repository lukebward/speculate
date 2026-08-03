/**
 * `speculate auth` end to end, against a real (local) OAuth + MCP server.
 *
 * Everything between "the user runs the command" and "a usable token is on
 * disk" is exercised for real: RFC 9728 discovery, RFC 7591 dynamic client
 * registration, PKCE, the loopback redirect, the code exchange, and the
 * verifying reconnect. Only the browser is stubbed, and it is stubbed by
 * actually fetching the authorization URL — so the redirect the real browser
 * would follow is the redirect this test follows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speculateAuth } from '../src/authCommand.js';
import { readOAuthRecord } from '../src/oauthStore.js';

let server: Server;
let base: string;
let dir: string;
let storePath: string;
let logs: string[];

/** Everything the fake authorization server recorded, for assertions. */
let registrations: Record<string, unknown>[];
let authorizeParams: URLSearchParams[];
let tokenParams: URLSearchParams[];
/** Access tokens the fake MCP resource server will accept. */
let validTokens: Set<string>;
let issued = 0;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'speculate-authflow-'));
  storePath = join(dir, 'oauth.json');
  logs = [];
  registrations = [];
  authorizeParams = [];
  tokenParams = [];
  validTokens = new Set();
  issued = 0;

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);

    // RFC 9728: note the PATH SUFFIX. Sentry 404s the bare well-known path
    // and only serves the suffixed one, so the fake behaves the same way.
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['read'],
      });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      registrations.push(body);
      return json(res, 201, {
        client_id: 'issued-client-id',
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: 'none',
      });
    }
    if (url.pathname === '/oauth/authorize') {
      authorizeParams.push(url.searchParams);
      // What the user's browser does after they click Approve.
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'the-authorization-code');
      const state = url.searchParams.get('state');
      if (state) back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      tokenParams.push(params);
      const token = `access-${++issued}`;
      validTokens.add(token);
      return json(res, 200, {
        access_token: token,
        token_type: 'Bearer',
        refresh_token: 'the-refresh-token',
        expires_in: 3600,
      });
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const auth = req.headers.authorization ?? '';
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!validTokens.has(presented)) {
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="OAuth", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      const body = JSON.parse(await readBody(req)) as { id: number; method: string };
      if (body.method === 'initialize') {
        return json(res, 200, {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1' },
          },
        });
      }
      return json(res, 200, { jsonrpc: '2.0', id: body.id, result: { tools: [] } });
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/** Stands in for the browser: follows the authorization URL to the callback. */
const browser = async (url: URL): Promise<void> => {
  const res = await fetch(url, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error(`authorize did not redirect (${res.status})`);
  await fetch(location);
};

const run = (extra: Parameters<typeof speculateAuth>[0] = {}) =>
  speculateAuth({
    target: `${base}/mcp`,
    storePath,
    log: (l) => logs.push(l),
    openBrowser: browser,
    ...extra,
  });

describe('speculate auth, end to end', () => {
  it('registers, authorizes, and stores a token that works', async () => {
    expect(await run()).toBe(0);

    const record = readOAuthRecord(storePath, `${base}/mcp`);
    expect(record?.client.client_id).toBe('issued-client-id');
    expect(record?.tokens?.access_token).toBe('access-1');
    expect(record?.tokens?.refresh_token).toBe('the-refresh-token');
    // Expiry is OURS to compute: the SDK never does it, so an absolute
    // instant has to be derived from the relative `expires_in` on arrival.
    expect(record?.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
    expect(logs.join('\n')).toContain('authorized');
  });

  it('registers every candidate loopback port, so a later run on another port still validates', () => {
    return run().then(() => {
      const uris = registrations[0]?.redirect_uris as string[];
      expect(uris.length).toBeGreaterThan(1);
      expect(uris.every((u) => u.startsWith('http://127.0.0.1:'))).toBe(true);
      // The one actually used this run must be among them.
      expect(uris).toContain(authorizeParams[0].get('redirect_uri'));
    });
  });

  it('uses PKCE and a state parameter', async () => {
    await run();
    expect(authorizeParams[0].get('code_challenge')).toBeTruthy();
    expect(authorizeParams[0].get('code_challenge_method')).toBe('S256');
    expect(authorizeParams[0].get('state')).toBeTruthy();
    // The verifier is sent only at exchange time, never on the front channel.
    expect(authorizeParams[0].get('code_verifier')).toBeNull();
    expect(tokenParams[0].get('code_verifier')).toBeTruthy();
  });

  it('does not keep the PKCE verifier once the exchange is done', async () => {
    await run();
    expect(readOAuthRecord(storePath, `${base}/mcp`)?.codeVerifier).toBeUndefined();
  });

  it('reuses the existing registration on a second run rather than stranding a client', async () => {
    // Registrations cannot be deleted (no server tested returns a
    // registration_access_token), so re-registering leaks one every time.
    await run();
    validTokens.clear(); // force the stored token to be rejected
    await run();
    expect(registrations).toHaveLength(1);
  });

  it('short-circuits when the stored token still works, without opening a browser', async () => {
    await run();
    const before = authorizeParams.length;
    let opened = 0;

    expect(
      await run({
        openBrowser: async () => {
          opened++;
        },
      }),
    ).toBe(0);
    expect(opened).toBe(0);
    expect(authorizeParams).toHaveLength(before);
    expect(logs.join('\n')).toContain('already authorized');
  });

  it('rejects a callback whose state does not match', async () => {
    // Without this check, anything able to reach the loopback port could
    // plant its own authorization code.
    const tampering = async (url: URL): Promise<void> => {
      const res = await fetch(url, { redirect: 'manual' });
      const location = new URL(res.headers.get('location')!);
      location.searchParams.set('state', 'not-the-state-we-issued');
      await fetch(location);
    };
    expect(await run({ openBrowser: tampering })).toBe(1);
    expect(logs.join('\n')).toMatch(/state mismatch/);
    expect(readOAuthRecord(storePath, `${base}/mcp`)?.tokens).toBeUndefined();
  });

  it('reports a denied authorization instead of hanging', async () => {
    const deny = async (url: URL): Promise<void> => {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('state', url.searchParams.get('state')!);
      await fetch(back);
    };
    expect(await run({ openBrowser: deny })).toBe(1);
    expect(logs.join('\n')).toMatch(/access_denied/);
  });

  it('never writes a token into the log', async () => {
    await run();
    const record = readOAuthRecord(storePath, `${base}/mcp`)!;
    expect(logs.join('\n')).not.toContain(record.tokens!.access_token);
    expect(logs.join('\n')).not.toContain(record.tokens!.refresh_token);
  });

  it('points at the token route when the server offers no dynamic registration', async () => {
    // GitHub's hosted MCP server is exactly this: metadata at
    // https://github.com/login/oauth with no registration_endpoint, because
    // it expects hand-registered OAuth apps. Speculate cannot register
    // itself there, but the server is perfectly usable with a token, so the
    // failure has to name that instead of dead-ending.
    const noDcr = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: 'http://x',
          authorization_endpoint: 'http://x/authorize',
          token_endpoint: 'http://x/token',
          // no registration_endpoint
          response_types_supported: ['code'],
        });
      }
      res.writeHead(401, { 'www-authenticate': 'Bearer realm="OAuth"' }).end();
    });
    await new Promise<void>((r) => noDcr.listen(0, '127.0.0.1', r));
    const port = (noDcr.address() as { port: number }).port;
    try {
      const code = await speculateAuth({
        target: `http://127.0.0.1:${port}/mcp`,
        storePath,
        log: (l) => logs.push(l),
        openBrowser: browser,
      });
      expect(code).toBe(1);
      const out = logs.join('\n');
      expect(out).toContain('does not offer dynamic client registration');
      expect(out).toContain('speculate wrap --url');
      expect(out).toContain('Authorization: Bearer');
    } finally {
      await new Promise<void>((r) => noDcr.close(() => r()));
    }
  });

  it('--forget deletes the local credentials', async () => {
    await run();
    expect(readOAuthRecord(storePath, `${base}/mcp`)?.tokens).toBeDefined();

    expect(await run({ forget: true })).toBe(0);
    expect(readOAuthRecord(storePath, `${base}/mcp`)).toBeUndefined();
    // Says what it actually did: local deletion is not server-side revocation.
    expect(logs.join('\n')).toContain('local credentials deleted');
    expect(logs.join('\n')).toMatch(/revoke .* at the provider/);
  });
});

describe('the proxy side of it', () => {
  it('connects with a stored token, and refreshes one that is nearly expired', async () => {
    await run();
    const { SpeculateOAuthProvider } = await import('../src/oauthProvider.js');
    const { writeOAuthRecord } = await import('../src/oauthStore.js');

    // Age the token to just inside the refresh window, as a long session does.
    const record = readOAuthRecord(storePath, `${base}/mcp`)!;
    writeOAuthRecord(storePath, `${base}/mcp`, { ...record, expiresAt: Date.now() + 30_000 });
    validTokens.delete(record.tokens!.access_token!);

    const provider = new SpeculateOAuthProvider(`${base}/mcp`, { storePath });
    const fresh = await provider.tokens();

    // Refreshed proactively: the dead token was never sent, so the SDK's
    // one-shot 401 retry was never spent.
    expect(fresh?.access_token).toBe('access-2');
    expect(tokenParams.at(-1)?.get('grant_type')).toBe('refresh_token');
    expect(readOAuthRecord(storePath, `${base}/mcp`)?.tokens?.access_token).toBe('access-2');
  });
});
