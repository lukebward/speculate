/**
 * Upstream MCP server connection (DESIGN.md §3.1 connection pool).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

  constructor(name: string, config: ServerConfig) {
    this.name = name;
    this.config = config;
    this.transport = config.url ? 'http' : 'stdio';
  }

  setToolsChangedHandler(fn: () => void): void {
    this.onToolsChanged = fn;
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
          env: { ...getDefaultEnv(), ...(this.config.env ?? {}) },
          stderr: 'inherit',
        });
    await client.connect(transport);
    this.client = client;
    this.instructions = client.getInstructions?.();
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.refreshTools();
      } catch {
        // keep last-known tool list on refresh failure
      }
      this.onToolsChanged?.();
    });
    await this.refreshTools();
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
        onprogress: opts.onprogress,
      },
    );
    return result as CallToolResult;
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

/** Minimal inherited env for stdio children (PATH etc.), mirroring SDK defaults. */
function getDefaultEnv(): Record<string, string> {
  const keep = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
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
