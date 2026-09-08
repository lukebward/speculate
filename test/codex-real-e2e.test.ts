/** Optional end-to-end check against an installed Codex CLI; never uses user configuration. */
import { it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startCodexClient, resolveCodexBin, type CodexClient, type CodexConfigRead } from '../src/codexClient.js';
import { win32ShimInvocation } from '../src/manage.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it.runIf(process.env.SPECULATE_REAL_CODEX_TEST === '1')(
  'wraps real Codex registrations, serves MCP calls under current policy, and restores both transports',
  async () => {
    const run = promisify(execFile);
    const bin = resolveCodexBin(process.env.SPECULATE_REAL_CODEX_BIN ?? process.env.SPECULATE_CODEX_BIN ?? 'codex');
    const cli = join(root, 'dist/src/cli.js');
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'speculate-codex-real-')));
    const codexHome = join(temporary, 'codex-home');
    const project = join(temporary, 'project');
    const childCwd = join(temporary, 'server-cwd');
    for (const dir of [codexHome, project, childCwd]) mkdirSync(dir);
    const configFile = join(codexHome, 'config.toml');
    const callLog = join(temporary, 'calls.jsonl');
    const fixtureFile = join(temporary, 'fixture.cjs');
    const env = { ...process.env, CODEX_HOME: codexHome, XDG_STATE_HOME: join(temporary, 'state'),
      SPECULATE_CODEX_BIN: bin, CODEX_E2E_BEARER: 'fixture-bearer-token', CODEX_E2E_HEADER: 'fixture-env-header' };
    const evidence: Record<string, any> = { createdAt: new Date().toISOString(), node: process.version, providerCalls: 0, checks: [], timingsMs: {} };
    const mark = (name: string) => { evidence.checks.push(name); process.stdout.write(`PASS ${name}\n`); };
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let httpServer: Server | undefined;
    let activeClient: Client | undefined;

    async function command(command: string, args: string[]) {
      const started = performance.now();
      const viaShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
      const invocation = viaShim ? win32ShimInvocation(command, args) : { file: command, args };
      const result = await run(invocation.file, invocation.args, { env, cwd: project, timeout: 30_000, maxBuffer: 1024 * 1024,
        ...(viaShim ? { windowsVerbatimArguments: true } : {}) });
      return { ...result, milliseconds: Math.round(performance.now() - started) };
    }
    async function setup(action: 'on' | 'off') {
      const result = await command(process.execPath, [cli, action, '--client', 'codex', '--codex-bin', bin]);
      evidence.timingsMs[action] = result.milliseconds;
      evidence[`${action}Output`] = result.stdout + result.stderr;
      return result;
    }
    async function native<T>(fn: (client: CodexClient, view: CodexConfigRead) => Promise<T>): Promise<T> {
      const client = await startCodexClient({ bin, cwd: project, env });
      try { return await fn(client, await client.readConfig(project)); } finally { await client.close(); }
    }
    const read = () => native(async (_client, view) => view.config as Record<string, any>);
    async function edit(keyPath: string, value: unknown) {
      return native(async (client, view) => {
        const user = view.layers.find((layer) => layer.name.type === 'user' && !layer.name.profile);
        assert.ok(user?.name.file);
        await client.writeConfig({ filePath: user.name.file, expectedVersion: user.version,
          edits: [{ keyPath, value, mergeStrategy: 'replace' }] });
      });
    }

    async function connect(entry: Record<string, any>) {
      let stdout = '';
      let stderr = '';
      const transportErrors: string[] = [];
      class RecordingTransport extends StdioClientTransport {
        async start() {
          await super.start();
          // Observe raw bytes as well as parsed SDK messages so diagnostic
          // output on the MCP channel cannot pass unnoticed.
          const child = (this as unknown as { _process: ChildProcessWithoutNullStreams })._process;
          child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        }
      }
      const transport = new RecordingTransport({ command: entry.command, args: entry.args,
        cwd: entry.cwd ?? project, env: { ...env, ...(entry.env ?? {}) }, stderr: 'pipe' });
      transport.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const client = new Client({ name: 'speculate-real-codex-smoke', version: '1' });
      client.onerror = (error) => { transportErrors.push(error.message); };
      activeClient = client;
      const started = performance.now();
      await client.connect(transport);
      const startupMs = Math.round(performance.now() - started);
      return { client, startupMs, async close() {
        await client.close(); activeClient = undefined;
        assert.deepEqual(transportErrors, []);
        assert.ok(stdout.trim().length > 0);
        for (const line of stdout.trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
        assert.ok(!stderr.includes('fixture-bearer-token'));
        return { protocolLines: stdout.trim().split('\n').length, startupMs };
      } };
    }
    async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name} returned an error`);
      const text = (result.content as Array<{ type: string; text?: string }>).find((block) => block.type === 'text')?.text;
      assert.equal(typeof text, 'string');
      return JSON.parse(text!);
    }

    try {
      const version = await command(bin, ['--version']);
      evidence.codex = version.stdout.trim();
      writeFileSync(fixtureFile, `
        const fs = require('node:fs');
        const { createInterface } = require('node:readline');
        const names = ['seed', 'read_next', 'prompt_read', 'disabled_read', 'write_tool'];
        createInterface({ input: process.stdin }).on('line', async (line) => {
          const message = JSON.parse(line);
          if (message.id === undefined) return;
          let result;
          if (message.method === 'initialize') result = {
            protocolVersion: message.params.protocolVersion,
            serverInfo: { name: 'codex-stdio-fixture', version: '1' }, capabilities: { tools: {} }
          };
          else if (message.method === 'tools/list') result = { tools: names.map((name) => ({
            name, inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
            annotations: { readOnlyHint: name !== 'write_tool' }
          })) };
          else if (message.method === 'tools/call') {
            fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ name: message.params.name, args: message.params.arguments }) + '\\n');
            await new Promise((resolve) => setTimeout(resolve, 40));
            result = { content: [{ type: 'text', text: JSON.stringify({
              name: message.params.name, key: message.params.arguments.key,
              cwd: process.cwd(), context: process.env.CODEX_E2E_CONTEXT
            }) }] };
          } else result = {};
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
        });
      `);
      const seenHeaders: IncomingHttpHeaders[] = [];
      httpServer = createServer((request, response) => {
        seenHeaders.push(request.headers);
        if (request.method === 'GET') { response.writeHead(405); response.end(); return; }
        if (request.method === 'DELETE') { response.writeHead(200); response.end(); return; }
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          const message = JSON.parse(body);
          if (message.id === undefined) { response.writeHead(202); response.end(); return; }
          let result;
          if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion,
            serverInfo: { name: 'codex-http-fixture', version: '1' }, capabilities: { tools: {} } };
          else if (message.method === 'tools/list') result = { tools: [{ name: 'remote_read',
            inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] };
          else result = { content: [{ type: 'text', text: JSON.stringify({ value: 'remote-result' }) }] };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        });
      });
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
      writeFileSync(configFile, `# Preserve this unrelated comment.\nsmoke_metadata = "before"\n\n` +
        `[mcp_servers.stdio_fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixtureFile)}]\n` +
        `cwd = ${JSON.stringify(childCwd)}\nstartup_timeout_sec = 30\n` +
        `env = { CODEX_E2E_CONTEXT = "configured-context" }\ndisabled_tools = ["disabled_read"]\n` +
        `default_tools_approval_mode = "auto"\n[mcp_servers.stdio_fixture.tools.prompt_read]\napproval_mode = "prompt"\n\n` +
        `[mcp_servers.remote_fixture]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "CODEX_E2E_BEARER"\n` +
        'http_headers = { X-Literal = \'${DO_NOT_EXPAND}\' }\nenv_http_headers = { X-Env = "CODEX_E2E_HEADER" }\n');
      const before = await read();
      const installed = await setup('on');
      assert.ok(installed.stdout.includes('stdio_fixture: wrapped') || installed.stderr.includes('stdio_fixture: wrapped'));
      assert.ok(installed.stdout.includes('remote_fixture: wrapped') || installed.stderr.includes('remote_fixture: wrapped'));
      const wrapped = await read();
      assert.ok(wrapped.mcp_servers.stdio_fixture.args.includes('--codex-server'));
      assert.equal(wrapped.mcp_servers.stdio_fixture.cwd, undefined);
      assert.ok(wrapped.mcp_servers.stdio_fixture.args.includes(childCwd));
      mark('native on installs stdio and Streamable HTTP wrappers');
      const listed = JSON.parse((await command(bin, ['mcp', 'list', '--json'])).stdout);
      assert.equal(listed.length, 2);
      for (const name of ['stdio_fixture', 'remote_fixture']) {
        const got = JSON.parse((await command(bin, ['mcp', 'get', name, '--json'])).stdout);
        assert.equal(got.transport.type, 'stdio');
      }
      mark('real Codex mcp get/list accept installed registrations');

      const stdio = await connect(wrapped.mcp_servers.stdio_fixture);
      const tools = await stdio.client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === 'speculate__stats'));
      const result = await call(stdio.client, 'seed', { key: 'fixed' });
      assert.deepEqual(result, { name: 'seed', key: 'fixed', cwd: childCwd, context: 'configured-context' });
      for (let index = 0; index < 26; index++) {
        for (const name of ['seed', 'read_next', 'prompt_read', 'disabled_read']) await call(stdio.client, name, { key: 'fixed' });
      }
      await call(stdio.client, 'write_tool', { key: 'fixed' });
      await sleep(100);
      const stats = await call(stdio.client, 'speculate__stats');
      evidence.fullStats = stats;
      assert.ok(stats.speculativeCalls > 0, 'fixture must exercise active speculation');
      const actualCalls = readFileSync(callLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      for (const name of ['prompt_read', 'disabled_read', 'write_tool']) {
        assert.equal(stats.perTool.upstream[name]?.speculativeCalls ?? 0, 0);
        assert.equal(actualCalls.filter((call) => call.name === name).length, name === 'write_tool' ? 1 : 26);
      }
      evidence.workflow = { requestedCalls: 106, speculativeCalls: stats.speculativeCalls,
        hits: stats.hits, joins: stats.joins, policyBlockedTools: ['prompt_read', 'disabled_read', 'write_tool'] };
      evidence.stdio = await stdio.close();
      mark('installed stdio wrapper preserves child env/cwd and uncontaminated MCP stdout');
      mark('repeated real MCP workflow speculates while prompt, disabled, and write tools receive zero prefetches');

      const remote = await connect(wrapped.mcp_servers.remote_fixture);
      assert.deepEqual(await call(remote.client, 'remote_read'), { value: 'remote-result' });
      evidence.remote = await remote.close();
      assert.ok(seenHeaders.length >= 3);
      for (const headers of seenHeaders) {
        assert.equal(headers['authorization'], 'Bearer fixture-bearer-token');
        assert.equal(headers['x-literal'], '${DO_NOT_EXPAND}');
        assert.equal(headers['x-env'], 'fixture-env-header');
      }
      mark('remote wrapper sends literal static, env, and bearer headers on the wire');

      await edit('mcp_servers.stdio_fixture.enabled_tools', []);
      await edit('smoke_metadata', 'after');
      const restrictive = await connect(wrapped.mcp_servers.stdio_fixture);
      for (let index = 0; index < 5; index++) {
        await call(restrictive.client, 'seed', { key: 'fixed' });
        await call(restrictive.client, 'read_next', { key: 'fixed' });
      }
      const restrictedStats = await call(restrictive.client, 'speculate__stats');
      assert.equal(restrictedStats.speculativeCalls, 0);
      assert.equal(restrictedStats.mode, 'strict');
      await restrictive.close();
      mark('startup rereads changed Codex enabled-tools policy with existing learner state');

      await setup('off');
      const restored = await read();
      assert.match(readFileSync(configFile, 'utf8'), /smoke_metadata\s*=\s*"after"/);
      assert.deepEqual(restored.mcp_servers.stdio_fixture, { ...before.mcp_servers.stdio_fixture, enabled_tools: [] });
      assert.deepEqual(restored.mcp_servers.remote_fixture, before.mcp_servers.remote_fixture);
      assert.ok(readFileSync(configFile, 'utf8').includes('# Preserve this unrelated comment.'));
      mark('off restores both transport semantics while retaining later policy/settings edits and comments');
      evidence.success = true;
    } finally {
      await activeClient?.close();
      if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
      rmSync(temporary, { recursive: true, force: true });
      assert.equal(existsSync(temporary), false);
      console.info(JSON.stringify({ codex: evidence.codex, timingsMs: evidence.timingsMs, workflow: evidence.workflow }));
    }
  },
  90_000,
);
