export const MAX_SESSION_OBSERVATION_BYTES = 32 * 1024 * 1024;

export class ObservationBudget {
  private used = 0;
  private exhausted = false;

  constructor(
    private readonly maximum = MAX_SESSION_OBSERVATION_BYTES,
    private readonly reportExhaustion: (observedAt: number) => void = () => {},
  ) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('observation budget must be a positive integer');
  }

  get usedBytes(): number {
    return this.used;
  }

  get isExhausted(): boolean {
    return this.exhausted;
  }

  reserve(bytes: number, observedAt = Date.now()): boolean {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maximum - this.used) {
      if (!this.exhausted) {
        this.exhausted = true;
        try { this.reportExhaustion(observedAt); } catch {}
      }
      return false;
    }
    this.used += bytes;
    return true;
  }

  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    this.used = Math.max(0, this.used - bytes);
  }
}
