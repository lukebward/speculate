/**
 * Persistable target-latency estimates for adaptive admission.
 *
 * The model stores exponentially aged weighted means and M2 values. This is
 * numerically stable for nearly-identical durations and supports exact
 * baseline-delta merging for concurrent state writers.
 */

export interface LatencyEstimate {
  weight: number;
  meanMs: number;
  m2Ms2: number;
  observations: number;
  lastUpdated: number;
}

export interface LatencySnapshot {
  version: 1;
  tools: Array<{ server: string; tool: string } & LatencyEstimate>;
  servers: Array<{ server: string } & LatencyEstimate>;
}

export interface EstimatedLatency {
  expectedMs: number;
  deviationMs: number;
  conservativeMs: number;
  effectiveSamples: number;
  source: 'tool' | 'server' | 'prediction-hint' | 'unknown';
}

export interface LatencyEstimator {
  observe(server: string, tool: string, latencyMs: number): void;
  estimate(server: string, tool: string, predictionHintMs?: number): EstimatedLatency;
}

const HALF_LIFE_MS = 30 * 24 * 60 * 60_000;
const MAX_LATENCY_MS = 600_000;
const MAX_EFFECTIVE_WEIGHT = 1_000_000_000;
const MAX_OBSERVATIONS = 1_000_000_000;
const MAX_SERVER_ENTRIES = 128;
const MAX_TOOLS_PER_SERVER = 256;
const MAX_LABEL_LENGTH = 512;
const TOOL_MIN_WEIGHT = 0.5;
const SERVER_MIN_WEIGHT = 2;
const UNKNOWN_LATENCY_MS = 100;
const DEVIATION_FACTOR = 0.5;
const WEIGHT_EPSILON = 1e-9;

interface ToolEstimate extends LatencyEstimate {
  server: string;
  tool: string;
}

interface ServerEstimate extends LatencyEstimate {
  server: string;
}

export class LatencyModel implements LatencyEstimator {
  private readonly now: () => number;
  private readonly tools = new Map<string, ToolEstimate>();
  private readonly servers = new Map<string, ServerEstimate>();
  private mutations = 0;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  get revision(): number {
    return this.mutations;
  }

  observe(server: string, tool: string, latencyMs: number): void {
    if (!validLabel(server) || !validLabel(tool)) return;
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    const at = safeNow(this.now());
    const value = Math.min(latencyMs, MAX_LATENCY_MS);
    const toolKey = `${server}\0${tool}`;
    this.tools.set(toolKey, addObservation(this.tools.get(toolKey), value, at, { server, tool }));
    this.servers.set(server, addObservation(this.servers.get(server), value, at, { server }));
    this.enforceCaps(at);
    this.mutations++;
  }

  estimate(server: string, tool: string, predictionHintMs?: number): EstimatedLatency {
    const at = safeNow(this.now());
    const toolEstimate = this.tools.get(`${server}\0${tool}`);
    if (toolEstimate) {
      const aged = ageEstimate(toolEstimate, at);
      if (aged.weight >= TOOL_MIN_WEIGHT) return materialize(aged, 'tool');
    }
    const serverEstimate = this.servers.get(server);
    if (serverEstimate) {
      const aged = ageEstimate(serverEstimate, at);
      if (aged.weight >= SERVER_MIN_WEIGHT) return materialize(aged, 'server');
    }
    if (
      predictionHintMs !== undefined &&
      Number.isFinite(predictionHintMs) &&
      predictionHintMs >= 0
    ) {
      const expectedMs = Math.min(predictionHintMs, MAX_LATENCY_MS);
      return {
        expectedMs,
        deviationMs: 0,
        conservativeMs: expectedMs,
        effectiveSamples: 0,
        source: 'prediction-hint',
      };
    }
    return {
      expectedMs: UNKNOWN_LATENCY_MS,
      deviationMs: 0,
      conservativeMs: UNKNOWN_LATENCY_MS,
      effectiveSamples: 0,
      source: 'unknown',
    };
  }

