/**
 * Where Speculate keeps its OWN OAuth credentials.
 *
 * Speculate is a separate OAuth client from the host: it registers itself
 * (RFC 7591), the user approves it once per server, and it holds its own
 * tokens. It never reads the host's credential store — borrowing a token from
 * another application would take over that token's refresh cycle, and on a
 * server that rotates refresh tokens the host's own connection would break the
 * first time Speculate refreshed.
 *
 * Deliberately NOT `managed.json`: that file is a human-readable record of
 * config changes that users are invited to inspect and that `status` prints
 * from. Credentials live apart from it, and nothing here is ever logged.
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

/** One server's credentials. Keyed by canonicalServerUrl in the file. */
export interface StoredOAuth {
  /** Canonical URL, stored so a record is self-describing under its key. */
  serverUrl: string;
  /** From dynamic client registration. Reused forever: see the file note. */
  client: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  /**
   * Epoch ms. WE compute and store this: the MCP SDK contains no expiry logic
   * at all (no `Date.now()` anywhere in its auth or transport code), so it
   * discovers expiry only by sending a doomed request and reading the 401.
   * That is bad for a prefetcher, whose speculative call would burn the
   * transport's one-shot re-auth retry on behalf of a real call.
   */
  expiresAt?: number;
  /** Lives only between `authorize` and the code exchange. */
  codeVerifier?: string;
}

interface StoreFile {
  version: 1;
  servers: Record<string, StoredOAuth>;
}

const EMPTY: StoreFile = { version: 1, servers: {} };

/** Alongside managed.json, under the same state dir, but a separate file. */
export function oauthStorePath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const stateHome =
    xdg && xdg.length > 0 && isAbsolute(xdg)
      ? xdg
      : process.platform === 'win32' && process.env.LOCALAPPDATA
        ? process.env.LOCALAPPDATA
        : join(homedir(), '.local', 'state');
  return join(stateHome, 'speculate', 'oauth.json');
}

/**
 * The key a server's credentials live under.
 *
 * Path is significant and preserved (`/mcp` and `/` are different resources);
 * scheme and host case, and a redundant default port, are not. Throws on an
 * unparseable URL rather than inventing a key that could collide.
 */
export function canonicalServerUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${parsed.protocol.replace(':', '')} is not an http(s) url`);
  }
  parsed.hash = '';
  return parsed.toString();
}

function readFile(path: string): StoreFile {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
    if (data && typeof data === 'object' && data.version === 1 && data.servers) return data;
  } catch {
    // Missing or corrupt reads as empty: the recovery is `speculate auth`
    // again, which is strictly better than refusing to start the proxy.
  }
  return { ...EMPTY, servers: {} };
}

/**
 * Replace the file atomically.
 *
 * `mode: 0o600` is real protection on POSIX and a VERIFIED NO-OP on Windows,
 * where Node writes 666 and the only thing guarding the file is the ACL
 * inherited from %LOCALAPPDATA% (owner + SYSTEM + Administrators). That is the
 * same protection every other Windows application's credential cache gets,
 * including the host's own, but it is not the same as 0600 and is not claimed
 * to be. `doctor` says so out loud.
 */
function writeFileAtomic(path: string, data: StoreFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Same directory, so the rename is atomic rather than a cross-device copy.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** A lock older than this is assumed abandoned by a crashed process. */
const LOCK_STALE_MS = 30_000;
/** Total time to wait for another process's refresh before giving up. */
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;

/**
 * Hold the store exclusively for the duration of `fn`.
 *
 * Unlike sync's fail-fast lock, this one WAITS: a token refresh cannot simply
 * be skipped, and the process that loses the race must end up using the token
 * the winner fetched. Servers that rotate refresh tokens on use make this
 * mandatory — two concurrent refreshes there leave one process holding a
 * refresh token the server has already invalidated.
 */
export async function withOAuthLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  // The deadline is checked at the TOP, and every failing path falls through
  // to the same sleep. Both matter: an earlier version retried immediately
  // when `statSync` failed, which meant a `writeFileSync` failing for any
  // reason other than "already exists" (a read-only state dir, EACCES) span
  // synchronously forever without ever yielding the event loop. Since
  // `tokens()` is on the path of every outbound request, that hung the proxy
  // rather than degrading it.
  while (!held && Date.now() < deadline) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      held = true;
      break;
    } catch {
      // Not ours. If the holder looks abandoned, take it over; otherwise wait.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
          held = true;
          break;
        }
      } catch {
        // Vanished between our write and our stat, or is unreadable. Either
        // way the next attempt decides it; do not spin on it here.
      }
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  // Falling out unlocked beats failing the user's tool call outright: the
  // worst case is a duplicate refresh, the alternative is no call at all.
  try {
    return await fn();
  } finally {
    if (held) {
      try {
        unlinkSync(lockPath);
      } catch {
        // already taken over as stale, or the dir was cleaned up
      }
    }
  }
}

/** One server's stored credentials, or undefined. Never throws. */
export function readOAuthRecord(path: string, serverUrl: string): StoredOAuth | undefined {
  let key: string;
  try {
    key = canonicalServerUrl(serverUrl);
  } catch {
    return undefined;
  }
  return readFile(path).servers[key];
}

/**
 * Write one server's record. Deletes it when `record` is undefined.
 *
 * LOCK-FREE by design, so it can be called from inside `withOAuthLock` — a
 * token refresh must hold the lock across its network call, not merely across
 * the write, or two processes both refresh and one ends up holding a refresh
 * token the server already rotated away. Callers not already under the lock
 * should use `updateOAuthRecord`.
 */
export function writeOAuthRecord(
  path: string,
  serverUrl: string,
  record: StoredOAuth | undefined,
): void {
  const key = canonicalServerUrl(serverUrl);
  const file = readFile(path);
  if (record === undefined) delete file.servers[key];
  else file.servers[key] = record;
  writeFileAtomic(path, file);
}

/**
 * Read-modify-write one server's record under the lock.
 *
 * The re-read INSIDE the lock is the point: another process may have
 * refreshed while we waited, and `mutate` must see that, not the stale record
 * we held before. Returning undefined from `mutate` deletes the record.
 */
export async function updateOAuthRecord(
  path: string,
  serverUrl: string,
  mutate: (current: StoredOAuth | undefined) => StoredOAuth | undefined,
): Promise<StoredOAuth | undefined> {
  return withOAuthLock(path, () => {
    const next = mutate(readOAuthRecord(path, serverUrl));
    writeOAuthRecord(path, serverUrl, next);
    return next;
  });
}

/** Canonical URLs Speculate holds credentials for, for `status`/`doctor`. */
export function listAuthorizedServers(path: string): string[] {
  return Object.keys(readFile(path).servers);
}
