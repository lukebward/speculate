# Release notes

Version-by-version records of what changed and why, newest last.

!!! info "Part of the design document"

    Section numbers (§1–§13) run across the whole design document, split here
    into [Design spec](index.md), [Implementation notes](implementation-notes.md),
    [Release notes](releases.md), and [Prior art](prior-art.md).

## v0.11 (2026-08-01): MCP-only focus

CLI speculation (exec daemon, Bash hook, workspace shell server) is removed.
Rationale: speculation value scales with upstream latency, and MCP/SaaS reads
(hundreds of ms) dominate local CLI reads (~30 ms, often net-negative after
hook spawn overhead); read-only vetting of arbitrary argv has no
deterministic cross-platform answer short of per-OS sandbox machinery,
while MCP's readOnlyHint gives it for free; and the tier carried the
project's POSIX-only surface (unix sockets, uid checks) plus a Windows
.git/index watcher loop that flushed every prefetch. `on`/`off` now clean
up artifacts a ≤0.10 install left behind. Full trail:
.superpowers/specs/2026-08-01-focus-mcp-design.md.

`speculate exec` survives as a verbatim pass-through (no shell, no rewriting,
the child's exit code) so the ≤0.10 Bash hook keeps working. That hook
rewrites the agent's `git status`/`rg`/`ls` into `speculate exec -- …` in
every project until `speculate on` removes it. Compatibility only, for one
release: removed in 0.12.

Windows: npm installs `claude` as a `.cmd` shim, which Node refuses to spawn
(CVE-2024-27980), so `on`/`off`/`status` reach the front door through cmd.exe.
Arguments are quoted for the child's CommandLineToArgvW, then escaped twice
for cmd (the shim's `%*` re-parses one of the rounds), with `%` stepped
outside the quotes (a caret inside quotes is literal), so a `%APPDATA%` in an
MCP entry can neither expand nor inject. Two limits are cmd's own: the command
line cannot exceed ~8191 characters (fails loud with "The command line is too
long.", exit 1) and a raw `\n`/`\r` inside an argument truncates the line
(JSON-escaped `\\n`, what `mcp add-json` payloads carry, is unaffected).

Benchmark re-verified after the removal (the harness was always MCP-only, so
the §11 numbers carry forward unchanged): hit rate 71%, waste 0.00/hit, both
deterministic across runs; tool-wait cut −64%…−67% over four runs (timing
jitter; −66% is the central value). Test suite: 431 tests, 424 passing, 7
skipped on Windows. The §10 caveat still governs: this is a scripted,
workflow-shaped ceiling, and §10 item 8's adversarial floor script remains
unwritten, so no measured lower bound exists yet.

## v0.12 (2026-08-02): auto-wrap

`speculate on` now also installs a second, minimal plugin at Claude Code's
user scope: `speculate-autowrap`, shipping exactly one `SessionStart` hook
that runs a new `speculate sync` command. Unlike the wrap `on` performs on
the spot, sync targets servers added to any project after the fact, without
a person ever running `on` there again.

**The one-session lag is measured, not assumed.** Testing against Claude
Code on Windows with an isolated `CLAUDE_CONFIG_DIR` established: a
`SessionStart` command hook fires before auth completes; `claude mcp
add-json` run from inside that hook succeeds; but the server it adds does
not launch in the current session, only in the next one. Claude Code
snapshots MCP config before running `SessionStart` hooks, so no hook,
however early, can make a wrap take effect in the session that triggered it.
A server added now runs unwrapped, exactly as if speculation were off, for
one more session, then wraps starting the session after. Both the plugin's
own summary line and `speculate status` state this plainly rather than
implying instant pickup. One further limit of the same shape, stated here
because nothing else in the product can state it: the hook is registered
with `matcher: "startup"`, so it fires only for a fresh session. Someone
who works entirely in `claude --resume` or `claude --continue` never fires
it and therefore never gets auto-wrap at all; for them `speculate on`
remains the only thing that wraps anything. Widening the matcher to
`resume`/`compact` would run the hash check on far more session events for
a wrap that is one session late regardless, so the narrow matcher stands —
but as a choice, not as an oversight.

**Sync is cheap on the common path and fails open on every other one.**
Before spawning anything, it hashes the project's effective server set
(name, scope, approval state, and canonicalized entry for every server) and
compares it to a stored per-project hash; when they match, which is the
overwhelming majority of session starts since most sessions add no server,
sync returns after a couple of file reads: no subprocess, no lock. Only a
changed hash proceeds to acquire a host-wide lock file, one per state
directory rather than per project, because every session ultimately
read-modifies-writes the same global `~/.claude.json`; a session that
cannot get the lock exits immediately and leaves the work for whichever
session next finds the config unlocked, which costs nothing given the lag
already puts everything one session behind. `on` and `off` deliberately do
not take that lock — they are interactive, and blocking a person behind a
background hook would be the worse trade — so sync's final write is a
read-merge-write, not a write-back: it re-reads the state file immediately
before saving and touches only this project's own two keys. Writing its
whole in-memory copy back silently reverted an `off` that completed in
another project mid-sync, erasing the opt-out that `off` had just recorded
and resurrecting the project record it had just deleted, so the project the
user had turned off was re-wrapped at its next session start. One residual
is recorded rather than fixed: since `on`/`off` still take no lock, an `off`
in the SAME project as an in-flight sync can still have its project record
resurrected by that sync's merge. The opt-out itself now survives, so the
consequence is a stale entry list, and a later `off` reporting spurious
failures as it chases servers that are already unwrapped — not a project
that gets re-wrapped. Closing it properly means `on`/`off` taking the lock,
which trades a silent data race for a person waiting on a background hook. The wrap pass itself runs under
a cooperative deadline, 5 s by default: checked only between servers, never
between one server's `remove` and its paired `add-json`, so a session that
runs out of budget mid-list leaves a clean host, nothing deleted without a
replacement, rather than a fully wrapped one. Above that sits a last-resort
process exit for a hang no layer below can end, set at 120 s — the 5 s
budget plus three 30 s `execFile` timeouts, with slack, because that 30 s is
not a hard bound: `execFile` SIGTERMs and then waits for stdio to close, so a
child that ignores SIGTERM runs past it. The plugin's own hook timeout
(150 s) and the stale-lock window (180 s) are stacked above that in turn,
since a host-side kill lands wherever it lands, including in exactly the
window the cooperative deadline exists to protect, and a lock holder that
legitimately runs to either cap must not look stale to the next session.
Arithmetic is the weak form of this guarantee, and the code says so: the
strong form is a marker held across the `remove`→`add-json` pair, so the
exit can refuse to fire while one is open and the restore is replayable if
the process dies anyway. That is the right long-term fix. Every failure path returns
success and sync prints at most one summary line: a session start must
never be blocked or sprayed with diagnostics on auto-wrap's account, so
`speculate status` remains the place to look when something needs
attention.

**`off` opts a project out; it does not uninstall the plugin.** Running
`speculate off` records a per-project opt-out that sync's hash check
consults before anything else, so the global hook will not silently
re-wrap that project again, even though the plugin stays installed for
every other project on the machine. `off` prints the command to remove the
plugin everywhere (`claude plugin uninstall -s user speculate-autowrap`)
for anyone who wants auto-wrap gone entirely, plus the command to remove
the marketplace registration that supplied it (`claude plugin marketplace
remove speculate-mcp`), since a host-global registration is exactly the
kind of artifact `off`'s per-project framing could otherwise leave
unmentioned. It also names the limit that framing hides. The servers `off`
unwraps at USER scope are shared by every project on the machine, while the
opt-out it records covers one project, so any OTHER project's next session
start re-wraps them at user scope — and this project sees them wrapped
again, within a single session, without auto-wrap having disobeyed its
opt-out at all. Whenever `off` unwrapped anything at user scope it now says
so, and names the plugin uninstall as the only thing that actually stops
it. `speculate status` closes the same loop from the other side: with the
plugin installed it used to report "installed (new servers wrap at the next
session start)" purely on detection, which is exactly wrong in a project
that has just run `off`; it now reports the opt-out and names `speculate
on` as the way back in, and that is the only place the opt-out is visible
at all. What `off` still does not touch or mention is the staged
plugin copy under `<state>/autowrap` (the same directory that holds
`managed.json`) that `on` wrote in order to install the plugin in the
first place; that copy is inert once the plugin is uninstalled, since
nothing on the host points at it any more, and is safe to delete by hand
alongside the uninstall.

**Install repairs itself by uninstalling first.** Measured against the
real host: with the plugin already installed, `claude plugin install`
no-ops ("already installed") and `plugin update` reports "already at the
latest version"; neither re-copies a cached plugin. So when the staged
hook command or the plugin's own version no longer matches what is
installed, for example after an npm move changed the baked CLI path, or
after a new Speculate release, `on` uninstalls the old copy first and
immediately reinstalls the current one; a plain install or update cannot
get there, since both treat "already installed" as done. If the uninstall
half of that repair fails, `on` aborts rather than attempting the install
against an unknown state, and prints the exact recipe to finish the job by
hand: `claude plugin uninstall -s user speculate-autowrap`, then
`speculate on`. The two are printed on separate lines rather than chained
with `&&`, because PowerShell 5.1 is the default shell on stock Windows and
parse-errors on `&&`, which would leave a stuck user running neither half.
The honest cost of that abort: between the failure and someone
running the recipe, the user has no auto-wrap plugin installed at all,
which is a worse position than the stale copy they started with, and
exactly the reason the message names the fix instead of only the
uninstall half of it.

One correction to the v0.11 record above: it committed to removing the
`speculate exec` compatibility pass-through in 0.12. That did not happen,
and 0.12 still ships it. Nothing about auto-wrap depends on it either way,
but a ≤0.10 Bash hook can still be sitting in a project nobody has run
`speculate on` in yet, so the shim keeps earning its place. Removal moves
to 0.13.

**Consent, in both directions.** Sync wraps only servers
`wrapEffectiveServers` would already wrap through `on`, including the
`.mcp.json` approval gate, so nothing sync does can turn a pending server
into a running one — and, as of this release, revoking an approval takes
the wrapped server away again. The second half was missing, and 0.12 is
what made it matter. Once an approved project server is shadowed by the
wrapped copy registered at local scope, the local entry wins the scope
contest, so the project entry's approval flag stopped reaching the
per-project hash: revoking the approval changed nothing sync could see,
sync made zero calls, and the shadow stayed registered and running at a
scope that has no approval gate at all. That was already true of `on` in
0.11; 0.12 escalated it, because shadows are now created unattended in
projects where nobody ever ran `speculate on`. Both halves are fixed: the
hash covers a shadowed project entry as well as the effective one, so a
revoke moves it, and `sync`/`on` then REMOVE a shadow whose `.mcp.json`
counterpart is no longer *both present and approved*, leaving whatever the
project actually declares — a pending entry, or nothing at all — as the only
thing left. Present matters as much as approved: a server dropped from
`.mcp.json` by a pull, a branch switch, an edit, or a deleted file is the
commoner trigger, and it used to leave the wrapped shadow running forever
for a server the project no longer declares. Only shadows Speculate created
are removed — the managed state records those with action `shadowed`, and
the entry must still be a Speculate wrap — so a local entry the user wrapped
themselves is never touched, and neither is one whose record has been lost
with the state file. That last case is deliberately conservative: without the
record there is no proof the entry is ours, which is exactly the stance `off`
takes in the same situation. The other honest consent-adjacent fact:
because the plugin installs at user scope, opening a brand-new project also
gets its already-approved servers wrapped automatically at that project's
next session start, without `speculate on` ever having run there.

Full trail: .superpowers/specs/2026-08-02-auto-wrap-design.md.

## v0.13 (2026-08-02): prediction quality

Five defects in the learner, each found by measurement rather than by reading
the code. §13.16 through §13.19 carry the detail; this section is the ledger
and the honest reading of the numbers.

**The instrument came first, because the old headline was circular.**
`npm run bench` replays a scripted 7-call GitHub session against the mock and
reports hit rate, tool-wait cut and waste. What it measures is **prefetch
mechanics**: whether a predicted call is issued early enough, completes in
time, and is served rather than forwarded. It cannot measure prediction
quality, because the script and the hand-written GitHub rules that predict it
were authored together, so quoting its 71% as evidence that the learner
predicts well was reasoning in a circle. The sharper form of the same point:
the learner contributes **nothing** to that 71%, since a learned transition
needs two sightings and the benchmark's workflow repeats none of its calls.
`npm run eval` is the separate
instrument, and it was built before any change to `src/`. It scores offline
**recall@K over transition pairs**: one pair is a consecutive (call i-1, call
i) inside a scored session, a hit requires tool **and** arguments to match
under `canonicalKey` (the same key the cache uses, so a right tool with a
wrong id is a miss), and recall@K is hits at rank ≤ K over pairs. It drives a
real `TransitionLearner` and imports nothing else: no `ServerProfile`, no
`Predictor`, so no hand-written rule can contribute a prediction by
construction, and a test asserts no corpus tool name collides with the
bundled github, filesystem or slack profiles. Seeds 1, 2 and 3 are pooled;
the clock is injected and neither `Date.now` nor `Math.random` appears under
`eval/`. Both commands still ship, and they answer different questions.

**Where it ends up** (seeds 1,2,3; recall@3 is the headline band because 3 is
the shipped per-trigger cap, §5.6; recall@5 is visible only because the
harness raises the learner's cap to 5):

| archetype | pairs | recall@1 | recall@3 | recall@5 | waste/hit |
|---|---|---|---|---|---|
| list-detail-varied | 300 | 0.373 | 0.727 | 0.790 | 3.24 |
| return-visits | 300 | 0.593 | 0.997 | 0.997 | 1.26 |
| multi-arg | 300 | 0.803 | 0.883 | 0.883 | 0.84 |
| regime-shift | 120 | 0.900 | 0.900 | 0.950 | 2.33 |
| direct-recall | 150 | 0.267 | 0.587 | 0.627 | 2.38 |
| paired-args | 300 | 0.537 | 0.887 | 0.923 | 2.70 |
| **WORKFLOW (headline)** | **1470** | **0.571** | **0.846** | **0.875** | **2.00** |
| adversarial (floor) | 300 | 0.087 | 0.087 | 0.087 | 9.08 |

**The adversarial floor sat at 0.087 through every task in this plan**, with
its waste per hit pinned at 9.08 and, at several stages, byte-identical
counters on both sides of a change. That is the control that makes every
other number here mean anything. A learner that bought recall by firing more
speculations at noise would have lifted the floor first, since the floor's
entity ids are minted once and never repeated, so the flat floor establishes
exactly this and no more: no gain below came from firing at noise. It is not
the claim that the gains came without firing more, which would be false. The
workflow pool went from 1,892 predictions issued to 2,449 over the same span,
and that cost is priced in the waste column below. The floor is reported
beside the headline, never pooled into it, and the two are only ever quoted
together.

**The headline is not one number improving in place, and the denominator is
why.** The first pooled baseline this branch recorded was **0.6033 over 900
pairs**; it now reads **0.8463 over 1470**. Three archetypes joined the
corpus in between, each of them added because an existing defect was
invisible without it, and each addition moved the headline on its own:
`regime-shift` took 900 pairs to 1020 (0.6033 to 0.6363), `direct-recall`
took 1020 to 1170 (0.8725 to 0.8359), and `paired-args` took
1170 to 1470 (0.8359 to 0.797, both measured without the coherence check).
The last two moved with no code changing at all; the first is the one place
this paragraph has to qualify itself, because its two endpoints straddle
Task 2's decay change as well as the corpus addition, and 0.002 of that
0.6033 to 0.6363 is code rather than corpus. So the
end state is a harder corpus **and** a better learner, and the pooled
endpoints cannot separate the two. The attribution lives in the per-task
deltas, each measured against a corpus held fixed across the change:

| change | pairs | before | after | Δ recall@3 |
|---|---|---|---|---|
| Evidence decays, and eviction goes by value (§13.16) | 1020 | 0.532 | 0.636 | **+0.104** |
| A template holds evidence, not a latch (§13.17) | 1020 | 0.636 | 0.731 | **+0.095** |
| Sources compete, and a transition offers several (§13.18) | 1020 | 0.731 | 0.873 | **+0.141** |
| Co-varying arguments are one hypothesis (§13.18) | 1470 | 0.797 | 0.846 | **+0.049** |

The five defects those four rows close: lifetime-frequency ranking that never
forgot, paired with FIFO eviction that dropped the best-evidenced entry to
admit a one-off; a single unexplainable value latching a transition off
permanently; one hypothesis per argument, fixed to whichever row index the
first sighting happened to use; one argument set per transition, which pinned
recall@K to recall@1 whatever the budget allowed; and two arguments read off
the same row scored as independent, so the cheapest substitutions in the beam
were pairings that had never occurred. A sixth was introduced and caught in
review rather than shipped: value-based eviction let a brand-new transition
be its own victim, freezing the model silently and, because the score
persists, across restarts. Both eviction sites now exempt the key the current
observation just wrote, with a regression test at the default
`minObservations`.

Waste is the price and it is visible: the workflow band reads 2.00 wasted
predictions per hit against 1.27 at the first baseline, moved by the same mix
of corpus growth and model change as the headline, and it is concentrated in
the archetypes the recall came from. That column bills every prediction
issued at the shipped cap, including the batch fired after each session's
last call that nothing can ever claim, so it is a deliberately pessimistic
production estimate and not the instrument §10's ≤2 per hit criterion was
written against (the bench still reads 0.00). Even read that way it now sits
exactly on that bar, which makes it the number to watch next rather than one
with headroom left in it.

**Calibration against PASTE, read the unflattering way.** PASTE (arXiv
2603.18897) reports **27.8% top-1 and 43.9% top-3** predictor recall on Deep
Research Bench, SWE Bench and ScholarQA, which are real traces. Our 0.571 and
0.846 are on a corpus we wrote ourselves. These are not comparable numbers,
and ours reading higher is most likely evidence that our corpus is easier,
not that this learner is better: we authored the archetypes knowing what the
learner can derive, and a synthetic workflow is predictable in ways real
traffic is not. A real-trace figure for this learner would most likely land
somewhere between our floor of 0.087 and our headline of 0.846, and nothing
measured here establishes where. Two differences do run in our favour, and
they are facts about scope rather than about accuracy: PASTE describes no
staleness or invalidation mechanism, and no decay, since its patterns are
mined once and applied uniformly. One runs the other way: it has a string
formatting and normalization transform as a third kind of argument source,
where we have only argument copy, parsed result path and memorized constant,
and it launches greedily on utility rather than against a fixed cap. Real
numbers for this proxy still come from §9 telemetry, not from either corpus.

**What did not ship, recorded because the plan called for it.**

- **Widening the learnable array-index window** (indices 0..2 to 0..7,
  `pushArrayPaths`) is **deferred**, measured at **+0.003** (3 pairs of 900),
  not the ~0.06 first estimated. Under a per-trigger cap of 3 and a
  monotonically decreasing index distribution, the top three indices by
  frequency are always {0,1,2}. `src/learner.ts` still reads
  `Math.min(arr.length, 3)`.
- **Entity frecency** as a separate mechanism is **dropped**: Task 3's
  per-source scoring already implements it generically. The `direct-recall`
  archetype was authored as a negative control, isolating the case where the
  target id appears nowhere in the trigger's arguments or result (verified 0
  of 180 sessions) while six wrong ids sit at enumerable array positions. It
  came back positive at 0.835 recall@3 on its common leg, with the transition
  holding four `const` sources, one per pinned entity, ranked by decayed
  score. The control on the control, the same shape with entities never
  reused, scores 0.000 at zero waste. What remains is scope, not memory:
  constants are keyed per (server, prevTool, nextTool, argName), so the same
  entities reached from a rarer trigger get nothing (0.733 / 0.667 / 0.389 /
  0.000 as that trigger thins from every 2 to every 16 sessions), priced at
  about +0.03 on the headline.
- **Utility ranking** (PASTE's `p·T`, cutting the per-trigger cap on expected
  time saved rather than probability) landed and was **reverted** as a
  measured no-op. Two reasons, both measured: the bundled bench injects one
  latency for every tool, so `score × ms` is `score` times a constant and the
  ranking is provably identical, and the per-trigger cap never binds on the
  bundled profile (zero cap-suppression events across a full session, since
  it offers at most 2 to 3 candidates against a cap of 3). Only a constructed
  heterogeneous workload at cap 1 moved it, 4.50 s to 4.05 s. The eval was
  unchanged to every digit. The plan's own rule is that a change which does
  not move the measurement does not land; it is worth revisiting once the cap
  starts binding, which the beam makes likelier.
- **The long-horizon TTL lever ships inert.** `speculation.longHorizonTtlFactor`
  exists per server and `LONG_HORIZON_TTL_FACTOR` defaults to **1**, so
  nothing is shortened unless someone asks for it. Shortening bought zero
  measured freshness (standing bets are consumed at a lead of exactly 1.000
  calls, the same instant as derived ones) and cost about 9% of all hits once
  inter-call spacing passed roughly half the TTL (1265 to 1150 at factor 0.5
  from 16 s spacing, with the standing class going to zero). The
  instrumentation it was built alongside did ship: `ageAtHit` reports median,
  p95 and max age at consumption, the share consumed in the last quarter of
  their TTL, and mean lead, in both the runtime and the offline replay.

**What the numbers still do not cover.** The corpus is synthetic and
authored, not sampled traffic. `derived`/`missed` are the only evidence in
the learner that does not decay, so a derivation that stops working must
accumulate misses in proportion to its whole history before the rate gate
closes; the §5.6 feedback loop is the production backstop and the offline
harness does not model it. No surviving array-index derivation remains in the
corpus, so if `pushArrayPaths` broke outright the headline would not move.
Session-start openers (§13.15) do not fit a recall@K-over-pairs frame and are
unmeasured. `return-visits` has saturated at 0.997 and no longer discriminates
anything.

Two corrections to the record above. The v0.11 note said §10 item 8's
adversarial floor remained unwritten, so no measured lower bound existed;
that is no longer true, and the floor is the 0.087 row. The v0.12 note said
the `speculate exec` compatibility pass-through would be removed in 0.13.
That did not happen either, and 0.13 still ships it.

## v0.18 (2026-08-30): day-to-day utility

Speculation now learns the latency of eligible tools across sessions and uses
a conservative latency estimate when deciding whether a candidate is worth
issuing. The model is time-decayed, numerically stable, bounded, and merged
across concurrent state writers. Existing learned transition latency remains
as a migration fallback, and a v0.17 state file without the optional latency
field still loads normally.

Candidate correctness is evaluated before admission, including candidates
suppressed for being too cheap. Those observations feed a bounded,
confidence-informed calibration model. Calibrated next-call probabilities now
rank candidates while operational feedback remains a separate suppression
signal. Live statistics expose calibration Brier scores and reliability
buckets without persisting arguments, result data, or cache keys.

The underlying predictor also becomes more useful on varied workflows:
learned state is isolated by workspace, upstream, and credential/account
scope; bounded recent context can specialize a durable transition; argument
sources can use conservative deterministic transforms; alternative argument
sets retain separate feedback; and compatible list/detail schemas can yield a
cold prediction without a server-specific rule. Mutations and session resets
clear pending shadow batches without manufacturing negative observations.

Durable statistics now report conservative added wait and net saving,
predictor recall, argument near misses, and optional server/tool breakdowns.
They support time and workspace filters plus crash-safe monthly compaction.
Terminal accounting includes abandoned outstanding work instead of allowing a
final speculative batch to disappear from the waste total.

Validation covered 796 passing tests with 7 opt-in skips, a clean TypeScript
build, and an unchanged offline workflow score (recall@3 0.8463, waste/hit
2.00). Default admission stayed quiet on approximately 5 ms Git reads; an
unconstrained Git control retained an 80% hit/join rate; the 120 ms filesystem
workflow produced 30 useful results from 44 opportunities and about 3.16 s of
estimated net saving; and calibrated Brier score beat static confidence on
the Git, filesystem, and Hugging Face runs. Hosted latency remains noisy and
is reported as per-run spread rather than a release gate.

The deterministic daily-workflow generator and comparison core ship with the
release. The common executable daily runner, marginal per-candidate admission
controller, durable per-tool latency explanation, and bounded unknown-latency
discovery remain follow-up work. Cold discovery stays disabled until a
negative-control workflow proves that it becomes quiet on unpredictable
traffic.
