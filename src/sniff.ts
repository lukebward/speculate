/**
 * Protocol-sniffing pass-through (DESIGN.md §13.12).
 *
 * `wrap --sniff` extends the §3.3 degradation property to the transport
 * itself. Instead of assuming the wrapped command speaks MCP, watch the
 * first client→server line: an MCP session always begins with a JSON-RPC
 * `initialize` request (newline-delimited, per the stdio transport spec).
 * See it → run the full speculation proxy. Anything else — a non-JSON
 * line, stdin EOF, or a client that stays quiet past the timeout —
 * degrades to a byte-transparent pipe to the wrapped command, exit code
 * and signals forwarded.
 *
 * This makes over-wrapping harmless by construction, which is what lets
 * launcher shims (`speculate shims install`) interpose on every `npx`/
 * `uvx` on the machine: invocations that aren't MCP cost one buffered
 * first line and nothing else.
 *
 * The timeout matters only for the degenerate cases: MCP clients send
 * `initialize` immediately after spawn (they never wait for server
 * output), so real MCP sessions decide on the first line, not the clock.
 * A client slower than the timeout still works — it just gets the
 * transparent pipe instead of speculation (fail open).
 */
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type { Readable } from 'node:stream';

export const SNIFF_TIMEOUT_MS = 500;
/** A "first line" longer than this is not an MCP initialize. */
const SNIFF_MAX_BYTES = 1024 * 1024;

export interface SniffDecision {
  mcp: boolean;
  /** Everything consumed from stdin while deciding. */
  buffered: Buffer;
  /** stdin reached EOF while sniffing (pipe mode must not wait on it). */
  ended: boolean;
}

/** Is this line the first message of an MCP session? */
export function looksLikeMcpInitialize(line: string): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return false;
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return false;
  const m = msg as { jsonrpc?: unknown; method?: unknown; id?: unknown };
  return (
    m.jsonrpc === '2.0' &&
    m.method === 'initialize' &&
    (typeof m.id === 'number' || typeof m.id === 'string')
  );
}

/**
 * Buffer stdin until its first complete line (or EOF / timeout / size cap)
 * and decide whether this is an MCP session. The stream is left paused
 * with no listeners attached; the caller re-injects `buffered` (via
 * `unshift` for the proxy path, or by writing it to the child for the
 * pipe path).
 */
export function sniffFirstLine(
  stdin: Readable,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SniffDecision> {
  const timeoutMs = opts.timeoutMs ?? SNIFF_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? SNIFF_MAX_BYTES;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (mcp: boolean, ended: boolean): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onEnd);
      stdin.pause();
      resolve({ mcp, buffered: Buffer.concat(chunks, total), ended });
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      const nl = chunk.indexOf(0x0a);
      if (nl !== -1) {
        // First complete line assembled across chunks.
        const all = Buffer.concat(chunks, total);
        const line = all.subarray(0, all.indexOf(0x0a)).toString('utf8');
        finish(looksLikeMcpInitialize(line), false);
        return;
      }
      if (total > maxBytes) finish(false, false);
    };
    const onEnd = (): void => finish(false, true);

    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onEnd);
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(false, false), timeoutMs);
      timer.unref();
    }
  });
}

/**
 * Byte-transparent pipe mode: spawn the wrapped command, replay the
 * sniffed bytes into its stdin, then stream the rest. stdout/stderr are
 * inherited (zero-copy). Resolves with the exit code to use; a
 * signal-terminated child maps to the conventional 128+signum.
 */
export function runPipe(
  command: string[],
  buffered: Buffer,
  stdinEnded: boolean,
  stdin: Readable = process.stdin,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', (err) => {
      process.stderr.write(`[speculate] pipe mode: failed to run ${command[0]}: ${err.message}\n`);
      resolve(127);
    });
    // The child may exit without reading stdin; that must not kill us.
    child.stdin?.on('error', () => {});

    const forward = (sig: NodeJS.Signals) => (): void => {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    if (buffered.length > 0) child.stdin?.write(buffered);
    if (stdinEnded) {
      child.stdin?.end();
    } else {
      stdin.pipe(child.stdin!);
      stdin.resume();
    }

    child.on('exit', (code, signal) => {
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
      if (signal) {
        const num = (osConstants.signals as Record<string, number>)[signal];
        resolve(num ? 128 + num : 1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}
