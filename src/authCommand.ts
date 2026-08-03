/**
 * `speculate auth [server]` — the one interactive step.
 *
 * Speculate authorizes itself as its own OAuth client rather than borrowing
 * the host's token. Borrowing looks free and is not: whoever refreshes a token
 * owns it, so the first time Speculate refreshed, a server that rotates
 * refresh tokens would invalidate the host's copy and break the user's real
 * connection. One consent click, once per server, buys a credential that is
 * ours to refresh and ours to revoke.
 *
 * The friction is kept to that click: with no argument this authorizes EVERY
 * server that needs it, and nothing else has to be run afterwards — `on` and
 * the session-start hook pick the server up on their own once a token exists.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SpeculateOAuthProvider } from './oauthProvider.js';
import {
  canonicalServerUrl,
  oauthStorePath,
  readOAuthRecord,
  updateOAuthRecord,
} from './oauthStore.js';
import { effectiveServers, planRemoteWrap, readClaudeServers, resolveWrapHeaders } from './hostConfig.js';
import { probeRemote, type RemoteProber } from './remoteProbe.js';
import { VERSION } from './version.js';

/**
 * Loopback ports tried in order, and registered together as `redirect_uris`.
 *
 * A fixed set rather than an ephemeral port because the client registration
 * that names them is PERMANENT (no server tested supports RFC 7592 client
 * management, so a registration can never be updated). Five is enough that a
 * collision is vanishingly unlikely, and small enough to register at once.
 */
const CALLBACK_PORTS = [47821, 47822, 47823, 47824, 47825];
const CALLBACK_PATH = '/callback';
/** How long to wait for the user to finish in the browser. */
const CONSENT_TIMEOUT_MS = 300_000;

export interface AuthOptions {
  /** Server name from host config, or a URL. Absent means "everything". */
  target?: string;
  /** Delete Speculate's stored credentials instead of obtaining them. */
  forget?: boolean;
  home?: string;
  cwd?: string;
  storePath?: string;
  log?: (line: string) => void;
  /** Injectable for tests; the real one spawns the OS browser opener. */
  openBrowser?: (url: URL) => Promise<void> | void;
  probeRemote?: RemoteProber;
}

/** Host-config roots, defaulted once so both call sites agree. */
function hostRoots(opts: AuthOptions): { home: string; cwd: string } {
  return { home: opts.home ?? homedir(), cwd: resolve(opts.cwd ?? process.cwd()) };
}

function redirectUriFor(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

/** Opens the user's browser without handing the URL to a shell to re-parse. */
async function defaultOpenBrowser(url: URL): Promise<void> {
  const href = url.toString();
  const [cmd, args] =
    process.platform === 'win32'
      ? // NOT `cmd /c start`: cmd re-parses `&`, which every OAuth URL has,
        // and would truncate the query. FileProtocolHandler takes the URL as
        // a single argument, verbatim.
        ['rundll32.exe', ['url.dll,FileProtocolHandler', href]]
      : process.platform === 'darwin'
        ? ['open', [href]]
        : ['xdg-open', [href]];
  await new Promise<void>((resolve) => {
    // Best-effort: on a headless box there is no opener, and the URL was
    // already printed for the user to paste. Never fail the flow over this.
    execFile(cmd, args, () => resolve());
  });
}

interface Callback {
  port: number;
  /** Resolves with the authorization code, or rejects with the reason. */
  code: Promise<string>;
  close: () => void;
}

/**
 * Binds the loopback listener that receives the authorization redirect.
 *
 * Bound BEFORE the browser opens, so a fast redirect cannot arrive before
 * anything is listening.
 */
async function listenForCallback(state: string): Promise<Callback> {
  let server: Server | null = null;
  let port = 0;
  for (const candidate of CALLBACK_PORTS) {
    const attempt = createServer();
    const ok = await new Promise<boolean>((resolve) => {
      attempt.once('error', () => resolve(false));
      attempt.listen(candidate, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      server = attempt;
      port = candidate;
      break;
    }
    attempt.close();
  }
  if (!server) {
    throw new Error(
      `no free loopback port for the OAuth callback (tried ${CALLBACK_PORTS.join(', ')})`,
    );
  }

  const bound = server;
  let settle: ((code: string) => void) | null = null;
  let reject: ((err: Error) => void) | null = null;
  const code = new Promise<string>((res, rej) => {
    settle = res;
    reject = rej;
  });
  // The callback can arrive BEFORE anyone awaits this: `auth()` opens the
  // browser from inside `connect()`, and a fast redirect lands while connect
  // is still unwinding. An unhandled rejection in that window terminates the
  // process on Node >= 15. This marks it handled without consuming it — the
  // real `await` below still sees the rejection.
  code.catch(() => {});
  const timer = setTimeout(() => {
    reject?.(new Error('timed out waiting for the browser'));
  }, CONSENT_TIMEOUT_MS);
  timer.unref?.();

  bound.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const reply = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`${message}\n`);
    };
    const error = url.searchParams.get('error');
    if (error) {
      // The server's own error text is shown to the USER in their browser but
      // is not trusted into our logs beyond the code.
      reply(400, 'Authorization was denied. You can close this tab.');
      reject?.(new Error(`authorization server returned '${error}'`));
      return;
    }
    // Checked before the code is touched: an attacker who can make the
    // browser hit this loopback URL could otherwise plant their own code.
    if (url.searchParams.get('state') !== state) {
      reply(400, 'State mismatch. You can close this tab.');
      reject?.(new Error('state mismatch on the OAuth callback'));
      return;
    }
    const received = url.searchParams.get('code');
    if (!received) {
      reply(400, 'No authorization code. You can close this tab.');
      reject?.(new Error('no authorization code on the callback'));
      return;
    }
    reply(200, 'Speculate is authorized. You can close this tab.');
    settle?.(received);
  });

  return {
    port,
    code,
    close: () => {
      clearTimeout(timer);
      bound.close();
    },
  };
}

