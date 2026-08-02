/**
 * Authenticated HTTP upstreams: the headers a config declares must actually
 * reach the wire, and their VALUES must never reach a log.
 *
 * These run against a real loopback HTTP server rather than a mocked SDK
 * transport, because the property under test is exactly "does the header
 * arrive?", and a mock of the constructor would assert our own call rather
 * than the request.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Upstream, friendlySpawnError } from '../src/upstream.js';
import { runDoctor } from '../src/doctor.js';
import type { SpeculateConfig } from '../src/types.js';

const TOKEN = 'ghp_super_secret_token_value';

const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/**
 * A loopback MCP endpoint that records what it was sent and then refuses.
 * The 401 body deliberately ECHOES the Authorization header: that is the
 * shape of a chatty upstream, and it is what makes the redaction assertion
 * below a real test rather than a tautology.
 */
async function recordingServer(): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `rejected credentials: ${String(req.headers['authorization'] ?? '')}`,
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, seen };
}

describe('http upstream headers', () => {
  it('sends the configured headers on the wire', async () => {
    const { url, seen } = await recordingServer();
    const up = new Upstream('remote', {
      url,
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Api-Version': '2026-01-01' },
    });

    await expect(up.connect()).rejects.toThrow();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!['x-api-version']).toBe('2026-01-01');
    await up.close();
  });

  it('connects without a headers block exactly as before', async () => {
    const { url, seen } = await recordingServer();
    const up = new Upstream('remote', { url });
    await expect(up.connect()).rejects.toThrow();
    expect(seen[0]!['authorization']).toBeUndefined();
    await up.close();
  });

  it('scrubs a header value out of the error the upstream throws', async () => {
    const { url } = await recordingServer();
    const up = new Upstream('remote', { url, headers: { Authorization: `Bearer ${TOKEN}` } });

    const err = await up.connect().then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).not.toBeNull();
    // The server echoed the token back; nothing downstream may see it.
    expect(err!.message).not.toContain(TOKEN);
    expect(friendlySpawnError(err, up)).not.toContain(TOKEN);
    await up.close();
  });

  it('redacts header values from arbitrary text, and leaves short ones alone', () => {
    const up = new Upstream('remote', {
      url: 'https://example.test/mcp',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Ver': '2' },
    });
    // The whole VALUE is the secret, `Bearer ` scheme prefix included.
    expect(up.redact(`sent Bearer ${TOKEN} upstream`)).toBe('sent [redacted] upstream');
    // A 1-character value would otherwise mangle every message containing '2'.
    expect(up.redact('retried 2 times')).toBe('retried 2 times');
  });

  it('exposes header names but never values', () => {
    const up = new Upstream('remote', {
      url: 'https://example.test/mcp',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(up.headerNames()).toEqual(['Authorization']);
    expect(JSON.stringify(up.headerNames())).not.toContain(TOKEN);
  });
});

describe('doctor with an authenticated http upstream', () => {
  it('names the headers it will send and redacts every value', async () => {
    // Port 1 on loopback refuses immediately on every platform, so this
    // exercises the failure path without waiting on a connect timeout.
    const config: SpeculateConfig = {
      mode: 'annotated',
      maxPredictionsPerTrigger: 3,
      log: 'off',
      servers: {
        remote: {
          url: 'http://127.0.0.1:1/mcp',
          headers: { Authorization: `Bearer ${TOKEN}`, 'X-Api-Version': '2026-01-01' },
        },
      },
    };
    const lines: string[] = [];

    await runDoctor(config, null, (line) => lines.push(line));

    const out = lines.join('\n');
    expect(out).toContain('Authorization');
    expect(out).toContain('X-Api-Version');
    expect(out).toContain('redacted');
    expect(out).not.toContain(TOKEN);
  }, 30_000);
});
