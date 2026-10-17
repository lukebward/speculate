/** Shared record shape and percentile calculation for the repeated benchmark. */
export function percentile(values, fraction) {
    if (values.length === 0)
        return 0;
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
        throw new Error('percentile fraction must be in [0,1]');
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
}