/**
 * Turn a dead end into a next step.
 *
 * Some authorization servers advertise no `registration_endpoint`, so
 * Speculate cannot register itself and no amount of retrying will help.
 * GitHub's hosted MCP server is the one that matters in practice: it
 * advertises metadata at `https://github.com/login/oauth` with no
 * registration endpoint, because it expects clients to be registered by hand
 * as GitHub OAuth apps. That server is still perfectly usable through a token
 * (which is how the README and the live benchmark drive it), so say so
 * instead of surfacing the SDK's accurate but terminal sentence.
 */
function explainAuthFailure(err: unknown, url: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/does not support dynamic client registration/i.test(message)) {
    return (
      `${url} does not offer dynamic client registration, so Speculate cannot register itself.\n` +
      `  Use a token instead: speculate wrap --url ${url} --header "Authorization: Bearer \${YOUR_TOKEN}"`
    );
  }
  return message;
}

/** Fresh client + transport, so verification never reuses a failed one. */
function connectAttempt(url: string, provider: SpeculateOAuthProvider) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
  const client = new Client({ name: 'speculate', version: VERSION }, { capabilities: {} });
  return { transport, client };
}

/**
 * Authorize one server. Returns true when Speculate ends up holding a usable
 * token, whether it already did or just obtained one.
 */
export async function authorizeServer(
  serverUrl: string,
  opts: { storePath: string; log: (line: string) => void; openBrowser: (url: URL) => Promise<void> | void },
): Promise<boolean> {
  const url = canonicalServerUrl(serverUrl);

  // Already holding a token? Try it before sending anyone to a browser.
  if (readOAuthRecord(opts.storePath, url)?.tokens) {
    const probe = new SpeculateOAuthProvider(url, { storePath: opts.storePath });
    const { transport, client } = connectAttempt(url, probe);
    try {
      await client.connect(transport);
      await client.close();
      opts.log(`[speculate] ${url}: already authorized`);
      return true;
    } catch {
      opts.log(`[speculate] ${url}: stored token no longer works — re-authorizing`);
      await client.close().catch(() => {});
    }
  }

  const state = randomBytes(16).toString('hex');
  const callback = await listenForCallback(state);
  try {
    const provider = new SpeculateOAuthProvider(url, {
      storePath: opts.storePath,
      redirectUrl: redirectUriFor(callback.port),
      redirectUrls: CALLBACK_PORTS.map(redirectUriFor),
      state,
      onRedirect: async (authUrl) => {
        // Printed as well as opened: on a headless or SSH session there is no
        // browser to open, and pasting the URL is the only way through.
        opts.log(`[speculate] opening your browser to authorize ${url}`);
        opts.log(`[speculate] if it does not open, visit:\n${authUrl.toString()}`);
        await opts.openBrowser(authUrl);
      },
    });

    const { transport, client } = connectAttempt(url, provider);
    try {
      await client.connect(transport);
      // Connected without needing the flow at all (an open server, or a token
      // that arrived between the check above and here).
      await client.close();
      opts.log(`[speculate] ${url}: authorized`);
      return true;
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
    }

    const code = await callback.code;
    await transport.finishAuth(code);
    await transport.close().catch(() => {});

    // Prove it: a stored token that cannot open a session is worse than none,
    // because `on` would then wrap the server on the strength of it.
    const verify = connectAttempt(url, new SpeculateOAuthProvider(url, { storePath: opts.storePath }));
    await verify.client.connect(verify.transport);
    await verify.client.close();
    opts.log(`[speculate] ${url}: authorized`);
    return true;
  } finally {
    callback.close();
  }
}

