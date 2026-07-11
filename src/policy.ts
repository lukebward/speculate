/**
 * Safety policy: read-only, default-deny (DESIGN.md §4).
 *
 * A speculative call may only be issued if the tool is affirmatively
 * classified read-only. Unknown means no. Eligibility is the conjunction of
 * the annotation check (`readOnlyHint: true` — an untrusted hint) and the
 * operator policy (mode + allowlist/denylist), gated by the auth-error
 * breaker (suspension).
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { EligibilityDecision, SpeculationMode } from './types.js';

export interface ServerPolicyConfig {
  allowlist?: string[];
  denylist?: string[];
}

export class SafetyPolicy {
  private readonly mode: SpeculationMode;
  /** server -> operator allowlist (strict-mode requirement, §4 condition 2). */
  private readonly allowlists = new Map<string, Set<string>>();
  /** server -> operator denylist (never speculate, any mode). */
  private readonly denylists = new Map<string, Set<string>>();
  /**
   * server -> tool -> (annotations.readOnlyHint === true).
   * Only tools present here are "known"; everything else is default-denied.
   */
  private readonly knownTools = new Map<string, Map<string, boolean>>();
  /**
   * server -> tool -> suspension reason (§4 auth-error breaker). Survives
   * updateTools; cleared only by resetSuspension (a real call succeeded).
   */
  private readonly suspensions = new Map<string, Map<string, string>>();

  constructor(mode: SpeculationMode, perServer: Record<string, ServerPolicyConfig>) {
    this.mode = mode;
    for (const [server, cfg] of Object.entries(perServer)) {
      this.allowlists.set(server, new Set(cfg.allowlist ?? []));
      this.denylists.set(server, new Set(cfg.denylist ?? []));
    }
  }

  /**
   * Record the server's current tool set and annotations. Called on connect
   * and on tools/list_changed (§3.4); replaces the previous set entirely, so
   * a tool that disappears from the list reverts to unknown (default-deny).
   */
  updateTools(server: string, tools: Tool[]): void {
    const annotated = new Map<string, boolean>();
    for (const tool of tools) {
      annotated.set(tool.name, tool.annotations?.readOnlyHint === true);
    }
    this.knownTools.set(server, annotated);
  }

  /**
   * The §4 conjunction, default-deny. Reasons are machine-readable and
   * feed the decision log (§9).
   */
  eligibility(server: string, tool: string): EligibilityDecision {
    if (this.mode === 'off') {
      return { eligible: false, reason: 'mode-off' };
    }
    if (this.denylists.get(server)?.has(tool)) {
      return { eligible: false, reason: 'denylisted' };
    }
    const suspendedFor = this.suspensions.get(server)?.get(tool);
    if (suspendedFor !== undefined) {
      return { eligible: false, reason: `suspended:${suspendedFor}` };
    }
    const tools = this.knownTools.get(server);
    if (tools === undefined || !tools.has(tool)) {
      return { eligible: false, reason: 'unknown-tool' };
    }
    if (tools.get(tool) !== true) {
      return { eligible: false, reason: 'not-annotated' };
    }
    if (this.mode === 'strict') {
      return this.allowlists.get(server)?.has(tool)
        ? { eligible: true, reason: 'allowlisted' }
        : { eligible: false, reason: 'not-allowlisted' };
    }
    // mode === 'annotated': annotation alone suffices.
    return { eligible: true, reason: 'annotated' };
  }

  /**
   * Mutation-invalidation classification (§6.2) — a different, more
   * permissive question than eligibility: is this tool affirmatively known
   * to be a read? Union of annotation and allowlist. Denylist and suspension
   * do NOT make a tool a write (a denylisted read is still a read); unknown
   * tools are treated as writes.
   */
  isAffirmativelyReadOnly(server: string, tool: string): boolean {
    if (this.allowlists.get(server)?.has(tool)) return true;
    return this.knownTools.get(server)?.get(tool) === true;
  }

  /** §4 auth-error breaker: drop the tool from speculation until reset. */
  suspend(server: string, tool: string, reason: string): void {
    let byTool = this.suspensions.get(server);
    if (byTool === undefined) {
      byTool = new Map();
      this.suspensions.set(server, byTool);
    }
    byTool.set(tool, reason);
  }

  /** Called by the proxy when a real call to the tool succeeds (§4). */
  resetSuspension(server: string, tool: string): void {
    this.suspensions.get(server)?.delete(tool);
  }

  isSuspended(server: string, tool: string): boolean {
    return this.suspensions.get(server)?.has(tool) ?? false;
  }
}
