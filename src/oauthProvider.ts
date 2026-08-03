/**
 * Speculate as its own OAuth client (RFC 6749 + RFC 7591 dynamic registration).
 *
 * Two halves share this provider:
 *   - `speculate auth <server>`, an interactive TTY process that runs the
 *     browser consent flow once and writes tokens to the store.
 *   - the wrapped proxy, headless, which only ever reads those tokens and
 *     refreshes them. It never has a browser and never redirects.
 *
 * The load-bearing addition to the SDK is EXPIRY. The SDK has none — no
 * `Date.now()` appears anywhere in its auth or transport code — so it learns a
 * token is dead only by sending a request and reading the 401, and its retry
 * after that is a one-shot circuit breaker. For a prefetcher that is actively
 * harmful: a speculative call would burn the single retry, and the user's real
 * call behind it would fail outright. So `tokens()` refreshes BEFORE handing
 * anything out, which works because the transport awaits `tokens()` on every
 * outbound request (streamableHttp.js `_commonHeaders`).
 */
import {
  discoverOAuthServerInfo,
  refreshAuthorization,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  readOAuthRecord,
  withOAuthLock,
  writeOAuthRecord,
  type StoredOAuth,
} from './oauthStore.js';
import { VERSION } from './version.js';

/**
 * Refresh this long before the token actually expires.
 *
 * Covers clock skew between us and the authorization server plus the flight
 * time of a request that is about to go out. Too small and a token that passes
 * the check here expires in transit — which lands us back on the 401 path this
 * whole class exists to avoid.
 */
const REFRESH_SKEW_MS = 120_000;

/** Assumed lifetime when a server returns no `expires_in` at all. */
const ASSUMED_LIFETIME_MS = 3_600_000;

/**
 * Point every `url` server at Speculate's credential store if, and only if,
 * the user has authorized that exact URL.
 *
 * Deliberately implicit — no flag, no config edit. `speculate auth` is the
 * whole ceremony; a server it authorized starts using OAuth the next time the
 * proxy launches, and one it did not is untouched.
 *
 * Returns fatal errors, which the caller must surface rather than swallow. An
 * `Authorization` header alongside a stored token is one, because the
 * transport spreads configured headers AFTER the bearer it derives from the
 * provider: the header would win silently, and the user would be debugging a
 * 401 from a token that is perfectly valid and never sent.
 */
export function attachStoredOAuth(
  servers: Record<string, { url?: string; headers?: Record<string, string>; oauthStorePath?: string }>,
  storePath: string,
): string[] {
  const errors: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!server.url) continue;
    let record;
    try {
      record = readOAuthRecord(storePath, server.url);
    } catch {
      continue; // unparseable url: the transport will report it properly
    }
    if (!record?.tokens) continue;
    const authHeader = Object.keys(server.headers ?? {}).find(
      (h) => h.toLowerCase() === 'authorization',
    );
    if (authHeader) {
      errors.push(
        `${name}: has an Authorization header AND a token from 'speculate auth'. ` +
          `The header would silently win. Remove one: drop the header, or run 'speculate auth --forget ${server.url}'.`,
      );
      continue;
    }
    server.oauthStorePath = storePath;
  }
  return errors;
}

export interface ProviderOptions {
  /** Absolute path to the credential store. */
  storePath: string;
  /**
   * Loopback redirect target actually bound this run. Present only in the
   * interactive `auth` command; the headless proxy has nowhere to redirect TO
   * and passes nothing, which is also what makes an accidental interactive
   * flow in the proxy impossible.
   */
  redirectUrl?: string;
  /**
   * EVERY loopback address `auth` might bind, registered together.
   *
   * The bound port varies run to run (whichever candidate is free), but the
   * registration is permanent — no server tested returns a
   * `registration_access_token`, so RFC 7592 client management is unavailable
   * and a client can never be updated or deleted. Registering one port would
   * mean the next run's port failed `redirect_uri` validation and had to
   * re-register, stranding a dead client on the authorization server every
   * time. Registering the whole candidate set once avoids that permanently.
   */
  redirectUrls?: string[];
  /** Opens the consent page. Interactive command only. */
  onRedirect?: (url: URL) => Promise<void> | void;
  /** CSRF `state`, generated per run by the caller and checked at callback. */
  state?: string;
}

