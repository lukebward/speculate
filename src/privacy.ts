import type { SpeculateConfig } from './types.js';
import {
  oauthStorePath as defaultOAuthStorePath,
  readOAuthRecord,
} from './oauthStore.js';

export interface SecretGuard {
  isSensitive(value: unknown, fieldName?: string): boolean;
  redact(text: string): string;
}

export interface SanitizedLearnerState {
  value: {
    transitions: Array<Record<string, unknown> & {
      templates: Array<Record<string, unknown> & { sources: Record<string, unknown>[] }>;
    }>;
    openers: Record<string, unknown>[];
  };
  removedSensitive: number;
  removedExpired: number;
  removedInvalid: number;
}

const MAX_LABEL = 512;
const MAX_PATH = 16;
const MAX_REPR = 16_384;
const MAX_TEMPLATES = 256;
const MAX_SOURCES = 64;
const MAX_CONTEXTS = 64;
const MAX_OPENERS = 4_096;

const SECRET_ROLES = new Set([
  'password', 'passwd', 'pwd', 'secret', 'clientsecret', 'token', 'accesstoken',
  'refreshtoken', 'authtoken', 'apikey', 'authorization', 'proxyauthorization',
  'cookie', 'setcookie', 'privatekey', 'credential', 'credentials',
]);
const IDENTIFIER_SUFFIXES = new Set(['id', 'name', 'ref', 'reference', 'type', 'count']);

function keyTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveFieldName(value: string): boolean {
  const tokens = keyTokens(value);
  if (tokens.length === 0) return false;
  if (IDENTIFIER_SUFFIXES.has(tokens.at(-1)!) && tokens.length > 1) return false;
  const joined = tokens.join('');
  return SECRET_ROLES.has(joined) || tokens.some((token) => SECRET_ROLES.has(token));
}

function textHasCredentialShape(value: string): boolean {
  return (
    /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/i.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(value) ||
    /(?:^|[?&;\s])(password|passwd|secret|access_token|refresh_token|api_key)\s*[=:]\s*[^\s&;]{6,}/i.test(value) ||
    /\b[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/.test(value) ||
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(value)
  );
}

function containsSensitive(
  value: unknown,
  guard: SecretGuard,
  fieldName?: string,
  depth = 0,
): boolean {
  if (depth > 12) return true;
  if (fieldName !== undefined && isSensitiveFieldName(fieldName)) return true;
  if (typeof value === 'string') return guard.isSensitive(value, fieldName);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitive(item, guard, fieldName, depth + 1));
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (guard.isSensitive(key) || isSensitiveFieldName(key)) return true;
    if (containsSensitive(child, guard, key, depth + 1)) return true;
  }
  return false;
}