  exportState(): LatencySnapshot {
    const at = safeNow(this.now());
    return boundedSnapshot(
      [...this.tools.values()].map((entry) => ageEstimate(entry, at)),
      [...this.servers.values()].map((entry) => ageEstimate(entry, at)),
      at,
    );
  }

  importState(raw: unknown): void {
    const snapshot = sanitizeSnapshot(raw, safeNow(this.now()));
    if (!snapshot) return;
    this.tools.clear();
    this.servers.clear();
    for (const entry of snapshot.tools) this.tools.set(`${entry.server}\0${entry.tool}`, entry);
    for (const entry of snapshot.servers) this.servers.set(entry.server, entry);
  }

  private enforceCaps(at: number): void {
    const snapshot = boundedSnapshot([...this.tools.values()], [...this.servers.values()], at);
    if (
      snapshot.tools.length === this.tools.size &&
      snapshot.servers.length === this.servers.size
    ) return;
    this.tools.clear();
    this.servers.clear();
    for (const entry of snapshot.tools) this.tools.set(`${entry.server}\0${entry.tool}`, entry);
    for (const entry of snapshot.servers) this.servers.set(entry.server, entry);
  }
}

/** Merge optional latency state using the same loaded baseline as StateStore. */
export function mergeLatencySnapshots(
  existingRaw: unknown,
  incomingRaw: unknown,
  baselineRaw: unknown,
  now: number,
): LatencySnapshot {
  const at = safeNow(now);
  const existing = sanitizeSnapshot(existingRaw, at) ?? emptySnapshot();
  const incoming = sanitizeSnapshot(incomingRaw, at) ?? emptySnapshot();
  const baseline = sanitizeSnapshot(baselineRaw, at);

  const tools = mergeEntryMaps(
    new Map(existing.tools.map((entry) => [`${entry.server}\0${entry.tool}`, entry])),
    new Map(incoming.tools.map((entry) => [`${entry.server}\0${entry.tool}`, entry])),
    baseline
      ? new Map(baseline.tools.map((entry) => [`${entry.server}\0${entry.tool}`, entry]))
      : undefined,
    at,
  );
  const servers = mergeEntryMaps(
    new Map(existing.servers.map((entry) => [entry.server, entry])),
    new Map(incoming.servers.map((entry) => [entry.server, entry])),
    baseline
      ? new Map(baseline.servers.map((entry) => [entry.server, entry]))
      : undefined,
    at,
  );
  return boundedSnapshot([...tools.values()] as ToolEstimate[], [...servers.values()] as ServerEstimate[], at);
}

function mergeEntryMaps<T extends LatencyEstimate>(
  existing: Map<string, T>,
  incoming: Map<string, T>,
  baseline: Map<string, T> | undefined,
  at: number,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const key of new Set([...existing.keys(), ...incoming.keys()])) {
    const left = existing.get(key);
    const right = incoming.get(key);
    if (!left) {
      out.set(key, ageEstimate(right!, at));
    } else if (!right) {
      out.set(key, ageEstimate(left, at));
    } else if (!baseline) {
      const a = ageEstimate(left, at);
      const b = ageEstimate(right, at);
      out.set(key, (b.weight > a.weight || (b.weight === a.weight && b.lastUpdated > a.lastUpdated) ? b : a));
    } else {
      const delta = subtractEstimate(right, baseline.get(key), at);
      out.set(key, delta ? combineEstimates(left, delta, at) : ageEstimate(left, at));
    }
  }
  return out;
}

function subtractEstimate<T extends LatencyEstimate>(
  totalRaw: T,
  baselineRaw: T | undefined,
  at: number,
): T | null {
  const total = ageEstimate(totalRaw, at);
  if (!baselineRaw) return total;
  const baseline = ageEstimate(baselineRaw, at);
  const weight = total.weight - baseline.weight;
  const observations = Math.max(0, total.observations - baseline.observations);
  if (weight <= WEIGHT_EPSILON || observations === 0) return null;

  const meanMs = (total.weight * total.meanMs - baseline.weight * baseline.meanMs) / weight;
  if (!Number.isFinite(meanMs) || meanMs < 0 || meanMs > MAX_LATENCY_MS) return total;
  const meanDelta = meanMs - baseline.meanMs;
  const cross = (meanDelta * meanDelta * baseline.weight * weight) / total.weight;
  const m2Ms2 = total.m2Ms2 - baseline.m2Ms2 - cross;
  if (m2Ms2 < -Math.max(1e-6, total.m2Ms2 * 1e-9)) return total;
  return {
    ...total,
    weight,
    meanMs,
    m2Ms2: Math.max(0, m2Ms2),
    observations,
  };
}