/** Epoch ms at which `tokens` should be treated as dead. */
export function expiryOf(tokens: OAuthTokens, now: number): number {
  const lifetime =
    typeof tokens.expires_in === 'number' && tokens.expires_in > 0
      ? tokens.expires_in * 1000
      : ASSUMED_LIFETIME_MS;
  return now + lifetime;
}

/** True when `record`'s access token is expired, or close enough to it. */
export function needsRefresh(record: StoredOAuth, now: number): boolean {
  if (!record.tokens) return false;
  if (record.expiresAt === undefined) return false;
  return now + REFRESH_SKEW_MS >= record.expiresAt;
}

export class SpeculateOAuthProvider implements OAuthClientProvider {
  readonly serverUrl: string;
  readonly #storePath: string;
  readonly #redirectUrl: string | undefined;
  readonly #redirectUrls: string[];
  readonly #onRedirect: ((url: URL) => Promise<void> | void) | undefined;
  /**
   * CSRF `state`, present ONLY in the interactive flow.
   *
   * An own optional property rather than a method on the prototype because
   * the SDK branches on whether the member exists at all (`provider.state ?
   * await provider.state() : undefined`), and a method that returns undefined
   * would put a literal `state=undefined` on the authorization URL.
   */
  state?: () => string;
  /** Discovery is network I/O and immutable per server; do it at most once. */
  #discovery: ReturnType<typeof discoverOAuthServerInfo> | undefined;
  /** In-process single-flight, so N concurrent calls make ONE refresh. */
  #refreshing: Promise<OAuthTokens | undefined> | undefined;

  constructor(serverUrl: string, opts: ProviderOptions) {
    this.serverUrl = serverUrl;
    this.#storePath = opts.storePath;
    this.#redirectUrl = opts.redirectUrl;
    this.#redirectUrls =
      opts.redirectUrls ?? (opts.redirectUrl ? [opts.redirectUrl] : []);
    this.#onRedirect = opts.onRedirect;
    if (opts.state !== undefined) {
      const value = opts.state;
      this.state = () => value;
    }
  }

