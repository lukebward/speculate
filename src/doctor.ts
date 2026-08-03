/**
 * `speculate doctor` — answers the questions a user actually has:
 * did my upstreams connect, which tools will Speculate speculate on and
 * WHY NOT the others, which rules are armed, and what has it learned so far.
 *
 * Human-facing: writes a report to stdout, returns false when something is
 * broken enough to need attention (an upstream failed to connect, or
 * speculation is enabled but zero tools are eligible).
 */
import { SafetyPolicy } from './policy.js';
import { morphologicalPairs } from './priming.js';
import { Upstream, friendlySpawnError } from './upstream.js';
import { compileConfigRules } from './configRules.js';
import { StateStore } from './persistence.js';
import { VERSION } from './version.js';
import type { Rule, SpeculateConfig } from './types.js';
import { readOAuthRecord } from './oauthStore.js';

const CONNECT_TIMEOUT_MS = 15_000;

const ok = (s: string) => `  ✓ ${s}`;
const bad = (s: string) => `  ✗ ${s}`;
const dim = (s: string) => `    ${s}`;

export async function runDoctor(
  config: SpeculateConfig,
  statePath: string | null,
  out: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<boolean> {
  out(`speculate doctor (v${VERSION}) — mode: ${config.mode}`);
  let healthy = true;
  let anyEligible = false;

  for (const [name, sc] of Object.entries(config.servers)) {
    out('');
    out(`server '${name}' (${sc.url ? `http ${sc.url}` : `stdio: ${sc.command}`})`);
    // Header NAMES answer "did my Authorization header actually get through?"
    // (the only question a user has here). A VALUE is a credential and is
    // never printed, by doctor or anything else.
    const headerNames = Object.keys(sc.headers ?? {});
    if (headerNames.length > 0) {
      out(dim(`headers: ${headerNames.sort().join(', ')} (values redacted)`));
    }
    // "Am I using my own OAuth login for this server, and when does it run
    // out?" Answering it here is the difference between a legible 401 and an
    // hour of guessing. The token itself is never printed.
    if (sc.oauthStorePath && sc.url) {
      const record = readOAuthRecord(sc.oauthStorePath, sc.url);
      const expiry = record?.expiresAt;
      const when =
        expiry === undefined
          ? 'no recorded expiry'
          : expiry <= Date.now()
            ? 'expired, refreshing on next call'
            : `valid for ${Math.round((expiry - Date.now()) / 60_000)} min, refreshed automatically`;
      out(dim(`oauth: authorized via 'speculate auth' (${when})`));
      if (process.platform === 'win32') {
        // 0o600 is a verified no-op on Windows: Node writes the file 666 and
        // the only protection is the ACL inherited from %LOCALAPPDATA%. Say
        // so rather than implying a guarantee that is not there.
        out(dim(`oauth: credentials at ${sc.oauthStorePath} (protected by folder ACL, not file mode)`));
      }
    }


    const policy = new SafetyPolicy(config.mode, {
      [name]: {
        allowlist: [...(sc.allowTools ?? [])],
        denylist: sc.denyTools ?? [],
      },
    });

    const upstream = new Upstream(name, sc);
    try {
      await withTimeout(upstream.connect(), CONNECT_TIMEOUT_MS, `connect to '${name}'`);
    } catch (err) {
      out(bad(`connection failed: ${friendlySpawnError(err, upstream)}`));
      healthy = false;
      continue;
    }

    policy.updateTools(name, upstream.tools);
    out(ok(`connected — ${upstream.tools.length} tools`));

    const eligible: string[] = [];
    const blocked: { tool: string; reason: string }[] = [];
    for (const tool of upstream.tools) {
      const d = policy.eligibility(name, tool.name);
      if (d.eligible) eligible.push(tool.name);
      else blocked.push({ tool: tool.name, reason: d.reason });
    }
    anyEligible ||= eligible.length > 0;

    if (eligible.length > 0) {
      out(ok(`${eligible.length} tools eligible for speculation: ${eligible.join(', ')}`));
    } else if (config.mode === 'off') {
      out(dim('speculation disabled (mode: off)'));
    } else {
      out(bad('no tools eligible for speculation'));
    }
    for (const b of blocked) {
      out(dim(`not speculated: ${b.tool} — ${explain(b.reason, config.mode)}`));
    }

    // Rules that can actually fire against this server's tools.
    const rules: Rule[] = sc.rules?.length ? compileConfigRules(name, sc.rules) : [];
    const toolNames = new Set(upstream.tools.map((t) => t.name));
    const armed = rules.filter((r) => toolNames.has(r.trigger));
    const orphaned = rules.filter((r) => !toolNames.has(r.trigger));
    if (rules.length > 0) {
      out(ok(`${armed.length} config rule(s) armed`));
      for (const r of orphaned) {
        out(dim(`rule '${r.id}' never fires: server has no tool '${r.trigger}'`));
      }
    } else {
      out(dim('no config rules — prediction comes from the transition learner'));
    }

    // §13.9 pre-loaded priors: what will predict after a single sighting.
    const toolNamesAll = upstream.tools.map((t) => t.name);
    const primes = new Set<string>();
    for (const [prev, next] of morphologicalPairs(toolNamesAll)) {
      if (policy.eligibility(name, next).eligible) primes.add(`${prev}→${next}`);
    }
    if (primes.size > 0) {
      out(ok(`${primes.size} pre-loaded prior(s) — predict after one sighting: ${[...primes].slice(0, 6).join(', ')}${primes.size > 6 ? ', …' : ''}`));
    }

    await upstream.close();
  }

  out('');
  if (statePath) {
    const state = new StateStore(statePath).load();
    if (state) {
      const transitions = Array.isArray((state.learner as { transitions?: unknown[] })?.transitions)
        ? (state.learner as { transitions: unknown[] }).transitions.length
        : 0;
      const rules = Object.keys(state.ruleFeedback).length;
      out(ok(`persistence: ${statePath}`));
      out(dim(`${transitions} learned transition(s), feedback for ${rules} rule(s), saved ${new Date(state.savedAt).toISOString()}`));
    } else {
      out(ok(`persistence: ${statePath} (no state yet — cold start)`));
    }
  } else {
    out(dim('persistence: disabled'));
  }

  if (config.mode !== 'off' && !anyEligible) {
    out('');
    out(bad('speculation is on but NO tools are eligible anywhere.'));
    out(dim(`strict mode requires readOnlyHint annotations AND an allowTools entry;`));
    out(dim(`use "mode": "annotated" for servers you trust to annotate honestly.`));
    healthy = false;
  }

  out('');
  out(healthy ? 'all good.' : 'problems found — see ✗ above.');
  return healthy;
}

function explain(reason: string, mode: string): string {
  if (reason === 'not-annotated') {
    return `tool does not declare readOnlyHint: true (write, or unannotated read)`;
  }
  if (reason === 'not-allowlisted') {
    return `annotated read-only, but strict mode also needs it in allowTools`;
  }
  if (reason === 'denylisted') return 'explicitly denied via denyTools';
  if (reason === 'mode-off') return 'speculation mode is off';
  if (reason.startsWith('suspended')) return reason;
  return `${reason} (mode: ${mode})`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