function combineEstimates<T extends LatencyEstimate>(aRaw: T, bRaw: T, at: number): T {
  const a = ageEstimate(aRaw, at);
  const b = ageEstimate(bRaw, at);
  if (a.weight <= WEIGHT_EPSILON) return b;
  if (b.weight <= WEIGHT_EPSILON) return a;
  const weight = a.weight + b.weight;
  const delta = b.meanMs - a.meanMs;
  const combined = {
    ...a,
    weight,
    meanMs: a.meanMs + (delta * b.weight) / weight,
    m2Ms2: a.m2Ms2 + b.m2Ms2 + (delta * delta * a.weight * b.weight) / weight,
    observations: Math.min(MAX_OBSERVATIONS, a.observations + b.observations),
    lastUpdated: Math.max(a.lastUpdated, b.lastUpdated),
  };
  return capWeight(combined);
}

function addObservation<T extends object>(
  prior: (T & LatencyEstimate) | undefined,
  value: number,
  at: number,
  identity: T,
): T & LatencyEstimate {
  if (!prior) {
    return { ...identity, weight: 1, meanMs: value, m2Ms2: 0, observations: 1, lastUpdated: at };
  }
  const aged = ageEstimate(prior, at);
  const weight = aged.weight + 1;
  const delta = value - aged.meanMs;
  return capWeight({
    ...aged,
    ...identity,
    weight,
    meanMs: aged.meanMs + delta / weight,
    m2Ms2: aged.m2Ms2 + (delta * delta * aged.weight) / weight,
    observations: Math.min(MAX_OBSERVATIONS, aged.observations + 1),
    lastUpdated: at,
  });
}

function ageEstimate<T extends LatencyEstimate>(entry: T, at: number): T {
  const elapsed = Math.max(0, at - entry.lastUpdated);
  if (elapsed === 0) return { ...entry };
  const factor = 2 ** (-elapsed / HALF_LIFE_MS);
  return {
    ...entry,
    weight: entry.weight * factor,
    m2Ms2: entry.m2Ms2 * factor,
    lastUpdated: at,
  };
}

function capWeight<T extends LatencyEstimate>(entry: T): T {
  if (entry.weight <= MAX_EFFECTIVE_WEIGHT) return entry;
  const factor = MAX_EFFECTIVE_WEIGHT / entry.weight;
  return { ...entry, weight: MAX_EFFECTIVE_WEIGHT, m2Ms2: entry.m2Ms2 * factor };
}

function materialize(
  entry: LatencyEstimate,
  source: 'tool' | 'server',
): EstimatedLatency {
  const variance = Math.max(0, entry.m2Ms2 / entry.weight);
  const deviationMs = Math.sqrt(variance);
  return {
    expectedMs: entry.meanMs,
    deviationMs,
    conservativeMs: Math.max(0, entry.meanMs - DEVIATION_FACTOR * deviationMs),
    effectiveSamples: entry.weight,
    source,
  };
}

function sanitizeSnapshot(raw: unknown, at: number): LatencySnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const root = raw as { version?: unknown; tools?: unknown; servers?: unknown };
  if (root.version !== 1 || !Array.isArray(root.tools) || !Array.isArray(root.servers)) return null;

  const tools = new Map<string, ToolEstimate>();
  for (const rawEntry of root.tools) {
    const entry = sanitizeEntry(rawEntry, at, true);
    if (!entry || !('tool' in entry)) continue;
    const key = `${entry.server}\0${entry.tool}`;
    const prior = tools.get(key);
    if (!prior || stronger(entry, prior, at)) tools.set(key, entry);
  }
  const servers = new Map<string, ServerEstimate>();
  for (const rawEntry of root.servers) {
    const entry = sanitizeEntry(rawEntry, at, false);
    if (!entry || 'tool' in entry) continue;
    const prior = servers.get(entry.server);
    if (!prior || stronger(entry, prior, at)) servers.set(entry.server, entry);
  }
  return boundedSnapshot([...tools.values()], [...servers.values()], at);
}

