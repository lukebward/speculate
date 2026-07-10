/**
 * Upstream MCP server connection (DESIGN.md §3.1 connection pool).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig, UpstreamTransport } from './types.js';

export interface CallOptions {
  timeoutMs?: number;
  /** Restart the timeout clock on each progress notification (long tools). */
  resetTimeoutOnProgress?: boolean;
  onprogress?: (progress: { progress: number; total?: number; message?: string }) => void;
}

export class Upstream {
  readonly name: string;
  readonly transport: UpstreamTransport;
  tools: Tool[] = [];
  connected = false;
  instructions: string | undefined;

  private client: Client | null = null;
  private readonly config: ServerConfig;
  private onToolsChanged: (() => void) | null = null;
  private onDisconnect: (() => void) | null = null;

  constructor(name: string, config: ServerConfig) {
    this.name = name;
    this.config = config;
    this.transport = config.url ? 'http' : 'stdio';
  }

  setToolsChangedHandler(fn: () => void): void {
    this.onToolsChanged = fn;
  }

  /** Fired when the upstream connection dies (child exit, transport close). */
  setDisconnectHandler(fn: () => void): void {
    this.onDisconnect = fn;
  }

  async connect(): Promise<void> {
    const client = new Client(
      { name: 'speculate', version: '0.1.0' },
      { capabilities: {} },
    );
    const transport = this.config.url
      ? new StreamableHTTPClientTransport(new URL(this.config.url))
      : new StdioClientTransport({
          command: this.config.command!,
          args: this.config.args ?? [],
          env: { ...getDefaultEnvironment(), ...(this.config.env ?? {}) },
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
      } catch {
        // keep last-known tool list on refresh failure
      }
      this.onToolsChanged?.();
    });
    try {
      await this.refreshTools();
    } catch (err) {
      // A half-connected upstream (handshake ok, first listTools failed) must
      // not linger: tear down so capabilities() reads undefined and the child
      // process dies now rather than at proxy shutdown.
      await this.close();
      throw err;
    }
    this.connected = true;
  }

  async refreshTools(): Promise<void> {
    if (!this.client) throw new Error(`upstream ${this.name} not connected`);
    const res = await this.client.listTools();
    this.tools = res.tools;
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    opts: CallOptions = {},
  ): Promise<CallToolResult> {
    if (!this.client) throw new Error(`upstream ${this.name} not connected`);
    const result = await this.client.callTool(
      { name: tool, arguments: args },
      CallToolResultSchema,
      {
        timeout: opts.timeoutMs ?? 60_000,
        resetTimeoutOnProgress: opts.resetTimeoutOnProgress ?? false,
        onprogress: opts.onprogress,
      },
    );
    return result as CallToolResult;
  }

  /** Upstream-declared capabilities (available after connect). */
  capabilities(): Record<string, unknown> | undefined {
    return this.client?.getServerCapabilities() as Record<string, unknown> | undefined;
  }

  // Typed pass-through for non-tool traffic (single-upstream mode, §10).
  listResources(params?: Record<string, unknown>) {
    return this.requireClient().listResources(params);
  }
  readResource(params: { uri: string }) {
    return this.requireClient().readResource(params);
  }
  listResourceTemplates(params?: Record<string, unknown>) {
    return this.requireClient().listResourceTemplates(params);
  }
  listPrompts(params?: Record<string, unknown>) {
    return this.requireClient().listPrompts(params);
  }
  getPrompt(params: { name: string; arguments?: Record<string, string> }) {
    return this.requireClient().getPrompt(params);
  }

  private requireClient(): Client {
    if (!this.client) throw new Error(`upstream ${this.name} not connected`);
    return this.client;
  }

  async close(): Promise<void> {
    this.connected = false;
    try {
      await this.client?.close();
    } catch {
      // best-effort shutdown
    }
    this.client = null;
  }
}

/** Heuristic auth/permission failure detection for the §4 breaker. */
export function looksLikeAuthError(input: { message?: string; resultText?: string }): boolean {
  const text = `${input.message ?? ''} ${input.resultText ?? ''}`;
  return /\b(unauthorized|forbidden|permission denied|not authorized|invalid[ _-]?token|expired[ _-]?token|401|403)\b/i.test(
    text,
  );
}

/** First text block of a result, for error sniffing/logging. */
export function resultText(result: CallToolResult): string {
  for (const block of result.content ?? []) {
    if (block.type === 'text') return block.text;
  }
  return '';
}