/** Remote servers in host config that answer "needs auth" right now. */
async function findServersNeedingAuth(
  opts: AuthOptions,
  prober: RemoteProber,
): Promise<{ name: string; url: string }[]> {
  const view = readClaudeServers(hostRoots(opts));
  const out: { name: string; url: string }[] = [];
  for (const [name, scoped] of effectiveServers(view.servers)) {
    const plan = planRemoteWrap(scoped.entry);
    if (!plan?.wrappable) continue;
    const headers = resolveWrapHeaders(plan.headers);
    if (!headers.ok) continue;
    const probe = await prober(plan.url, headers.headers);
    if (probe.kind === 'needs-auth') out.push({ name, url: plan.url });
  }
  return out;
}

/** Resolves a name from host config to its URL; passes a URL straight through. */
function resolveTarget(target: string, opts: AuthOptions): string {
  try {
    return canonicalServerUrl(target);
  } catch {
    // Not a URL — treat it as a server name.
  }
  const view = readClaudeServers(hostRoots(opts));
  const scoped = effectiveServers(view.servers).get(target);
  if (!scoped) throw new Error(`no MCP server named '${target}' in this project`);
  const plan = planRemoteWrap(scoped.entry);
  if (!plan) throw new Error(`'${target}' is a local (stdio) server — it needs no authorization`);
  if (!plan.wrappable) throw new Error(`'${target}' cannot be wrapped: ${plan.reason}`);
  return canonicalServerUrl(plan.url);
}

export async function speculateAuth(opts: AuthOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const storePath = opts.storePath ?? oauthStorePath();
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser;
  const prober = opts.probeRemote ?? probeRemote;

  if (opts.forget) {
    if (!opts.target) {
      log('[speculate] --forget needs a server name or url');
      return 1;
    }
    let url: string;
    try {
      url = resolveTarget(opts.target, opts);
    } catch (err) {
      log(`[speculate] ${(err as Error).message}`);
      return 1;
    }
    // Local only. Speculate cannot revoke server-side: no server tested
    // advertises a revocation endpoint it will accept from a public client,
    // so say what actually happened rather than implying more.
    await updateOAuthRecord(storePath, url, () => undefined);
    log(`[speculate] ${url}: local credentials deleted`);
    log('[speculate] revoke Speculate\'s access at the provider to invalidate it server-side');
    return 0;
  }

  let targets: { name: string; url: string }[];
  if (opts.target) {
    try {
      targets = [{ name: opts.target, url: resolveTarget(opts.target, opts) }];
    } catch (err) {
      log(`[speculate] ${(err as Error).message}`);
      return 1;
    }
  } else {
    targets = await findServersNeedingAuth(opts, prober);
    if (targets.length === 0) {
      log('[speculate] no MCP server here needs authorization');
      return 0;
    }
    log(
      `[speculate] ${targets.length} server${targets.length === 1 ? '' : 's'} to authorize: ${targets
        .map((t) => t.name)
        .join(', ')}`,
    );
  }

  let failed = 0;
  for (const target of targets) {
    try {
      await authorizeServer(target.url, { storePath, log, openBrowser });
    } catch (err) {
      failed++;
      log(`[speculate] ${target.name}: authorization failed: ${explainAuthFailure(err, target.url)}`);
    }
  }
  if (failed > 0) return 1;
  // Deliberately says nothing about WHEN wrapping happens: the CLI wraps
  // straight after this returns when the project is already managed by `on`,
  // and this function is also called from inside `on` itself.
  log('[speculate] done');
  return 0;
}
