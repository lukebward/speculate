/**
 * "Can Speculate actually connect to this remote server with what it holds?"
 *
 * Wrapping rewrites the user's MCP config to route a server through Speculate.
 * If Speculate then cannot connect, the user is left with a server that WAS
 * working and now is not — the worst outcome this tool can produce. Config
 * shape alone cannot answer the question: an OAuth-protected server and an
 * unauthenticated self-hosted one are byte-identical in `~/.claude.json`
 * (`{"type":"http","url":"…"}`), because the OAuth token lives in the host's
 * credential store, not in the entry. Verified against mcp.sentry.dev, whose
 * entry carries nothing and whose server answers 401.
 *
 * So we ask the server, with exactly the credentials the wrapped proxy would
 * use. Wrap only on a definite yes.
 */

/** Nothing here carries a header value, a token, or a response body. */
export type RemoteProbe =
  /** Connected. The wrapped proxy will connect too. */
  | { kind: 'ok' }
  /**
   * The server wants credentials Speculate does not have. Recoverable by the
   * user: `speculate auth <name>`. `resourceMetadataUrl` is the RFC 9728
   * pointer from `WWW-Authenticate`, which is the reliable way to find the
   * authorization server (the bare `/.well-known/oauth-protected-resource`
   * path 404s on Sentry; only the path-suffixed URL the header names works).
   */
  | { kind: 'needs-auth'; resourceMetadataUrl?: string }
  /** Anything else. Not our business to fix, and not safe to wrap. */
  | { kind: 'unreachable'; reason: string };

export type RemoteProber = (
  url: string,
  headers: Record<string, string>,
) => Promise<RemoteProbe>;

/** `on` runs this per new remote server, and `sync` runs it at session start. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * `resource_metadata="https://…"` out of a WWW-Authenticate challenge.
 *
 * Deliberately narrow: only an absolute http(s) URL is accepted, because the
 * value is remote-controlled and is later fetched. A relative or `file:` value
 * is dropped rather than resolved.
 */
export function parseResourceMetadataUrl(header: string | null): string | undefined {
  if (!header) return undefined;
  const m = /resource_metadata\s*=\s*"([^"]*)"/i.exec(header);
  if (!m) return undefined;
  try {
    const url = new URL(m[1]);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * One MCP `initialize`, which is the cheapest request that exercises auth.
 *
 * The handshake is left DELIBERATELY unfinished — no `notifications/
 * initialized` follows — so a server that allocates session state on
 * initialize can garbage-collect it instead of holding a session this probe
 * will never use.
 */
export const probeRemote: RemoteProber = async (url, headers) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'speculate-probe', version: '1' },
        },
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // Network-level failure. The message can quote the URL but never a header.
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'unreachable', reason: `did not respond (${reason})` };
  }

  if (res.ok) return { kind: 'ok' };

  const challenge = res.headers.get('www-authenticate');
  if (res.status === 401 || (res.status === 403 && challenge)) {
    return { kind: 'needs-auth', resourceMetadataUrl: parseResourceMetadataUrl(challenge) };
  }
  // The BODY is never read: it is remote-controlled text that would end up in
  // a log line, and on some servers it echoes the request back.
  return { kind: 'unreachable', reason: `answered HTTP ${res.status}` };
};
