/** Online, privacy-preserving correctness calibration for ranked candidates. */
const FEEDBACK_TAU_MS = 14 * 24 * 60 * 60_000;
const PRIOR_STRENGTH = 4;
const MAX_FEEDBACK = 500;
const MAX_CANDIDATES = 2_000;
const MAX_ID_LENGTH = 1_024;
export class CandidateCalibrator {
    now;
    feedback = new Map();
    mutations = 0;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
    }
    get revision() {
        return this.mutations;
    }
    observe(candidateId, correct, timestamp) {
        if (!validId(candidateId))
            return;
        const at = safeTimestamp(timestamp, this.now());
        const prior = this.feedback.get(candidateId);
        const aged = prior ? age(prior, at) : { correct: 0, evaluated: 0, lastUpdated: at };
        let next = {
            correct: aged.correct + (correct ? 1 : 0),
            evaluated: aged.evaluated + 1,
            lastUpdated: at,
        };
        if (next.evaluated > MAX_FEEDBACK) {
            const factor = MAX_FEEDBACK / next.evaluated;
            next = { ...next, correct: next.correct * factor, evaluated: MAX_FEEDBACK };
        }
        this.feedback.set(candidateId, next);
        this.enforceCap(at);
        this.mutations++;
    }
    probability(candidateId, baseConfidence) {
        const base = clampProbability(baseConfidence);
        const raw = this.feedback.get(candidateId);
        if (!raw)
            return { probability: base, observations: 0, source: 'prior' };
        const current = age(raw, safeTimestamp(undefined, this.now()));
        return {
            probability: (current.correct + PRIOR_STRENGTH * base) /
                (current.evaluated + PRIOR_STRENGTH),
            observations: current.evaluated,
            source: current.evaluated > 0 ? 'empirical' : 'prior',
        };
    }
    exportState() {
        const at = safeTimestamp(undefined, this.now());
        return Object.fromEntries([...this.feedback.entries()]
            .map(([id, value]) => [id, age(value, at)])
            .filter(([, value]) => value.evaluated > 0)
            .sort(([a], [b]) => a.localeCompare(b)));
    }
    importState(raw) {
        const parsed = sanitizeFeedback(raw, safeTimestamp(undefined, this.now()));
        if (!parsed)
            return;
        this.feedback.clear();
        for (const [id, value] of Object.entries(parsed))
            this.feedback.set(id, value);
    }
    enforceCap(at) {
        if (this.feedback.size <= MAX_CANDIDATES)
            return;
        const weakest = [...this.feedback.entries()].sort((a, b) => {
            const aa = age(a[1], at);
            const bb = age(b[1], at);
            return aa.evaluated - bb.evaluated || aa.lastUpdated - bb.lastUpdated || a[0].localeCompare(b[0]);
        });
        for (const [id] of weakest.slice(0, this.feedback.size - MAX_CANDIDATES)) {
            this.feedback.delete(id);
        }
    }
}
export function mergeCandidateFeedbackSnapshots(existingRaw, incomingRaw, baselineRaw, now) {
    const at = safeTimestamp(now, Date.now());
    const existing = sanitizeFeedback(existingRaw, at) ?? {};
    const incoming = sanitizeFeedback(incomingRaw, at) ?? {};
    const baseline = sanitizeFeedback(baselineRaw, at);
    const merged = {};
    for (const id of new Set([...Object.keys(existing), ...Object.keys(incoming)])) {
        const left = existing[id];
        const right = incoming[id];
        if (!left)
            merged[id] = right;
        else if (!right)
            merged[id] = left;
        else if (baseline) {
            const base = baseline[id];
            const addEvaluated = Math.max(0, right.evaluated - (base?.evaluated ?? 0));
            const addCorrect = Math.min(addEvaluated, Math.max(0, right.correct - (base?.correct ?? 0)));
            const evaluated = left.evaluated + addEvaluated;
            const correct = left.correct + addCorrect;
            const factor = evaluated > MAX_FEEDBACK ? MAX_FEEDBACK / evaluated : 1;
            merged[id] = {
                evaluated: evaluated * factor,
                correct: correct * factor,
                lastUpdated: at,
            };
        }
        else {
            merged[id] =
                right.evaluated > left.evaluated ||
                    (right.evaluated === left.evaluated && right.lastUpdated > left.lastUpdated)
                    ? right
                    : left;
        }
    }
    return Object.fromEntries(Object.entries(merged)
        .sort((a, b) => b[1].evaluated - a[1].evaluated || b[1].lastUpdated - a[1].lastUpdated || a[0].localeCompare(b[0]))
        .slice(0, MAX_CANDIDATES)
        .sort(([a], [b]) => a.localeCompare(b)));
}
function sanitizeFeedback(raw, at) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const out = {};
    for (const [id, value] of Object.entries(raw)) {
        if (!validId(id) || value === null || typeof value !== 'object' || Array.isArray(value))
            continue;
        const item = value;
        if (typeof item['correct'] !== 'number' ||
            !Number.isFinite(item['correct']) ||
            item['correct'] < 0 ||
            typeof item['evaluated'] !== 'number' ||
            !Number.isFinite(item['evaluated']) ||
            item['evaluated'] <= 0 ||
            item['correct'] > item['evaluated'] ||
            typeof item['lastUpdated'] !== 'number' ||
            !Number.isFinite(item['lastUpdated']))
            continue;
        const stamp = Math.max(0, Math.min(item['lastUpdated'], at));
        const current = age({
            correct: Math.min(item['correct'], MAX_FEEDBACK),
            evaluated: Math.min(item['evaluated'], MAX_FEEDBACK),
            lastUpdated: stamp,
        }, at);
        if (current.evaluated > 0)
            out[id] = current;
    }
    return Object.fromEntries(Object.entries(out)
        .sort((a, b) => b[1].evaluated - a[1].evaluated || b[1].lastUpdated - a[1].lastUpdated || a[0].localeCompare(b[0]))
        .slice(0, MAX_CANDIDATES)
        .sort(([a], [b]) => a.localeCompare(b)));
}
function age(value, at) {
    const factor = Math.exp(-Math.max(0, at - value.lastUpdated) / FEEDBACK_TAU_MS);
    return {
        correct: value.correct * factor,
        evaluated: value.evaluated * factor,
        lastUpdated: at,
    };
}
function clampProbability(value) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
function validId(value) {
    return value.length > 0 && value.length <= MAX_ID_LENGTH;
}
function safeTimestamp(value, fallback) {
    const selected = value ?? fallback;
    return Number.isFinite(selected) && selected >= 0 ? selected : Date.now();
}