  get redirectUrl(): string | undefined {
    return this.#redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `Speculate ${VERSION}`,
      client_uri: 'https://github.com/lukebward/speculate',
      redirect_uris: this.#redirectUrls,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }


  #record(): StoredOAuth | undefined {
    return readOAuthRecord(this.#storePath, this.serverUrl);
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.#record()?.client;
  }

  /**
   * Registration is permanent. Neither Sentry nor Notion returns a
   * `registration_access_token`, so RFC 7592 client management is unavailable
   * and a client we register can never be deleted — re-registering on every
   * `auth` run would strand a dead client record on the authorization server
   * each time. The record is therefore written once and reused forever.
   */
  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await withOAuthLock(this.#storePath, () => {
      const current = this.#record();
      writeOAuthRecord(this.#storePath, this.serverUrl, {
        ...current,
        serverUrl: this.serverUrl,
        client: info,
      });
    });
  }

  /**
   * The token to send, refreshed first if it is at or near expiry.
   *
   * Called by the transport before EVERY request, which is what makes this the
   * right place for the check the SDK does not do.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    const record = this.#record();
    if (!record?.tokens) return undefined;
    if (!needsRefresh(record, Date.now())) return record.tokens;
    if (!record.tokens.refresh_token) {
      // Nothing to refresh WITH. Hand back what we have and let the server
      // reject it: a 401 the user can act on beats a silent undefined, which
      // the transport would send as an unauthenticated request.
      return record.tokens;
    }
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /**
   * Refresh, holding the cross-process lock across the network call.
   *
   * The re-read inside the lock is what makes a second process cheap rather
   * than harmful: if it waited while another process refreshed, it finds a
   * fresh token and returns it without touching the network. Without that,
   * both would refresh, and against a server that rotates refresh tokens the
   * loser would be left holding one the server had already invalidated.
   */
  async #refresh(): Promise<OAuthTokens | undefined> {
    return withOAuthLock(this.#storePath, async () => {
      const record = this.#record();
      if (!record?.tokens?.refresh_token) return record?.tokens;
      if (!needsRefresh(record, Date.now())) return record.tokens; // someone else did it
      const info = await this.#serverInfo();
      const fresh = await refreshAuthorization(info.authorizationServerUrl, {
        metadata: info.authorizationServerMetadata,
        clientInformation: record.client,
        refreshToken: record.tokens.refresh_token,
      });
      writeOAuthRecord(this.#storePath, this.serverUrl, {
        ...record,
        // `refreshAuthorization` preserves the old refresh_token when the
        // server does not rotate it, so this assignment is safe either way.
        tokens: fresh,
        expiresAt: expiryOf(fresh, Date.now()),
      });
      return fresh;
    });
  }

  #serverInfo(): ReturnType<typeof discoverOAuthServerInfo> {
    this.#discovery ??= discoverOAuthServerInfo(this.serverUrl);
    return this.#discovery;
  }

  /**
   * Stamps `expiresAt` at the moment tokens arrive, which is the only moment
   * `expires_in` (a RELATIVE number of seconds) can still be interpreted.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await withOAuthLock(this.#storePath, () => {
      const current = this.#record();
      if (!current?.client) {
        throw new Error(`no registered client for ${this.serverUrl}`);
      }
      writeOAuthRecord(this.#storePath, this.serverUrl, {
        ...current,
        tokens,
        expiresAt: expiryOf(tokens, Date.now()),
        codeVerifier: undefined,
      });
    });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.#onRedirect) {
      // The headless proxy reaching here would mean it tried to start an
      // interactive grant with no browser and no TTY, and would otherwise
      // hang. Name the fix instead.
      throw new Error(
        `${this.serverUrl} needs authorization — run: speculate auth ${this.serverUrl}`,
      );
    }
    await this.#onRedirect(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await withOAuthLock(this.#storePath, () => {
      const current = this.#record();
      // The SDK registers the client (saveClientInformation) BEFORE it starts
      // the authorization it needs a verifier for, so a record always exists
      // by now. Asserting that beats casting `undefined` into the type and
      // writing a record whose `client` silently is not there.
      if (!current?.client) {
        throw new Error(`no registered client for ${this.serverUrl}`);
      }
      writeOAuthRecord(this.#storePath, this.serverUrl, {
        ...current,
        serverUrl: this.serverUrl,
        client: current.client,
        codeVerifier: verifier,
      });
    });
  }

  codeVerifier(): string {
    const verifier = this.#record()?.codeVerifier;
    if (!verifier) throw new Error(`no PKCE verifier stored for ${this.serverUrl}`);
    return verifier;
  }

  /**
   * Drop credentials the server has told us are no good.
   *
   * `all` and `client` clear the registration too, which is the only way to
   * recover from a client the authorization server has forgotten; the cost is
   * one orphaned client record, and the alternative is a server that can never
   * be re-authorized without hand-editing the store.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    await withOAuthLock(this.#storePath, () => {
      const current = this.#record();
      if (!current) return;
      if (scope === 'all' || scope === 'client') {
        writeOAuthRecord(this.#storePath, this.serverUrl, undefined);
        return;
      }
      writeOAuthRecord(this.#storePath, this.serverUrl, {
        ...current,
        tokens: scope === 'tokens' ? undefined : current.tokens,
        expiresAt: scope === 'tokens' ? undefined : current.expiresAt,
        codeVerifier: undefined,
      });
    });
  }
}