export function createSecretGuard(secretValues: Iterable<string> = []): SecretGuard {
  const known = [...new Set([...secretValues].filter((value) => value.length >= 4))]
    .sort((a, b) => b.length - a.length);
  const isSensitive = (value: unknown, fieldName?: string): boolean => {
    if (fieldName !== undefined && isSensitiveFieldName(fieldName)) return true;
    if (typeof value !== 'string') return containsSensitive(value, guard, fieldName);
    return textHasCredentialShape(value) || known.some(
      (secret) => value.includes(secret) || (value.length >= 8 && secret.includes(value)),
    );
  };
  const redact = (text: string): string => {
    let out = text;
    for (const secret of known) out = out.split(secret).join('[sensitive]');
    out = out
      .replace(/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/gi, '[sensitive]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [sensitive]')
      .replace(/\b[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[sensitive]');
    return out;
  };
  const guard: SecretGuard = { isSensitive, redact };
  return guard;
}

function credentialHeader(name: string): boolean {
  const joined = keyTokens(name).join('');
  return joined === 'authorization' || joined === 'proxyauthorization' || joined === 'cookie' ||
    joined === 'setcookie' || joined === 'xapikey' || joined === 'apikey';
}

/** Values are returned for in-memory comparison only; callers must never log them. */
export function collectRuntimeSecrets(
  config: SpeculateConfig,
  options: { env?: NodeJS.ProcessEnv; oauthPath?: string | null } = {},
): string[] {
  const secrets = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 4) secrets.add(value);
  };
  const addAuthorization = (value: string): void => {
    add(value);
    const auth = /^(Bearer|Basic)\s+(.+)$/i.exec(value);
    if (!auth?.[2]) return;
    add(auth[2]);
    if (auth[1]!.toLowerCase() === 'basic') {
      try {
        const decoded = Buffer.from(auth[2], 'base64').toString('utf8');
        add(decoded);
        const separator = decoded.indexOf(':');
        if (separator >= 0) add(decoded.slice(separator + 1));
      } catch {}
    }
  };
  for (const [name, value] of Object.entries(options.env ?? process.env)) {
    if (typeof value === 'string' && isSensitiveFieldName(name)) add(value);
  }
  for (const server of Object.values(config.servers)) {
    for (const [name, value] of Object.entries(server.env ?? {})) {
      if (isSensitiveFieldName(name)) add(value);
    }
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      if (credentialHeader(name) && value.length >= 4) {
        addAuthorization(value);
      }
    }
  }
  const oauthPath = options.oauthPath === undefined ? defaultOAuthStorePath() : options.oauthPath;
  if (oauthPath !== null) {
    for (const server of Object.values(config.servers)) {
      if (!server.url) continue;
      const record = readOAuthRecord(oauthPath, server.url);
      add(record?.tokens?.access_token);
      add(record?.tokens?.refresh_token);
      add(record?.client.client_secret);
    }
  }
  return [...secrets];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function label(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LABEL && !/[\u0000-\u001f\u007f]/.test(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function timestamp(value: unknown, fallback: number): number {
  return finite(value) ? value : fallback;
}

function cleanSource(
  raw: unknown,
  targetName: string,
  guard: SecretGuard,
): { value?: Record<string, unknown>; sensitive?: boolean } {
  if (!record(raw) || !label(raw['kind'])) return {};
  const kind = raw['kind'];
  const evidence = {
    ...(finite(raw['score']) ? { score: raw['score'] } : {}),
    ...(finite(raw['lastUpdated']) ? { lastUpdated: raw['lastUpdated'] } : {}),
    ...(finite(raw['solo']) ? { solo: raw['solo'] } : {}),
    ...(finite(raw['seen']) ? { seen: raw['seen'] } : {}),
  };
  const sourceTool = raw['sourceTool'];
  if (sourceTool !== undefined && !label(sourceTool)) return {};
  if (typeof sourceTool === 'string' && guard.isSensitive(sourceTool)) return { sensitive: true };
  const history = sourceTool === undefined ? {} : { sourceTool };
  if (kind === 'arg') {
    if (!label(raw['key'])) return {};
    if (guard.isSensitive(raw['key'], raw['key'])) return { sensitive: true };
    return { value: { kind, key: raw['key'], ...history, ...evidence } };
  }
  if (kind === 'parsed') {
    if (!Array.isArray(raw['path']) || raw['path'].length > MAX_PATH || !raw['path'].every(label)) return {};
    if (raw['path'].some((part) => guard.isSensitive(part, part))) return { sensitive: true };
    return { value: { kind, path: [...raw['path']], ...history, ...evidence } };
  }
  if (kind === 'transform') {
    const transform = raw['transform'];
    if (!['string', 'number', 'lower', 'upper', 'basename', 'affix'].includes(String(transform))) return {};
    const base = label(raw['key'])
      ? { key: raw['key'] }
      : Array.isArray(raw['path']) && raw['path'].length <= MAX_PATH && raw['path'].every(label)
        ? { path: [...raw['path']] }
        : null;
    if (!base) return {};
    const descriptorParts = 'key' in base ? [base.key] : base.path;
    if (descriptorParts.some((part) => guard.isSensitive(part, part))) return { sensitive: true };
    for (const part of [raw['prefix'], raw['suffix']]) {
      if (part !== undefined && (typeof part !== 'string' || part.length > 512)) return {};
      if (typeof part === 'string' && guard.isSensitive(part, targetName)) return { sensitive: true };
    }
    return { value: {
      kind, ...base, ...history, transform,
      ...(raw['prefix'] !== undefined ? { prefix: raw['prefix'] } : {}),
      ...(raw['suffix'] !== undefined ? { suffix: raw['suffix'] } : {}),
      ...evidence,
    } };
  }
  if (kind === 'const') {
    if (typeof raw['repr'] !== 'string' || raw['repr'].length > MAX_REPR) return {};
    try {
      const parsed: unknown = JSON.parse(raw['repr']);
      if (containsSensitive(parsed, guard, targetName)) return { sensitive: true };
    } catch {
      return {};
    }
    return { value: { kind, repr: raw['repr'], ...evidence } };
  }
  return {};
}

export function sanitizeLearnerState(
  raw: unknown,
  options: { guard?: SecretGuard; now: number; cutoff: number; fallbackTimestamp?: number },
): SanitizedLearnerState {
  const guard = options.guard ?? createSecretGuard();
  const fallback = options.fallbackTimestamp ?? options.now;
  let removedSensitive = 0;
  let removedExpired = 0;
  let removedInvalid = 0;
  const transitions: SanitizedLearnerState['value']['transitions'] = [];
  const root = record(raw) ? raw : {};
  for (const rawTransition of Array.isArray(root['transitions']) ? root['transitions'] : []) {
    if (!record(rawTransition) || !label(rawTransition['server']) || !label(rawTransition['prevTool']) ||
      !label(rawTransition['nextTool']) || !finite(rawTransition['count']) || !Array.isArray(rawTransition['templates'])) {
      removedInvalid++;
      continue;
    }
    if (guard.isSensitive(rawTransition['server']) || guard.isSensitive(rawTransition['prevTool']) ||
      guard.isSensitive(rawTransition['nextTool'])) {
      removedSensitive++;
      continue;
    }
    const transitionStamp = timestamp(rawTransition['lastUpdated'], fallback);
    if (transitionStamp < options.cutoff) { removedExpired++; continue; }
    let transitionSensitive = false;
    let transitionInvalid = false;
    const templates: Array<Record<string, unknown> & { sources: Record<string, unknown>[] }> = [];
    for (const rawTemplate of rawTransition['templates'].slice(0, MAX_TEMPLATES)) {
      if (!record(rawTemplate) || !label(rawTemplate['name']) || !Array.isArray(rawTemplate['sources'])) {
        transitionInvalid = true;
        break;
      }
      if (guard.isSensitive(rawTemplate['name'], rawTemplate['name'])) {
        removedSensitive++;
        transitionSensitive = true;
        break;
      }
      const sources: Record<string, unknown>[] = [];
      let removedDynamicSource = false;
      for (const rawSource of rawTemplate['sources'].slice(0, MAX_SOURCES)) {
        if (record(rawSource) && timestamp(rawSource['lastUpdated'], transitionStamp) < options.cutoff) {
          removedExpired++;
          if (rawSource['kind'] !== 'const') removedDynamicSource = true;
          continue;
        }
        const clean = cleanSource(rawSource, rawTemplate['name'], guard);
        if (clean.sensitive) removedSensitive++;
        else if (!clean.value) removedInvalid++;
        else sources.push(clean.value);
        if (!clean.value && record(rawSource) && rawSource['kind'] !== 'const') {
          removedDynamicSource = true;
        }
      }
      if (removedDynamicSource && !sources.some((source) => source['kind'] !== 'const')) {
        transitionInvalid = true;
      }
      if (rawTemplate['sources'].length > 0 && sources.length === 0) {
        transitionInvalid = true;
        break;
      }
      templates.push({
        name: rawTemplate['name'],
        underivable: rawTemplate['underivable'] === true,
        ...(finite(rawTemplate['derived']) ? { derived: rawTemplate['derived'] } : {}),
        ...(finite(rawTemplate['missed']) ? { missed: rawTemplate['missed'] } : {}),
        sources,
      });
    }
    if (transitionSensitive || transitionInvalid || rawTransition['templates'].length > MAX_TEMPLATES) {
      if (transitionInvalid) removedInvalid++;
      continue;
    }
    const contexts = (Array.isArray(rawTransition['contexts']) ? rawTransition['contexts'] : [])
      .filter(record)
      .filter((context) => {
        const keep = timestamp(context['lastUpdated'], transitionStamp) >= options.cutoff;
        if (!keep) removedExpired++;
        return keep;
      })
      .slice(0, MAX_CONTEXTS)
      .filter((context) => {
        if (!label(context['key']) || !finite(context['count']) || !finite(context['score'])) return false;
        if (guard.isSensitive(context['key'], context['key'])) {
          removedSensitive++;
          return false;
        }
        return true;
      })
      .map((context) => ({ key: context['key'], count: context['count'], score: context['score'], lastUpdated: timestamp(context['lastUpdated'], transitionStamp) }));
    transitions.push({
      server: rawTransition['server'], prevTool: rawTransition['prevTool'], nextTool: rawTransition['nextTool'],
      count: rawTransition['count'],
      ...(finite(rawTransition['score']) ? { score: rawTransition['score'] } : {}),
      lastUpdated: transitionStamp,
      ...(finite(rawTransition['latencyMs']) ? { latencyMs: rawTransition['latencyMs'] } : {}),
      templates,
      ...(contexts.length > 0 ? { contexts } : {}),
    });
  }

  const openers: Record<string, unknown>[] = [];
  for (const rawOpener of (Array.isArray(root['openers']) ? root['openers'] : []).slice(0, MAX_OPENERS)) {
    if (!record(rawOpener) || !label(rawOpener['server']) || !label(rawOpener['tool']) ||
      typeof rawOpener['argsRepr'] !== 'string' || rawOpener['argsRepr'].length > MAX_REPR || !finite(rawOpener['count'])) {
      removedInvalid++;
      continue;
    }
    if (guard.isSensitive(rawOpener['server']) || guard.isSensitive(rawOpener['tool'])) {
      removedSensitive++;
      continue;
    }
    const stamp = timestamp(rawOpener['lastUpdated'], fallback);
    if (stamp < options.cutoff) { removedExpired++; continue; }
    try {
      const args: unknown = JSON.parse(rawOpener['argsRepr']);
      if (!record(args)) { removedInvalid++; continue; }
      if (containsSensitive(args, guard)) { removedSensitive++; continue; }
    } catch { removedInvalid++; continue; }
    openers.push({
      server: rawOpener['server'], tool: rawOpener['tool'], argsRepr: rawOpener['argsRepr'], count: rawOpener['count'],
      ...(finite(rawOpener['score']) ? { score: rawOpener['score'] } : {}),
      lastUpdated: stamp,
      ...(finite(rawOpener['latencyMs']) ? { latencyMs: rawOpener['latencyMs'] } : {}),
    });
  }
  return { value: { transitions, openers }, removedSensitive, removedExpired, removedInvalid };
}
