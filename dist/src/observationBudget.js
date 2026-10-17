export const MAX_SESSION_OBSERVATION_BYTES = 32 * 1024 * 1024;
export class ObservationBudget {
    maximum;
    reportExhaustion;
    used = 0;
    exhausted = false;
    constructor(maximum = MAX_SESSION_OBSERVATION_BYTES, reportExhaustion = () => { }) {
        this.maximum = maximum;
        this.reportExhaustion = reportExhaustion;
        if (!Number.isSafeInteger(maximum) || maximum <= 0)
            throw new Error('observation budget must be a positive integer');
    }
    get usedBytes() {
        return this.used;
    }
    get isExhausted() {
        return this.exhausted;
    }
    reserve(bytes, observedAt = Date.now()) {
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maximum - this.used) {
            if (!this.exhausted) {
                this.exhausted = true;
                try {
                    this.reportExhaustion(observedAt);
                }
                catch { }
            }
            return false;
        }
        this.used += bytes;
        return true;
    }
    release(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes <= 0)
            return;
        this.used = Math.max(0, this.used - bytes);
    }
}
