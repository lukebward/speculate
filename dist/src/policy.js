export class SafetyPolicy {
    mode;
    /** server -> operator allowlist (strict-mode requirement, §4 condition 2). */
    allowlists = new Map();
    /** server -> operator denylist (never speculate, any mode). */
    denylists = new Map();
    /**
     * server -> tool -> (annotations.readOnlyHint === true).
     * Only tools present here are "known"; everything else is default-denied.
     */
    knownTools = new Map();
    /**
     * server -> tool -> suspension reason (§4 auth-error breaker). Survives
     * updateTools; cleared only by resetSuspension (a real call succeeded).
     */
    suspensions = new Map();
    constructor(mode, perServer) {
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
    updateTools(server, tools) {
        const annotated = new Map();
        for (const tool of tools) {
            annotated.set(tool.name, tool.annotations?.readOnlyHint === true);
        }
        this.knownTools.set(server, annotated);
    }
    /**
     * The §4 conjunction, default-deny. Reasons are machine-readable and
     * feed the decision log (§9).
     */
    eligibility(server, tool) {
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
    isAffirmativelyReadOnly(server, tool) {
        if (this.allowlists.get(server)?.has(tool))
            return true;
        return this.knownTools.get(server)?.get(tool) === true;
    }
    /** §4 auth-error breaker: drop the tool from speculation until reset. */
    suspend(server, tool, reason) {
        let byTool = this.suspensions.get(server);
        if (byTool === undefined) {
            byTool = new Map();
            this.suspensions.set(server, byTool);
        }
        byTool.set(tool, reason);
    }
    /** Called by the proxy when a real call to the tool succeeds (§4). */
    resetSuspension(server, tool) {
        this.suspensions.get(server)?.delete(tool);
    }
    isSuspended(server, tool) {
        return this.suspensions.get(server)?.has(tool) ?? false;
    }
}
