import { createConnection } from 'node:net';

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const DEADLINE_MS = 20;
let socket;
let settled = false;
let bytes = 0;
const chunks = [];

function finish() {
  if (settled) return;
  settled = true;
  clearTimeout(deadline);
  socket?.destroy();
  process.exit(0);
}

const deadline = setTimeout(finish, DEADLINE_MS);
process.stdin.on('data', (chunk) => {
  bytes += chunk.length;
  if (bytes > MAX_EVENT_BYTES) finish();
  else chunks.push(chunk);
});
process.stdin.on('error', finish);
process.stdin.on('end', () => {
  if (settled) return;
  const socketPath = process.env.SPECULATE_OBSERVER_SOCKET;
  const capability = process.env.SPECULATE_OBSERVER_CAPABILITY;
  const launchId = process.env.SPECULATE_OBSERVER_LAUNCH_ID;
  const hostClient = process.env.SPECULATE_OBSERVER_CLIENT;
  if (!socketPath || !capability || !launchId || (hostClient !== 'claude' && hostClient !== 'codex')) return finish();
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return finish();
  }
  socket = createConnection(socketPath);
  socket.on('error', finish);
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ type: 'hook', capability, launchId, hostClient, payload })}\n`, finish);
  });
});
