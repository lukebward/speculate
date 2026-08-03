/**
 * Speculate's own OAuth client: the credential store and the provider that
 * refreshes ahead of expiry.
 *
 * The refresh behaviour is the reason this file exists. The MCP SDK has no
 * expiry logic at all, so it only discovers a dead token by sending a request
 * and reading the 401 — and its retry after that is a ONE-SHOT circuit
 * breaker. For a prefetcher that is a correctness bug, not an inefficiency: a
 * speculative call would burn the single retry and the user's real call behind
 * it would fail. Everything below pins the behaviour that avoids it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

/** Hoisted so the module mock below can see it. */
const sdk = vi.hoisted(() => ({
  refreshAuthorization: vi.fn(),
  discoverOAuthServerInfo: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshAuthorization: sdk.refreshAuthorization,
  discoverOAuthServerInfo: sdk.discoverOAuthServerInfo,
}));

const {
  canonicalServerUrl,
  listAuthorizedServers,
  readOAuthRecord,
  updateOAuthRecord,
  withOAuthLock,
  writeOAuthRecord,
} = await import('../src/oauthStore.js');
const { SpeculateOAuthProvider, attachStoredOAuth, expiryOf, needsRefresh } = await import(
  '../src/oauthProvider.js'
);

const URL_ = 'https://mcp.example.com/mcp';
let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'speculate-oauth-'));
  storePath = join(dir, 'oauth.json');
  sdk.refreshAuthorization.mockReset();
  sdk.discoverOAuthServerInfo.mockReset();
  sdk.discoverOAuthServerInfo.mockResolvedValue({
    authorizationServerUrl: 'https://mcp.example.com',
    authorizationServerMetadata: undefined,
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CLIENT = { client_id: 'test-client', redirect_uris: ['http://127.0.0.1:47821/callback'] };

function seed(tokens: OAuthTokens, expiresAt?: number): void {
  writeOAuthRecord(storePath, URL_, {
    serverUrl: canonicalServerUrl(URL_),
    client: CLIENT,
    tokens,
    expiresAt,
  });
}

describe('canonicalServerUrl', () => {
  it('keeps the path, which distinguishes real resources', () => {
    expect(canonicalServerUrl('https://x.example.com/mcp')).not.toBe(
      canonicalServerUrl('https://x.example.com/'),
    );
  });

  it('normalizes what does not distinguish anything', () => {
    expect(canonicalServerUrl('HTTPS://X.Example.com/mcp')).toBe('https://x.example.com/mcp');
    expect(canonicalServerUrl('https://x.example.com:443/mcp')).toBe('https://x.example.com/mcp');
    expect(canonicalServerUrl('https://x.example.com/mcp#frag')).toBe('https://x.example.com/mcp');
  });

  it('refuses a non-http scheme rather than inventing a key', () => {
    expect(() => canonicalServerUrl('file:///etc/passwd')).toThrow();
  });
});

describe('the store', () => {
  it('round-trips a record and lists it', async () => {
    await updateOAuthRecord(storePath, URL_, () => ({
      serverUrl: canonicalServerUrl(URL_),
      client: CLIENT,
      tokens: { access_token: 'a', token_type: 'Bearer' },
    }));
    expect(readOAuthRecord(storePath, URL_)?.tokens?.access_token).toBe('a');
    expect(listAuthorizedServers(storePath)).toEqual([canonicalServerUrl(URL_)]);
  });

  it('reads a missing or corrupt file as empty instead of throwing', () => {
    expect(readOAuthRecord(storePath, URL_)).toBeUndefined();
    writeFileSync(storePath, '{not json');
    // Refusing to start the proxy over a corrupt cache would be worse than
    // asking the user to authorize again.
    expect(readOAuthRecord(storePath, URL_)).toBeUndefined();
  });

  it('returns undefined for an unparseable url rather than throwing', () => {
    expect(readOAuthRecord(storePath, 'not a url')).toBeUndefined();
  });

  it('deletes a record when the mutation returns undefined', async () => {
    seed({ access_token: 'a', token_type: 'Bearer' });
    await updateOAuthRecord(storePath, URL_, () => undefined);
    expect(readOAuthRecord(storePath, URL_)).toBeUndefined();
    expect(listAuthorizedServers(storePath)).toEqual([]);
  });

  it('keeps other servers intact when one is written', async () => {
    const other = 'https://other.example.com/mcp';
    seed({ access_token: 'a', token_type: 'Bearer' });
    await updateOAuthRecord(storePath, other, () => ({
      serverUrl: canonicalServerUrl(other),
      client: CLIENT,
      tokens: { access_token: 'b', token_type: 'Bearer' },
    }));
    expect(readOAuthRecord(storePath, URL_)?.tokens?.access_token).toBe('a');
    expect(readOAuthRecord(storePath, other)?.tokens?.access_token).toBe('b');
  });

  it('serializes concurrent updates instead of losing one', async () => {
    // Two wrapped servers in one session share this file.
    await updateOAuthRecord(storePath, URL_, () => ({
      serverUrl: canonicalServerUrl(URL_),
      client: CLIENT,
      tokens: { access_token: '0', token_type: 'Bearer' },
    }));
    await Promise.all(
      Array.from({ length: 8 }, () =>
        updateOAuthRecord(storePath, URL_, (current) => ({
          ...current!,
          tokens: {
            access_token: String(Number(current!.tokens!.access_token) + 1),
            token_type: 'Bearer',
          },
        })),
      ),
    );
    // Every increment saw the previous one: no lost update.
    expect(readOAuthRecord(storePath, URL_)?.tokens?.access_token).toBe('8');
  });
});

describe('expiry', () => {
  it('turns the relative expires_in into an absolute instant', () => {
    expect(expiryOf({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 }, 1_000)).toBe(
      3_601_000,
    );
  });

  it('assumes an hour when the server states no lifetime', () => {
    expect(expiryOf({ access_token: 'a', token_type: 'Bearer' }, 0)).toBe(3_600_000);
  });

  it('refreshes EARLY, not at the deadline', () => {
    // A token that passes the check and then expires in flight lands us back
    // on the 401 path this whole design exists to avoid.
    const record = {
      serverUrl: URL_,
      client: CLIENT,
      tokens: { access_token: 'a', token_type: 'Bearer' } as OAuthTokens,
      expiresAt: 1_000_000,
    };
    expect(needsRefresh(record, 1_000_000 - 180_000)).toBe(false);
    expect(needsRefresh(record, 1_000_000 - 60_000)).toBe(true);
    expect(needsRefresh(record, 1_000_001)).toBe(true);
  });
});

describe('SpeculateOAuthProvider', () => {
  const provider = () => new SpeculateOAuthProvider(URL_, { storePath });

  it('returns a live token without touching the network', async () => {
    seed({ access_token: 'live', token_type: 'Bearer' }, Date.now() + 3_600_000);
    expect((await provider().tokens())?.access_token).toBe('live');
    expect(sdk.refreshAuthorization).not.toHaveBeenCalled();
  });

  it('refreshes before handing out a token near expiry, and stores the new expiry', async () => {
    seed(
      { access_token: 'old', token_type: 'Bearer', refresh_token: 'r1' },
      Date.now() + 30_000, // inside the skew window
    );
    sdk.refreshAuthorization.mockResolvedValue({
      access_token: 'new',
      token_type: 'Bearer',
      refresh_token: 'r2',
      expires_in: 3600,
    });

    expect((await provider().tokens())?.access_token).toBe('new');
    const stored = readOAuthRecord(storePath, URL_)!;
    expect(stored.tokens?.access_token).toBe('new');
    expect(stored.tokens?.refresh_token).toBe('r2');
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it('makes ONE refresh for concurrent callers', async () => {
    // The prefetcher's whole point is issuing calls the user did not ask for,
    // so several requests hit tokens() at once. Refreshing per caller would
    // race, and on a server that rotates refresh tokens all but one of those
    // would be left holding an invalidated token.
    seed({ access_token: 'old', token_type: 'Bearer', refresh_token: 'r1' }, Date.now() + 30_000);
    let calls = 0;
    sdk.refreshAuthorization.mockImplementation(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { access_token: 'new', token_type: 'Bearer', refresh_token: 'r1', expires_in: 3600 };
    });

    const p = provider();
    const results = await Promise.all([p.tokens(), p.tokens(), p.tokens(), p.tokens()]);
    expect(calls).toBe(1);
    expect(results.map((r) => r?.access_token)).toEqual(['new', 'new', 'new', 'new']);
  });

  it('re-reads INSIDE the lock, so a refresh another process finished is not repeated', async () => {
    // The cross-process race, played out in the order that actually happens:
    // we read a stale record, decide to refresh, and only THEN block on the
    // lock another process is holding. Whatever we saw before the wait is out
    // of date by the time we get in, so the check has to happen again inside.
    // Without that, both processes refresh, and against a server that rotates
    // refresh tokens the loser is left holding one already invalidated.
    seed({ access_token: 'old', token_type: 'Bearer', refresh_token: 'r1' }, Date.now() + 30_000);

    let signalHeld!: () => void;
    const lockIsHeld = new Promise<void>((r) => (signalHeld = r));
    let signalRelease!: () => void;
    const mayRelease = new Promise<void>((r) => (signalRelease = r));

    const otherProcess = withOAuthLock(storePath, async () => {
      signalHeld();
      await mayRelease;
      // The other process's refresh lands while we are queued on the lock.
      seed(
        { access_token: 'fresh', token_type: 'Bearer', refresh_token: 'r2' },
        Date.now() + 3_600_000,
      );
    });

    await lockIsHeld;
    const pending = provider().tokens(); // reads stale, then blocks on the lock
    signalRelease();
    await otherProcess;

    expect((await pending)?.access_token).toBe('fresh');
    expect(sdk.refreshAuthorization).not.toHaveBeenCalled();
  });

  it('hands back an expired token when there is nothing to refresh with', async () => {
    // Returning undefined would make the transport send an UNAUTHENTICATED
    // request; a 401 the user can act on is strictly better.
    seed({ access_token: 'stale', token_type: 'Bearer' }, Date.now() - 1);
    expect((await provider().tokens())?.access_token).toBe('stale');
  });

  it('returns undefined when the server was never authorized', async () => {
    expect(await provider().tokens()).toBeUndefined();
  });

  it('stamps expiry at the moment tokens arrive', async () => {
    writeOAuthRecord(storePath, URL_, { serverUrl: canonicalServerUrl(URL_), client: CLIENT });
    await provider().saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 60 });
    const stored = readOAuthRecord(storePath, URL_)!;
    // `expires_in` is RELATIVE seconds; it is only interpretable right now.
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 55_000);
    expect(stored.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('refuses to redirect when it has no browser', async () => {
    // The headless proxy reaching an interactive grant would otherwise hang.
    await expect(provider().redirectToAuthorization(new URL('https://x.example.com'))).rejects.toThrow(
      /speculate auth/,
    );
  });

  it('omits `state` entirely outside the interactive flow', () => {
    // The SDK branches on the member EXISTING; a method returning undefined
    // would put a literal `state=undefined` on the authorization URL.
    expect(provider().state).toBeUndefined();
    const interactive = new SpeculateOAuthProvider(URL_, { storePath, state: 'abc123' });
    expect(interactive.state?.()).toBe('abc123');
  });

  it('registers every candidate loopback port, not just the bound one', () => {
    // The registration is permanent (no server tested supports RFC 7592), so
    // a run that bound a different port must still validate against it.
    const p = new SpeculateOAuthProvider(URL_, {
      storePath,
      redirectUrl: 'http://127.0.0.1:47822/callback',
      redirectUrls: ['http://127.0.0.1:47821/callback', 'http://127.0.0.1:47822/callback'],
    });
    expect(p.redirectUrl).toBe('http://127.0.0.1:47822/callback');
    expect(p.clientMetadata.redirect_uris).toEqual([
      'http://127.0.0.1:47821/callback',
      'http://127.0.0.1:47822/callback',
    ]);
  });

  it('clears tokens but keeps the registration on invalidateCredentials("tokens")', async () => {
    seed({ access_token: 'a', token_type: 'Bearer' }, Date.now() + 1000);
    await provider().invalidateCredentials('tokens');
    const stored = readOAuthRecord(storePath, URL_)!;
    expect(stored.tokens).toBeUndefined();
    expect(stored.expiresAt).toBeUndefined();
    // Re-registering would strand an undeletable client on the auth server.
    expect(stored.client.client_id).toBe('test-client');
  });

  it('drops the whole record on invalidateCredentials("all")', async () => {
    seed({ access_token: 'a', token_type: 'Bearer' });
    await provider().invalidateCredentials('all');
    expect(readOAuthRecord(storePath, URL_)).toBeUndefined();
  });
});

describe('attachStoredOAuth', () => {
  it('wires up exactly the servers that were authorized', () => {
    seed({ access_token: 'a', token_type: 'Bearer' });
    const servers = {
      authorized: { url: URL_ },
      other: { url: 'https://nope.example.com/mcp' },
      local: {},
    };
    expect(attachStoredOAuth(servers, storePath)).toEqual([]);
    expect(servers.authorized).toHaveProperty('oauthStorePath', storePath);
    expect(servers.other).not.toHaveProperty('oauthStorePath');
    expect(servers.local).not.toHaveProperty('oauthStorePath');
  });

  it('does not wire up a registration that has no tokens yet', () => {
    writeOAuthRecord(storePath, URL_, { serverUrl: canonicalServerUrl(URL_), client: CLIENT });
    const servers = { s: { url: URL_ } };
    expect(attachStoredOAuth(servers, storePath)).toEqual([]);
    expect(servers.s).not.toHaveProperty('oauthStorePath');
  });

  it('refuses a configured Authorization header alongside a stored token', () => {
    // The transport spreads configured headers AFTER the bearer it derives
    // from the provider, so the stale header would win SILENTLY and present
    // as a 401 from a token that is valid and never sent.
    seed({ access_token: 'a', token_type: 'Bearer' });
    const servers = { s: { url: URL_, headers: { authorization: 'Bearer hand-set' } } };
    const errors = attachStoredOAuth(servers, storePath);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/would silently win/);
    // And it does NOT half-apply.
    expect(servers.s).not.toHaveProperty('oauthStorePath');
  });

  it('allows non-Authorization headers next to a stored token', () => {
    seed({ access_token: 'a', token_type: 'Bearer' });
    const servers = { s: { url: URL_, headers: { 'X-Api-Version': '2024-01-01' } } };
    expect(attachStoredOAuth(servers, storePath)).toEqual([]);
    expect(servers.s).toHaveProperty('oauthStorePath', storePath);
  });

  it('never writes a credential into the config it is given', () => {
    seed({ access_token: 'super-secret-access-token', token_type: 'Bearer' });
    const servers = { s: { url: URL_ } };
    attachStoredOAuth(servers, storePath);
    // Only a PATH is attached; the token is read at connect time.
    expect(JSON.stringify(servers)).not.toContain('super-secret-access-token');
  });
});

describe('the store file itself', () => {
  it('is not the human-readable managed.json, and holds only what it must', async () => {
    seed({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r' }, 123);
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.servers)).toEqual([canonicalServerUrl(URL_)]);
    expect(raw.servers[canonicalServerUrl(URL_)]).toMatchObject({
      serverUrl: canonicalServerUrl(URL_),
      expiresAt: 123,
    });
  });
});
