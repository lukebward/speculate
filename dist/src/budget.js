const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_MINUTE = 30;
const DEFAULT_HTTP_MAX_CONCURRENT = 2;
export class BudgetManager {
    servers = new Map();
    now;
    constructor(perServer, opts) {
        this.now = opts?.now ?? Date.now;
        for (const [name, cfg] of Object.entries(perServer)) {
            this.servers.set(name, {
                transport: cfg.transport,
                maxPerMinute: cfg.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE,
                maxConcurrent: cfg.transport === 'stdio'
                    ? 1
                    : cfg.maxConcurrent ?? DEFAULT_HTTP_MAX_CONCURRENT,
                realInFlight: 0,
                specInFlight: 0,
                issuedAt: [],
            });
        }
    }
    // -- Real-traffic bookkeeping (real calls are never blocked; we only
    //    observe them so stdio speculation can stay idle-only). --------------
    realStarted(server) {
        const s = this.servers.get(server);
        if (s !== undefined)
            s.realInFlight++;
    }
    realFinished(server) {
        const s = this.servers.get(server);
        if (s !== undefined && s.realInFlight > 0)
            s.realInFlight--;
    }
    realInFlight(server) {
        return this.servers.get(server)?.realInFlight ?? 0;
    }
    // -- Speculative bookkeeping ---------------------------------------------
    /**
     * Atomically check budgets and, if allowed, take a concurrency slot and a
     * per-minute token. A denial consumes nothing.
     */
    tryAcquire(server) {
        const s = this.servers.get(server);
        if (s === undefined)
            return { ok: false, reason: 'unknown-server' };
        if (s.transport === 'stdio' && (s.realInFlight > 0 || s.specInFlight > 0)) {
            return { ok: false, reason: 'stdio-busy' };
        }
        if (s.specInFlight >= s.maxConcurrent) {
            return { ok: false, reason: 'concurrency' };
        }
        const now = this.now();
        this.prune(s, now);
        if (s.issuedAt.length >= s.maxPerMinute) {
            return { ok: false, reason: 'per-minute' };
        }
        s.specInFlight++;
        s.issuedAt.push(now);
        return { ok: true };
    }
    /** Release the concurrency slot when the speculative call settles. */
    release(server) {
        const s = this.servers.get(server);
        if (s !== undefined && s.specInFlight > 0)
            s.specInFlight--;
    }
    specInFlight(server) {
        return this.servers.get(server)?.specInFlight ?? 0;
    }
    /** Drop issuance timestamps that have slid out of the 60 s window. */
    prune(s, now) {
        const cutoff = now - WINDOW_MS;
        let drop = 0;
        while (drop < s.issuedAt.length && s.issuedAt[drop] <= cutoff)
            drop++;
        if (drop > 0)
            s.issuedAt.splice(0, drop);
    }
}
