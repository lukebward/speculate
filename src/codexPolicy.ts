/** Respect Codex's current tool policy before starting speculative work. */
import { startCodexClient } from './codexClient.js';
import type { SpeculateConfig } from './types.js';
import type { WrapArgs } from './wrap.js';

export interface CodexPolicyOptions {
  /** Injectable native config reader; the default opens and closes app-server. */
  readConfig?: (cwd: string, args: WrapArgs) => Promise<Record<string, unknown>>;
  log?: (message: string) => void;
}

export interface CodexPolicyProjection {
  enabled: boolean;
  allowTools: string[] | null;
  denyTools: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidPolicy(): never {
  // Deliberately omit configuration values: errors can reach host logs.
  throw new Error('Unsupported Codex tool policy');
}

function toolList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((tool) => typeof tool !== 'string' || tool.length === 0)) {
    invalidPolicy();
  }
  return [...new Set(value as string[])];
}

function permitsSpeculation(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  // `writes` still passes through Speculate's readOnlyHint gate. `approve`
  // remains excluded until Codex gives it unambiguous no-prompt semantics.
  if (value === 'auto' || value === 'writes') return true;
  if (value === 'prompt' || value === 'approve') return false;
  return invalidPolicy();
}

async function readNativeConfig(cwd: string, args: WrapArgs): Promise<Record<string, unknown>> {
  const client = await startCodexClient({
    bin: args.codexBin,
    cwd,
    env: { ...process.env, CODEX_HOME: args.codexHome },
  });
  try {
    return (await client.readConfig(cwd)).config;
  } finally {
    await client.close();
  }
}

export function projectCodexPolicy(
  effective: Record<string, unknown>,
  serverName: string,
): CodexPolicyProjection {
  if (!record(effective.mcp_servers) || !Object.hasOwn(effective.mcp_servers, serverName)) invalidPolicy();
  const server = effective.mcp_servers[serverName];
  if (!record(server)) invalidPolicy();
  if (server.enabled !== undefined && server.enabled !== null && typeof server.enabled !== 'boolean') invalidPolicy();
  if (server.enabled === false) return { enabled: false, allowTools: [], denyTools: [] };
  const enabled = toolList(server.enabled_tools);
  const disabled = toolList(server.disabled_tools) ?? [];
  const defaultPermitted = permitsSpeculation(server.default_tools_approval_mode, true);
  const explicitAllowed: string[] = [];
  const explicitDenied: string[] = [];
  if (server.tools !== undefined && server.tools !== null) {
    if (!record(server.tools)) invalidPolicy();
    for (const [tool, policy] of Object.entries(server.tools)) {
      if (!tool || !record(policy) || Object.keys(policy).some((key) => key !== 'approval_mode' && key !== 'output_token_limit')) invalidPolicy();
      if (policy.output_token_limit !== undefined && policy.output_token_limit !== null &&
        (!Number.isSafeInteger(policy.output_token_limit) || (policy.output_token_limit as number) <= 0)) invalidPolicy();
      if (permitsSpeculation(policy.approval_mode, defaultPermitted)) explicitAllowed.push(tool);
      else explicitDenied.push(tool);
    }
  }
  let allowTools: string[] | null = enabled ?? null;
  if (!defaultPermitted) {
    const accepted = new Set(explicitAllowed);
    allowTools = allowTools === null ? [...accepted] : allowTools.filter((tool) => accepted.has(tool));
  }
  return {
    enabled: true,
    allowTools,
    denyTools: [...new Set([...disabled, ...explicitDenied])],
  };
}

export function applyCodexPolicyProjection(
  config: SpeculateConfig,
  projection: CodexPolicyProjection,
): void {
  if (!projection.enabled) {
    config.mode = 'off';
    return;
  }
  const upstream = config.servers.upstream;
  if (!upstream) invalidPolicy();
  let allowed = config.mode === 'strict' ? [...(upstream.allowTools ?? [])] : undefined;
  if (projection.allowTools !== null) {
    const accepted = new Set(projection.allowTools);
    allowed = allowed === undefined ? [...accepted] : allowed.filter((tool) => accepted.has(tool));
  }
  if (allowed !== undefined) {
    config.mode = 'strict';
    upstream.allowTools = allowed;
  }
  const denied = [...new Set([...(upstream.denyTools ?? []), ...projection.denyTools])];
  if (denied.length) upstream.denyTools = denied;
}

/**
 * Narrow the existing eligibility gate; requested calls continue through the
 * ordinary proxy path. Every startup rereads the host's effective policy so a
 * permission change does not leave an old installer-created allowlist active.
 */
export async function applyCodexPolicy(
  config: SpeculateConfig,
  args: WrapArgs,
  options: CodexPolicyOptions = {},
): Promise<void> {
  if (args.codexServer === undefined || config.mode === 'off') return;
  try {
    if (!args.codexBin || !args.codexHome) invalidPolicy();
    const effective = await (options.readConfig ?? readNativeConfig)(process.cwd(), args);
    applyCodexPolicyProjection(config, projectCodexPolicy(effective, args.codexServer));
  } catch {
    config.mode = 'off';
    (options.log ?? ((message: string) => process.stderr.write(`${message}\n`)))(
      '[speculate] Codex tool policy could not be verified; speculation is disabled for this server.',
    );
  }
}
