/**
 * Upstream MCP server connection (DESIGN.md §3.1 connection pool).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment, } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ToolListChangedNotificationSchema, } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from './version.js';
import { SpeculateOAuthProvider } from './oauthProvider.js';
/**
 * Shortest header value Upstream#redact will scrub. Below this a value is far
 * more likely to be an innocuous literal ('1', 'v2') whose redaction would
 * mangle unrelated text than a credential worth protecting.
 */
const MIN_REDACTABLE_LENGTH = 8;
export class Upstream {
    name;
    transport;
    tools = [];
    connected = false;
    instructions;
    client = null;
    config;
    onToolsChanged = null;
    onDisconnect = null;
    constructor(name, config) {
        this.name = name;
        this.config = config;
        this.transport = config.url ? 'http' : 'stdio';
    }
    setToolsChangedHandler(fn) {
        this.onToolsChanged = fn;
    }
    /** Fired when the upstream connection dies (child exit, transport close). */
    setDisconnectHandler(fn) {
        this.onDisconnect = fn;
    }
    /**
     * HTTP header NAMES this upstream sends. Names are safe to print; VALUES
     * are credentials and are deliberately unreachable from outside this
     * class; the only thing that ever touches them is redact() below.
     */
    headerNames() {
        return Object.keys(this.config.headers ?? {});
    }
    /**
     * Remove any configured header value from text that is about to be LOGGED.
     *
     * Defense in depth, not the primary guard: no code path here prints a
     * header, and no current transport echoes request headers back in an error.
     * But upstream error text is arbitrary remote-influenced data that several
     * modules write straight to stderr (proxy connect failures, executor
     * suppression reasons, the §9 decision log), and a token reaching any of
     * them would be unrecoverable: the user would have to rotate it. So the
     * scrub happens at this boundary, once, rather than at each of those call
     * sites, and covers ones added later for free.
     *
     * Short values are skipped: redacting a 3-character header value would
     * corrupt unrelated messages far more often than it would protect anything,
     * and no credential is that short.
     */
    redact(text) {
        let out = text;
        for (const value of Object.values(this.config.headers ?? {})) {
            if (value.length >= MIN_REDACTABLE_LENGTH && out.includes(value)) {
                out = out.split(value).join('[redacted]');
            }
        }
        return out;
    }
    /**
     * Scrub an error on its way out of this class. Mutates `message` in place
     * rather than re-wrapping so the error's prototype survives: callers do
     * `instanceof McpError` and regex the message (executor.ts), and a
     * defensive log guard must not change how errors are classified.
     */
    scrubError(err) {
        if (err instanceof Error) {
            const redacted = this.redact(err.message);
            if (redacted !== err.message)
                err.message = redacted;
        }
        return err;
    }
    async connect() {
        try {
            await this.connectInner();
        }
        catch (err) {
            throw this.scrubError(err);
        }
    }
    async connectInner() {
        const client = new Client({ name: 'speculate', version: VERSION }, { capabilities: {} });
        const transport = this.config.url
            ? new StreamableHTTPClientTransport(new URL(this.config.url), {
                // Copied, not aliased: the transport keeps this object for the life
                // of the connection and must not observe later config edits.
                ...(this.config.headers
                    ? { requestInit: { headers: { ...this.config.headers } } }
                    : {}),
                ...(this.config.oauthStorePath
                    ? {
                        authProvider: new SpeculateOAuthProvider(this.config.url, {
                            storePath: this.config.oauthStorePath,
                        }),
                    }
                    : {}),
            })
            : new StdioClientTransport({
                command: this.config.command,
                args: this.config.args ?? [],
                env: { ...getDefaultEnvironment(), ...(this.config.env ?? {}) },
                ...(this.config.cwd === undefined ? {} : { cwd: this.config.cwd }),
                stderr: 'inherit',
            });
        await client.connect(transport);
        this.client = client;
        this.instructions = client.getInstructions?.();
        client.onclose = () => {
            // A dead upstream must stop routing/speculation immediately; cached
            // entries fetched over the old connection are flushed by the proxy
            // (§6.4 restart flush).
            if (this.connected) {
                this.connected = false;
                this.onDisconnect?.();
            }
        };
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
            try {
                await this.refreshTools();
            }
            catch {
                // keep last-known tool list on refresh failure
            }
            this.onToolsChanged?.();
        });
        try {
            await this.refreshTools();
        }
        catch (err) {
            // A half-connected upstream (handshake ok, first listTools failed) must
            // not linger: tear down so capabilities() reads undefined and the child
            // process dies now rather than at proxy shutdown.
            await this.close();
            throw err;
        }
        this.connected = true;
    }
    async refreshTools() {
        if (!this.client)
            throw new Error(`upstream ${this.name} not connected`);
        const res = await this.client.listTools();
        this.tools = res.tools;
    }
    async callTool(tool, args, opts = {}) {
        if (!this.client)
            throw new Error(`upstream ${this.name} not connected`);
        let result;
        try {
            result = await this.client.callTool({ name: tool, arguments: args }, CallToolResultSchema, {
                timeout: opts.timeoutMs ?? 60_000,
                resetTimeoutOnProgress: opts.resetTimeoutOnProgress ?? false,
                onprogress: opts.onprogress,
            });
        }
        catch (err) {
            // Call errors reach the decision log and the executor's suppression
            // reason, both of which are written to stderr verbatim.
            throw this.scrubError(err);
        }
        return result;
    }
    /** Upstream-declared capabilities (available after connect). */
    capabilities() {
        return this.client?.getServerCapabilities();
    }
    // Typed pass-through for non-tool traffic (single-upstream mode, §10).
    listResources(params) {
        return this.requireClient().listResources(params);
    }
    readResource(params) {
        return this.requireClient().readResource(params);
    }
    listResourceTemplates(params) {
        return this.requireClient().listResourceTemplates(params);
    }
    listPrompts(params) {
        return this.requireClient().listPrompts(params);
    }
    getPrompt(params) {
        return this.requireClient().getPrompt(params);
    }
    requireClient() {
        if (!this.client)
            throw new Error(`upstream ${this.name} not connected`);
        return this.client;
    }
    async close() {
        this.connected = false;
        try {
            await this.client?.close();
        }
        catch {
            // best-effort shutdown
        }
        this.client = null;
    }
}
/**
 * ENOENT and friends deserve a human sentence, not a raw errno.
 *
 * Every return path goes through `up.redact`, including the `String(err)`
 * branch that Upstream#scrubError cannot reach (a thrown non-Error).
 */
export function friendlySpawnError(err, up) {
    const msg = up.redact(err instanceof Error ? err.message : String(err));
    if (/ENOENT/.test(msg) && up.transport === 'stdio') {
        return `command not found (is it installed and on PATH?): ${msg}`;
    }
    if (/ECONNREFUSED|fetch failed/i.test(msg) && up.transport === 'http') {
        return `server unreachable (is it running?): ${msg}`;
    }
    return msg;
}
/** Heuristic auth/permission failure detection for the §4 breaker. */
export function looksLikeAuthError(input) {
    const text = `${input.message ?? ''} ${input.resultText ?? ''}`;
    return /\b(unauthorized|forbidden|permission denied|not authorized|invalid[ _-]?token|expired[ _-]?token|401|403)\b/i.test(text);
}
/** First text block of a result, for error sniffing/logging. */
export function resultText(result) {
    for (const block of result.content ?? []) {
        if (block.type === 'text')
            return block.text;
    }
    return '';
}