function sanitizeEntry(
  raw: unknown,
  at: number,
  tool: boolean,
): ToolEstimate | ServerEstimate | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!validLabel(value['server'])) return null;
  if (tool && !validLabel(value['tool'])) return null;
  const weight = numberInRange(value['weight'], WEIGHT_EPSILON, MAX_EFFECTIVE_WEIGHT);
  const meanMs = numberInRange(value['meanMs'], 0, MAX_LATENCY_MS);
  const maxM2 = MAX_EFFECTIVE_WEIGHT * MAX_LATENCY_MS * MAX_LATENCY_MS;
  const m2Ms2 = numberInRange(value['m2Ms2'], 0, maxM2);
  if (weight === null || meanMs === null || m2Ms2 === null) return null;
  const observations = value['observations'];
  if (typeof observations !== 'number' || !Number.isSafeInteger(observations) || observations < 1) {
    return null;
  }
  const stamp = value['lastUpdated'];
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return null;
  const base = {
    server: value['server'],
    weight,
    meanMs,
    m2Ms2,
    observations: Math.min(observations, MAX_OBSERVATIONS),
    lastUpdated: Math.max(0, Math.min(stamp, at)),
  } as ServerEstimate;
  return tool ? { ...base, tool: value['tool'] as string } : base;
}

function boundedSnapshot(
  toolEntries: ToolEstimate[],
  serverEntries: ServerEstimate[],
  at: number,
): LatencySnapshot {
  const strongest = <T extends LatencyEstimate>(a: T, b: T): number => {
    const aa = ageEstimate(a, at);
    const bb = ageEstimate(b, at);
    return bb.weight - aa.weight || bb.lastUpdated - aa.lastUpdated;
  };
  const serverStrength = new Map<string, LatencyEstimate>();
  for (const entry of [...serverEntries, ...toolEntries]) {
    const prior = serverStrength.get(entry.server);
    if (!prior || stronger(entry, prior, at)) serverStrength.set(entry.server, entry);
  }
  const allowedServers = new Set(
    [...serverStrength.entries()]
      .sort((a, b) => strongest(a[1], b[1]) || a[0].localeCompare(b[0]))
      .slice(0, MAX_SERVER_ENTRIES)
      .map(([server]) => server),
  );
  const retainedServers = serverEntries.filter((entry) => allowedServers.has(entry.server));
  const retainedTools: ToolEstimate[] = [];
  const grouped = new Map<string, ToolEstimate[]>();
  for (const entry of toolEntries) {
    if (!allowedServers.has(entry.server)) continue;
    const values = grouped.get(entry.server) ?? [];
    values.push(entry);
    grouped.set(entry.server, values);
  }
  for (const entries of grouped.values()) {
    retainedTools.push(
      ...entries
        .sort((a, b) => strongest(a, b) || a.tool.localeCompare(b.tool))
        .slice(0, MAX_TOOLS_PER_SERVER),
    );
  }
  return {
    version: 1,
    tools: retainedTools
      .map((entry) => ageEstimate(entry, at))
      .sort((a, b) => a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool)),
    servers: retainedServers
      .map((entry) => ageEstimate(entry, at))
      .sort((a, b) => a.server.localeCompare(b.server)),
  };
}

function stronger(a: LatencyEstimate, b: LatencyEstimate, at: number): boolean {
  const aa = ageEstimate(a, at);
  const bb = ageEstimate(b, at);
  return aa.weight > bb.weight || (aa.weight === bb.weight && aa.lastUpdated > bb.lastUpdated);
}

function validLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LABEL_LENGTH;
}

function numberInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function safeNow(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function emptySnapshot(): LatencySnapshot {
  return { version: 1, tools: [], servers: [] };
}
