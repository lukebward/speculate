import { createHash } from 'node:crypto';

const MAX_OCCURRENCES = 4_096;
const RETENTION_MS = 120_000;
const CHANNEL_PAIR_MS = 5_000;

interface Occurrence {
  id: string;
  at: number;
  channels: Set<string>;
}

export class PromptOccurrenceCorrelator {
  private readonly byNative = new Map<string, Occurrence>();
  private readonly latestByText = new Map<string, Occurrence>();
  private sequence = 0;

  constructor(private readonly now: () => number) {}

  identify(conversationId: string, text: string, channel: 'hook' | 'proxy', nativeId?: string): string {
    const now = this.now();
    this.prune(now);
    const textKey = digest(`${conversationId}\0${text}`);
    const nativeKey = nativeId ? `${conversationId}\0${nativeId}` : null;
    const known = nativeKey ? this.byNative.get(nativeKey) : undefined;
    if (known) {
      known.at = now;
      known.channels.add(channel);
      this.latestByText.set(textKey, known);
      return known.id;
    }

    const latest = this.latestByText.get(textKey);
    if (latest && now - latest.at <= CHANNEL_PAIR_MS && !latest.channels.has(channel)) {
      latest.at = now;
      latest.channels.add(channel);
      if (nativeKey) this.byNative.set(nativeKey, latest);
      return latest.id;
    }

    const occurrence: Occurrence = {
      id: digest(`${conversationId}\0${textKey}\0${++this.sequence}`),
      at: now,
      channels: new Set([channel]),
    };
    this.latestByText.set(textKey, occurrence);
    if (nativeKey) this.byNative.set(nativeKey, occurrence);
    this.bound();
    return occurrence.id;
  }

  private prune(now: number): void {
    for (const [key, occurrence] of this.byNative) {
      if (now - occurrence.at > RETENTION_MS) this.byNative.delete(key);
    }
    for (const [key, occurrence] of this.latestByText) {
      if (now - occurrence.at > RETENTION_MS) this.latestByText.delete(key);
    }
  }

  private bound(): void {
    while (this.byNative.size > MAX_OCCURRENCES) this.byNative.delete(this.byNative.keys().next().value!);
    while (this.latestByText.size > MAX_OCCURRENCES) this.latestByText.delete(this.latestByText.keys().next().value!);
  }
}

export function promptNativeId(value: unknown): string {
  return digest(JSON.stringify(value));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
