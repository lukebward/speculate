/**
 * The remote reachability probe (src/remoteProbe.ts).
 *
 * Every case runs against a real loopback HTTP server rather than a stubbed
 * `fetch`, because the behaviour under test IS the HTTP mapping: which status
 * means "wrap it", which means "the user can fix this with a login", and which
 * means "leave it alone". A stub would only assert our own assumptions back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { probeRemote, parseResourceMetadataUrl } from '../src/remoteProbe.js';

let server: Server | null = null;
/** Every request the probe made, so we can assert on what it sent. */
let received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];

/** Boots a loopback server that answers every request the same way. */
async function serve(
  respond: (res: Parameters<Parameters<typeof createServer>[0]>[1]) => void,
): Promise<string> {
  received = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      respond(res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no port');
  return `http://127.0.0.1:${addr.port}/mcp`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

describe('probeRemote', () => {
  it('says ok when the server completes an initialize', async () => {
    const url = await serve((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }));
    });
    expect(await probeRemote(url, {})).toEqual({ kind: 'ok' });
  });

  it('sends the caller-supplied headers, and a real initialize request', async () => {
    const url = await serve((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await probeRemote(url, { Authorization: 'Bearer probe-token' });

    expect(received).toHaveLength(1);
    expect(received[0].headers.authorization).toBe('Bearer probe-token');
    // Whatever the server checks auth on, it sees the same request the proxy
    // would make: a well-formed MCP initialize.
    expect(JSON.parse(received[0].body)).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
    });
  });

  it('reports needs-auth on 401, with the RFC 9728 metadata pointer', async () => {
    const url = await serve((res) => {
      res.writeHead(401, {
        'www-authenticate':
          'Bearer realm="OAuth", error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
      });
      res.end('Unauthorized');
    });
    expect(await probeRemote(url, {})).toEqual({
      kind: 'needs-auth',
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    });
  });

  it('reports needs-auth on a bare 401 with no challenge header', async () => {
    const url = await serve((res) => {
      res.writeHead(401);
      res.end();
    });
    expect(await probeRemote(url, {})).toEqual({ kind: 'needs-auth', resourceMetadataUrl: undefined });
  });

  it('treats 403 as needs-auth only when the server actually issued a challenge', async () => {
    // A 403 with no challenge is far more likely an IP block or a disabled
    // account than something `speculate auth` could fix. Telling the user to
    // log in would send them somewhere that cannot help.
    const challenged = await serve((res) => {
      res.writeHead(403, { 'www-authenticate': 'Bearer realm="OAuth"' });
      res.end();
    });
    expect((await probeRemote(challenged, {})).kind).toBe('needs-auth');
    await new Promise<void>((r) => server!.close(() => r()));

    const bare = await serve((res) => {
      res.writeHead(403);
      res.end();
    });
    expect(await probeRemote(bare, {})).toEqual({
      kind: 'unreachable',
      reason: 'answered HTTP 403',
    });
  });

  it('reports unreachable for other statuses, quoting the status and not the body', async () => {
    const secretish = 'ECHOED-REQUEST-CONTENTS-token-abc123';
    const url = await serve((res) => {
      res.writeHead(502);
      // Some gateways echo the request back in the error page. The probe must
      // never carry that into a log line.
      res.end(`Bad gateway while proxying ${secretish}`);
    });
    const result = await probeRemote(url, {});
    expect(result).toEqual({ kind: 'unreachable', reason: 'answered HTTP 502' });
    expect(JSON.stringify(result)).not.toContain(secretish);
  });

  it('reports unreachable when nothing is listening', async () => {
    // Port 1 on loopback: reliably refused, no DNS, no external traffic.
    const result = await probeRemote('http://127.0.0.1:1/mcp', {});
    expect(result.kind).toBe('unreachable');
  });
});

describe('parseResourceMetadataUrl', () => {
  it('pulls the url out of a real Sentry challenge', () => {
    // Captured verbatim from mcp.sentry.dev.
    const header =
      'Bearer realm="OAuth", error="invalid_token", error_description="Missing or invalid access token", resource_metadata="https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp"';
    expect(parseResourceMetadataUrl(header)).toBe(
      'https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('returns undefined when there is no pointer to find', () => {
    expect(parseResourceMetadataUrl(null)).toBeUndefined();
    expect(parseResourceMetadataUrl('Bearer realm="OAuth"')).toBeUndefined();
  });

  it('refuses a non-http scheme', () => {
    // The value is remote-controlled and is later FETCHED. `file:` must not
    // survive that trip.
    expect(parseResourceMetadataUrl('Bearer resource_metadata="file:///etc/passwd"')).toBeUndefined();
    expect(parseResourceMetadataUrl('Bearer resource_metadata="/relative/path"')).toBeUndefined();
  });
});
