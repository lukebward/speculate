# Benchmark methodology and results

This page is the authoritative guide to Speculate's performance instruments.
Every result must identify its source revision, workload, latency conditions,
training/held-out split, and accounting. A result is a snapshot of the version
it names, not a measurement of a later one.

Speculate has been two programs. Since v1.0 it is a Claude Code mod; before
that it was an MCP proxy. The proxy's instruments were removed with the proxy,
and its results are kept [at the end of this page](#history-the-0x-proxy) as
history. They do not describe the mod. The predictor is the same code, but
what turns a prediction into time saved is not: Claude Code's hooks,
permission checks and connections replaced the proxy's router, and a real
model's time between calls replaced a scripted pause.
The one like-for-like comparison of the two is
[the proxy run in the mod's own benchmark](#against-the-last-proxy-release).

## Maintained instruments

| Command | What it measures | Limits |
| --- | --- | --- |
| `npm run bench:live` | Tool wait and session time in real Claude Code sessions with the mod off and on, against hosted MCP servers, with a real model choosing the calls | Network and service noise; a few pairs per workload; one model and one network location per run; spends model tokens and other people's server time, so it is opt-in |
| `npm run bench:live -- --cold` | What the mod's hooks cost a call it cannot help: the same sessions with the mod's memory cleared before each one | Only meaningful with the scripted workload, where both arms make the same calls |
| `npm run bench:live -- --proxy <cli.js>` | A 0.x proxy release in the same sessions, in place of the mod: the release's `dist/src/cli.js` in front of the server | The proxy by its config-file path only; a second run, so not the same minutes as the mod's |
| `npm run bench:live -- --scenario mockgithub` | The same sessions against the bundled mock GitHub server with 1.5 s added to every call: what the mod does where a call takes seconds | A fixture, not a service: every call takes the same time and nothing is rate limited. The model and the host are real |
| `npm run bench:replay -- --dir <kept>` | The sessions a live run kept (`--keep`), replayed through the mod's core on a virtual clock: which recorded calls the core would have served | Not a measurement. The model's calls are fixed to the recording and the host's own costs are not in it |
| `npm run eval` | Generic offline replay prediction recall and adversarial floor | A synthetic corpus; no timing and no whole-task speedup |

`npm test` and `npm run test:mod` establish behavior, not speed.

## Live sessions

### Method

A pair is two headless sessions (`claude -p`) given the same prompt. The `off`
session is Claude Code without the mod. The `on` session loads the mod from
the checkout (`--plugin-dir`). Which runs first alternates from pair to pair:
a hosted server answers a repeat of a recent request faster, and that must
favour neither arm. Use an even number of warm pairs.

Each arm has its own empty `CLAUDE_CONFIG_DIR` and an empty working directory,
so no settings, hooks, or earlier memory reach a session. The `on` arm keeps
its directory for a whole workload, so what the mod learns in one pair is in
its store for the next. The first two pairs are therefore its learning
sessions. They are reported apart from the later, warm pairs, and that split
is fixed before a run, not chosen from its results.

Three workloads, from most to least favourable to prediction:

- **scripted**: the prompt dictates every call and its arguments, one at a
  time. Every session makes the same calls. This is the repeated script the
  0.x `bench:remote` ran, now with a real model between the calls. It is the
  only workload in which both arms are certain to make identical calls.
- **repeat**: one ordinary question, the same every session. The model picks
  the calls, their arguments, and what to run in parallel, and the two arms
  of a pair often pick differently.
- **varied**: an ordinary question on a different subject every pair. Nothing
  can be recalled; only a learned shape can help.

What is measured, and from where:

- **Tool wait** is the time between the host's own timestamps for an MCP call
  and for its result, in the session's event stream. It is what the model
  waited, whoever answered, and it includes everything the mod adds to a call
  it does not answer. It does not come from the mod.
- **Wait per call** pools every answered call of a phase: total wait over
  total calls. Sessions differ in how many calls the model makes, so a
  per-session figure alone would mix that in. A call that returned an error is
  counted apart and is not a wait sample: it is usually a fast refusal, the
  model's own bad argument or a server's quota message.
- **Session time** is the host's reported duration of the session, model
  time included.
- **Served, prefetches, unused** come from the mod's counters in its plugin
  store, read before and after each session. Served is ready results plus
  in-flight joins. Unused is prefetches started minus served, so a prefetch
  still outstanding when a session ends counts as unused. Every unused
  prefetch is an extra read against the server.
- **Hit rate** is served calls over every MCP call the model made in the
  `on` arm, the ones that errored included: how often a call was answered
  from a prefetch. **Prefetches used** is served calls over prefetches
  started. The two pull against each other, since starting more prefetches
  raises the first and lowers the second, so report both.
- **Next-call recall** at 1 and at 3 is the predictor's own count: of the
  calls it could have predicted, how many were its first choice, and among
  its first three. A prediction that was right but never started, or not
  ready in time, counts here and not in the hit rate, so the gap between the
  two is what was lost after prediction.

- **Model time to first token** and **time in the model** are the host's
  own figures for each request and for the session. The mod is in no request
  to the model, so the two arms should agree. Where they do not, the host is
  sending the arms different requests, and a session time then compares more
  than the mod. This happened: see
  [the first runs of 2026-11-22](#the-first-runs-of-the-day-and-what-was-wrong-with-them).
  The runner keeps Claude Code's Artifact tool out of both arms for that
  reason.

A pair is left out of a summary only when one of its sessions failed or got no
result from any MCP call; the count of excluded pairs is reported.

The runner asks the server for its tool list first and stops unless every tool
a workload names is annotated `readOnlyHint: true`. Sessions are allowed the
server's read-only tools and nothing else.

```bash
SPECULATE_BENCH_LIVE=1 npm run bench:live -- --scenario mslearn --json mslearn.json
SPECULATE_BENCH_LIVE=1 npm run bench:live -- --scenario huggingface --json huggingface.json
npm run bench:live -- --summarize mslearn.json huggingface.json
```

`--pairs`, `--warmup`, `--model`, `--workload`, `--cold`, `--proxy`, `--keep`
and `--mod` (another checkout to load in the `on` arm) are described at the
top of `bench/live.ts`. Load the mod from a copy (`--mod`) when the checkout
may change during a run: the `on` arm reads the mod's files at the start of
every session. Claude
Code must be able to authenticate from the environment, because each arm's
configuration directory starts empty. Behind an HTTPS proxy, set
`NODE_USE_ENV_PROXY=1` for the runner's own check of the server.

Report the revision, the Claude Code version, the model, the date and where
the run was made from. Check the model's side of the two arms before reading
a session time. Report hit rate beside tool wait: a wait is a property
of the server as much as of Speculate, and a hit rate is not. Lead the waits
with per-session medians: a phase has a few dozen calls, and one slow call
moves a mean a long way. Report the learning pairs as well as the warm ones,
the unused prefetches as well as the served calls, and session time as well
as tool wait. Keep the result file: it holds every
session and every call, so a reader can check a summary against it.

### Results: after the prediction changes (2026-11-22)

The mod after the changes of
[§13.32](implementation-notes.md#1332-prediction-that-fits-how-a-model-calls-2026-11-22):
tools that return structured content are served, a step of parallel calls is
predicted and prefetched together, a result's rows are counted by document,
the first call of an exchange is read out of the prompt, and a session's
opening reads start in the order the session makes them. The
[2026-11-21 results](#results-main-after-v100-2026-11-21) below are the
record of the code before them.

| Condition | Value |
| --- | --- |
| Mod | Mock server: `feceba2`. Hosted servers: `9f46b24`, which differs from it only in the order of a session's opening reads. Each loaded from a copy made with `git archive` (`--mod`) |
| Host | Claude Code 2.1.330, headless (`claude -p`), its Artifact tool disallowed in both arms ([why](#the-first-runs-of-the-day-and-what-was-wrong-with-them)) |
| Model | `claude-haiku-5-5` for both arms |
| Servers | Microsoft Learn (about 250 ms a fetch and 450 ms a search), the Hugging Face Hub (about 70 ms a call), and the bundled mock GitHub server over stdio with 1.5 s added to every call |
| Run from | The same Linux cloud container as the day before (Node 22.23.5), behind an HTTPS egress proxy |
| Size | Hosted servers: 8 pairs per workload, pairs 1 and 2 learning, 3 to 8 warm. Mock server: 6 pairs, 4 warm. 132 sessions in the three reported files, $0.99 of model use |
| Result files | [`bench/results/2026-11-22/`](https://github.com/lukebward/speculate/tree/main/bench/results/2026-11-22) |

Hit rate first, since it does not depend on how fast a server is. Warm pairs:

| Server | Workload | Calls | Served | Hit rate | Hit rate before | Prefetches | Used | Unused | Recall@1 | Recall@3 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Mock GitHub, 1.5 s | scripted | 32 | 31 | 97% | 84% | 32 | 97% | 1 | 94% | 100% |
| Mock GitHub, 1.5 s | repeat | 20 | 19 | 95% | 50% | 19 | 100% | 0 | 40% | 80% |
| Mock GitHub, 1.5 s | varied | 8 | 4 | 50% | 0% | 4 | 100% | 0 | 25% | 50% |
| Microsoft Learn | scripted | 37 | 36 | 97% | 67% | 54 | 67% | 18 | 68% | 97% |
| Microsoft Learn | repeat | 19 | 10 | 53% | 56% | 18 | 56% | 8 | 37% | 53% |
| Microsoft Learn | varied | 19 | 7 | 37% | 0% | 15 | 47% | 8 | 26% | 37% |
| Hugging Face Hub | scripted | 36 | 35 | 97% | 100% | 51 | 69% | 16 | 81% | 100% |
| Hugging Face Hub | repeat | 22 | 4 | 18% | 17% | 14 | 29% | 10 | 8% | 17% |
| Hugging Face Hub | varied | 21 | 0 | 0% | 0% | 0 | n/a | 0 | 0% | 0% |

"Before" is the 2026-11-21 run for the hosted servers (`77df2fe`) and, for the
mock server, a run of `3c9b4a9` earlier on the same day, which already served
structured content. Across the nine rows, 146 of 214 calls were served (68%)
from 207 prefetches (71% used).

The same pairs, per session. Tool wait and session time are medians over the
warm sessions of each arm:

| Server | Workload | Tool wait per session, off | Tool wait per session, on | Change | Pairs with less wait | Session time, off | Session time, on | Change |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Mock GitHub, 1.5 s | scripted | 12120 ms | 4991 ms | -59% | 4 of 4 | 23203 ms | 15799 ms | -32% |
| Mock GitHub, 1.5 s | repeat | 7578 ms | 1302 ms | -83% | 4 of 4 | 8638 ms | 7121 ms | -18% |
| Mock GitHub, 1.5 s | varied | 3043 ms | 1547 ms | -49% | 3 of 4 | 6140 ms | 5346 ms | -13% |
| Microsoft Learn | scripted | 2413 ms | 310 ms | -87% | 6 of 6 | 11772 ms | 9527 ms | -19% |
| Microsoft Learn | repeat | 1527 ms | 957 ms | -37% | 4 of 6 | 10382 ms | 8967 ms | -14% |
| Microsoft Learn | varied | 1404 ms | 1227 ms | -13% | 3 of 6 | 8437 ms | 9007 ms | +7% |
| Hugging Face Hub | scripted | 442 ms | 173 ms | -61% | 6 of 6 | 9227 ms | 8873 ms | -4% |
| Hugging Face Hub | repeat | 182 ms | 261 ms | +44% | 2 of 6 | 6918 ms | 6696 ms | -3% |
| Hugging Face Hub | varied | 203 ms | 354 ms | +75% | 2 of 6 | 7325 ms | 8247 ms | +13% |

Per call:

| Server | Workload | Calls off / on | Errors off / on | Served | Prefetches | Unused | Mean wait per call, off | Mean wait per call, on |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Mock GitHub, 1.5 s | scripted | 32 / 32 | 0 / 0 | 31 (7 ready, 24 joined) | 32 | 1 | 1515 ms | 621 ms |
| Mock GitHub, 1.5 s | repeat | 20 / 20 | 0 / 0 | 19 (11 ready, 8 joined) | 19 | 0 | 1516 ms | 238 ms |
| Mock GitHub, 1.5 s | varied | 8 / 8 | 0 / 0 | 4 (4 ready, 0 joined) | 4 | 0 | 1522 ms | 773 ms |
| Microsoft Learn | scripted | 38 / 37 | 0 / 0 | 36 (33 ready, 3 joined) | 54 | 18 | 383 ms | 46 ms |
| Microsoft Learn | repeat | 18 / 19 | 0 / 0 | 10 (10 ready, 0 joined) | 18 | 8 | 507 ms | 307 ms |
| Microsoft Learn | varied | 19 / 19 | 0 / 0 | 7 (7 ready, 0 joined) | 15 | 8 | 447 ms | 356 ms |
| Hugging Face Hub | scripted | 36 / 36 | 0 / 0 | 35 (35 ready, 0 joined) | 51 | 16 | 76 ms | 30 ms |
| Hugging Face Hub | repeat | 12 / 12 | 4 / 10 | 4 (4 ready, 0 joined) | 14 | 10 | 97 ms | 83 ms |
| Hugging Face Hub | varied | 12 / 17 | 3 / 4 | 0 (0 ready, 0 joined) | 0 | 0 | 123 ms | 128 ms |

And the model's side of the same sessions, which the mod does not touch. The
two arms must agree here for a session time to compare the mod and nothing
else, and they do:

| Server | Workload | Model time to first token, off | Model time to first token, on | Time in the model per session, off | Time in the model per session, on |
| --- | --- | ---: | ---: | ---: | ---: |
| Mock GitHub, 1.5 s | scripted | 481 ms | 497 ms | 7402 ms | 8110 ms |
| Mock GitHub, 1.5 s | repeat | 480 ms | 479 ms | 4328 ms | 4747 ms |
| Mock GitHub, 1.5 s | varied | 490 ms | 492 ms | 2989 ms | 3030 ms |
| Microsoft Learn | scripted | 540 ms | 529 ms | 6274 ms | 6499 ms |
| Microsoft Learn | repeat | 578 ms | 530 ms | 7950 ms | 6726 ms |
| Microsoft Learn | varied | 489 ms | 507 ms | 5959 ms | 6449 ms |
| Hugging Face Hub | scripted | 486 ms | 496 ms | 6033 ms | 5991 ms |
| Hugging Face Hub | repeat | 469 ms | 455 ms | 5221 ms | 5285 ms |
| Hugging Face Hub | varied | 456 ms | 448 ms | 5660 ms | 6460 ms |

What the tables show:

- **A slow server is where the time is.** With 1.5 s per call, a session
  waited 7.1 s less on tools in the scripted workload and 6.3 s less in the
  repeated question, and the whole session was 32% and 18% shorter. The
  server is a fixture, so read it as what a slow server allows, not as a
  service.
- **Session time now follows tool wait on Microsoft Learn too.** The scripted
  session waited 2.1 s less on tools and took 2.2 s less in all, 19%. The day
  before, the same workload showed no change in session time, and the cause
  was not the mod: see below.
- **Microsoft Learn's search is served.** It returns structured content and
  was the call the mod could not answer the day before. Every distinct call
  of the scripted session was answered from the third session on, 36 of 37.
- **A step of parallel reads is prefetched whole.** In the repeated question
  on the mock server the model lists, then reads two issues and their
  comments in one or two steps. Hit rate went from 50% to 95% with no unused
  prefetch: both reads of a step are predicted from the list and run together
  on a server the model itself has used that way.
- **A new subject named in the prompt is served.** On the mock server the
  varied prompts name an issue or a pull request by number, alternately. The
  two sessions that had two earlier prompts of their kind were served whole
  (52 ms and 45 ms of tool wait against 3040 ms); the two before them could
  not be. With six subjects in the fixture, that is the 50%.
- **A new subject the model has to search for is partly served.** On
  Microsoft Learn the varied session is a search and two page fetches. The
  search is the model's own wording and is never predicted. One of the two
  pages was ready in most sessions: 7 of 19 calls, with 8 of 15 prefetches
  unused. Which hits a model opens is a judgment, and position is all the
  learner has. Session time did not improve.
- **An ordinary question asked again depends on the model.** On Microsoft
  Learn the model made the same calls again for 10 of 19 calls in this run and
  14 of 19 in the first run of the day. An exact-match buffer has nothing for
  a reworded call.
- **The Hub is as it was.** Its results are Markdown, which gives the learner
  nothing to read arguments from, so only an exact repeat is served: the
  scripted workload, and little of the other two. In the varied workload
  nothing was prefetched, and the arms differ by what the two sessions
  happened to call (17 calls against 12).

#### The first runs of the day, and what was wrong with them

The benchmark was first run with the mod at `9f46b24` and no tool disallowed
(`with-artifact-tool/` in the result files). Hit rates were as good, and
session time did not fall on the hosted servers although tool wait did. The
model's side of those sessions shows why:

| Server | Workload | Model time to first token, off | Model time to first token, on | Time in the model per session, off | Time in the model per session, on |
| --- | --- | ---: | ---: | ---: | ---: |
| Mock GitHub, 1.5 s | scripted | 499 ms | 648 ms | 7781 ms | 9320 ms |
| Mock GitHub, 1.5 s | repeat | 485 ms | 674 ms | 4701 ms | 4572 ms |
| Mock GitHub, 1.5 s | varied | 480 ms | 631 ms | 2543 ms | 3353 ms |
| Microsoft Learn | scripted | 577 ms | 718 ms | 6540 ms | 8332 ms |
| Microsoft Learn | repeat | 580 ms | 762 ms | 5699 ms | 8015 ms |
| Microsoft Learn | varied | 496 ms | 678 ms | 6217 ms | 6308 ms |
| Hugging Face Hub | scripted | 491 ms | 665 ms | 6135 ms | 7329 ms |
| Hugging Face Hub | repeat | 469 ms | 645 ms | 5456 ms | 6047 ms |
| Hugging Face Hub | varied | 462 ms | 629 ms | 6873 ms | 6917 ms |

Every request to the model took about 170 ms longer to its first token in the
`on` arm, in all nine workloads, the ones with no prefetch included. The mod
is in no request. Probe mods and the host's debug log found the cause:

- The container the benchmark runs in is a cloud session, and Claude Code
  there offers a tool of its own, Artifact, that a local session does not.
- When any mod hooks tool calls before they run (`tool.call`, `tool.check`,
  `tool.run` or `classic.PreToolUse`) with a matcher the host cannot read
  ahead (none, or a regular expression), the host builds that tool without
  one of its options (`edit_hook=true` in the debug log). An empty mod, a
  `prompt.submit` hook, a `classic.PostToolUse` hook, and a `tool.call` hook
  whose matcher is a list of tool names leave it alone.
- The tool list opens every request, so the `on` arm sent a request 533
  tokens shorter than the `off` arm's, and the API answered it about 200 ms
  later (time to first token, six samples a side, with a pass-through hook
  that does nothing).
- With the Artifact tool disallowed in both arms the requests are the same
  and so is the time to first token: 609 to 640 ms with no mod, 609 to 622 ms
  with the mod.

So the runner now disallows that tool in both arms, and prints the model's
side of each arm beside the rest. A session's eight to ten requests carried
1.2 s to 1.8 s that belonged to where the benchmark ran. The cost is real for
a session that has the Artifact tool: a mod with tool hooks slows each model
request there by about that much, whatever the mod does.

The first runs are a second sample of hit rate, which that cost does not
change. Scripted, repeat, varied: 97%, 95% and 50% on the mock server (the
same); 88%, 74% and 32% on Microsoft Learn; 89%, 36% and 0% on the Hub, and
100%, 6% and 0% in a second run of it.

#### The Hub's slow answers

The Hub's means are not stable. In a direct probe from the same container, 3
of 72 calls took over 300 ms against a median of about 60 ms, whichever call
it was and whether or not it repeated an earlier one. In the first two Hub
runs 13 of 313 answered calls in the warm pairs did, in both arms. One such
call is most of a session's tool wait there. Across the three runs the
scripted workload repeats: median tool wait per session fell 60%, 64% and
61%, and a served call took about 25 ms instead of about 70 ms. In the
repeated question the median session waited longer with the mod in all three
(29%, 39% and 44%), while the pooled wait per call was lower in two of them:
the sessions of a pair make different calls there, the model's own argument
errors included.

#### What it costs

- **Unused prefetches.** 61 of 207 across the nine rows. Most are on
  Microsoft Learn, where a search predicts up to three pages and the model
  opens two, and on the Hub's scripted workload, where a call already
  answered earlier in the session is prefetched again.
- **The first two sessions.** Nothing new is predicted before it has been
  seen twice. In the learning pairs the mod served 3 of 13 calls on Microsoft
  Learn's scripted workload, 2 of 16 on the mock server's, and none elsewhere.
- **A call it does not answer** still waits about 9 ms longer, as measured
  [the day before](#what-the-mod-costs). The trims of `3c9b4a9` did not
  change that measurably: a `--cold` run of the Hub at that commit (12 pairs,
  `huggingface-haiku-cold.json`) gave a median wait per call of 67 ms off and
  74 ms on. The time is the host dispatching hooks.
- **In a session that has the Artifact tool**, about 170 ms on every request
  to the model, as above.

#### What was not measured

Each row is four or six warm sessions, one model, one day, one network
location. The mock server is a fixture with one fixed latency. The varied
workload on the mock server has six subjects, so two counted sessions carry
its result. The proxy was not run again; its
[2026-11-21 results](#against-the-last-proxy-release) are the comparison,
against the mod of that day and with the Artifact tool in both of its arms.
Whether a local Claude Code session has the Artifact tool was not checked
from a local machine. No server that needs a credential was measured.

### Results: `main` after v1.0.0 (2026-11-21)

The first measurement of the mod on real servers.

| Condition | Value |
| --- | --- |
| Mod | `main` at `77df2fe`: v1.0.0 plus the [unreleased changes](releases.md#unreleased-after-v100). The runner's own commits (`d03083a`, `69c570b`) do not touch `src/` or `hooks/` |
| Host | Claude Code 2.1.330, headless (`claude -p`) |
| Model | `claude-haiku-5-5` for both arms; one workload repeated with `claude-sonnet-5-5` |
| Servers | Microsoft Learn (`learn.microsoft.com/api/mcp`, JSON results, about 260 ms a fetch and 500 ms a search) and the Hugging Face Hub (`huggingface.co/mcp`, Markdown results, about 70 ms a call). Neither needs a credential |
| Run from | A Linux cloud container (Node 22.23.5) behind an HTTPS egress proxy, on one day |
| Size | 8 pairs per workload: pairs 1 and 2 learning, pairs 3 to 8 warm. 360 sessions in the result files, $7.48 of model use |
| Result files | [`bench/results/2026-11-21/`](https://github.com/lukebward/speculate/tree/main/bench/results/2026-11-21) |

Warm pairs, per session. Tool wait and session time are medians over the six
warm sessions of each arm:

| Server | Workload | Tool wait per session, off | Tool wait per session, on | Change | Pairs with less wait | Session time, off | Session time, on | Change |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Microsoft Learn | scripted | 2108 ms | 1269 ms | -40% | 6 of 6 | 11170 ms | 10128 ms | -9% |
| Microsoft Learn | repeat | 1561 ms | 684 ms | -56% | 6 of 6 | 10477 ms | 9363 ms | -11% |
| Microsoft Learn | varied | 1680 ms | 1521 ms | -9% | 2 of 6 | 8298 ms | 8323 ms | 0% |
| Hugging Face Hub | scripted | 420 ms | 162 ms | -61% | 6 of 6 | 9254 ms | 9393 ms | +2% |
| Hugging Face Hub | repeat | 172 ms | 240 ms | +40% | 1 of 6 | 7017 ms | 6946 ms | -1% |
| Hugging Face Hub | varied | 189 ms | 291 ms | +54% | 0 of 6 | 7319 ms | 7595 ms | +4% |

The same pairs, per call:

| Server | Workload | Calls off / on | Errors off / on | Served | Prefetches | Unused | Mean wait per call, off | Mean wait per call, on |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Microsoft Learn | scripted | 36 / 36 | 0 / 0 | 24 | 34 | 10 | 621 ms | 224 ms |
| Microsoft Learn | repeat | 19 / 18 | 0 / 0 | 10 | 10 | 0 | 529 ms | 243 ms |
| Microsoft Learn | varied | 20 / 18 | 0 / 0 | 0 | 0 | 0 | 522 ms | 588 ms |
| Hugging Face Hub | scripted | 36 / 36 | 0 / 0 | 36 | 51 | 15 | 71 ms | 28 ms |
| Hugging Face Hub | repeat | 12 / 12 | 4 / 6 | 3 | 17 | 14 | 94 ms | 102 ms |
| Hugging Face Hub | varied | 13 / 15 | 3 / 4 | 0 | 0 | 0 | 86 ms | 133 ms |

Every served call was a ready result; none was an in-flight join. The 621 ms
in the first row includes one search that took 10.5 s in an `off` session, a
server outlier that is kept: without that one call the `off` mean is 340 ms.
The per-session medians above barely move with it, which is why they lead.

What the tables show:

- **A workflow that repeats exactly is served.** In the scripted workload the
  mod answered every fetch on Microsoft Learn (24 of 24, in about 25 ms
  instead of about 260 ms) and every call on the Hub (36 of 36, in about
  28 ms instead of about 70 ms). Tool wait per session fell 40% and 61%, in
  every pair.
- **It cannot serve a tool that returns structured content.** No search on
  Microsoft Learn was served, 0 of 12, although the first search was
  identical in every scripted session and the second always followed the same
  fetch. The predictor had those searches; the mod holds that tool
  unservable, for the reason under [hit rate](#why-the-search-is-never-served).
  On that server the searches are the slower calls, so most of the remaining
  wait is theirs.
- **An ordinary repeated question ranges from a large gain to a loss.** With
  the model choosing the calls, the result depends on whether it makes the
  same call as last time. Microsoft Learn: 10 of 18 calls served, tool wait
  down 56%. The Hub: 3 of 12 served, 14 of 17 prefetches unused, tool wait up
  40%. The [first run](#run-to-run-variation) of the same workloads gave -14%
  and -64%. The two arms of a pair often make different calls here, so part
  of each difference is the calls and not the mod.
- **A new subject every session is not helped.** Nothing was served in the
  varied workload, 0 of 33 calls, and nothing was prefetched. Microsoft Learn
  shows no effect either way (2 of 6 pairs). The Hub was slower with the mod
  in all six pairs.
- **Session time did not measurably change.** Tools were 15% to 20% of a
  session on Microsoft Learn and 2% to 5% on the Hub; the model is the rest.
  The 9% and 11% on Microsoft Learn are in the right direction and the right
  size for the tool wait removed (about 0.9 s of 10 s to 11 s), but session
  medians moved between the arms by as much (-14% to +14%) in the learning
  pairs, where almost nothing was served. This design cannot resolve a
  difference that small.

#### What the mod costs

- **Unused prefetches.** 10 of 34 on Microsoft Learn and 15 of 51 on the Hub
  in the scripted workload, with every session identical: about 2 extra reads
  per session against the server. 14 of 17 in the Hub's repeat workload.
- **A call it does not answer waits longer.** A separate run (`--cold`,
  scripted, the Hub, 12 pairs) cleared the mod's store before every `on`
  session, so both arms made the same 72 calls and the mod prefetched
  nothing. Mean wait per call was 76 ms off and 85 ms on (medians 70.5 ms and
  79 ms): about 9 ms a call, and less tool wait with the mod in 1 of 12
  pairs. The built-in `ToolSearch` call, which the mod only passes through,
  took a median 16 ms off and 38 ms on in that run (12 calls each). On a
  server that answers in 70 ms, that overhead is why the varied workload was
  slower with the mod.
- **A served call is not free.** It took about 25 ms to 28 ms: it still goes
  through the host's permission check and PreToolUse hooks. Against a 70 ms
  server that leaves about 45 ms to save per call.
- **`/speculate` overstates the saving on a fast server.** The mod's estimate
  credits a served call with the tool's whole latency. For the Hub's scripted
  warm pairs it reported 3.7 s saved where the measured difference in tool
  wait was 1.5 s. For Microsoft Learn (the Sonnet run, which had no outlier)
  it reported 8.1 s against a measured 7.0 s.

#### A second model

The scripted workload on Microsoft Learn, repeated with `claude-sonnet-5-5`
(8 pairs, 6 warm). The other workloads were not run with this model: a
session cost about $0.26, seventeen times the Haiku session.

| Model | Tool wait per session, off | Tool wait per session, on | Change | Pairs with less wait | Served | Prefetches | Unused | Session time, off | Session time, on |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `claude-haiku-5-5` | 2108 ms | 1269 ms | -40% | 6 of 6 | 24 of 36 | 34 | 10 | 11170 ms | 10128 ms |
| `claude-sonnet-5-5` | 2381 ms | 1211 ms | -49% | 6 of 6 | 23 of 36 | 30 | 7 | 10471 ms | 9866 ms |

#### Against the last proxy release

The same benchmark with the last proxy release, 0.25.0 from npm, in the `on`
arm in place of the mod (`--proxy`): the same servers, prompts, model and
day, about three and a half hours after the mod's run. The proxy ran from a
config file in `annotated` mode, the mode 0.x's own setup used, with one
state file per workload. Change in median tool wait per session against each
run's own `off` arm, warm pairs:

| Server | Workload | Proxy 0.25.0 | Served | Unused | Mod | Served | Unused |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Microsoft Learn | scripted | -96% (6 of 6) | 36 of 36 | 18 of 54 | -40% (6 of 6) | 24 of 36 | 10 of 34 |
| Microsoft Learn | repeat | -38% (5 of 6) | 9 of 18 | 12 of 21 | -56% (6 of 6) | 10 of 18 | 0 of 10 |
| Microsoft Learn | varied | +15% (2 of 6) | 1 of 18 | 7 of 8 | -9% (2 of 6) | 0 of 18 | 0 of 0 |
| Hugging Face Hub | scripted | -77% (6 of 6) | 36 of 36 | 15 of 51 | -61% (6 of 6) | 36 of 36 | 15 of 51 |
| Hugging Face Hub | repeat | -43% (6 of 6) | 5 of 12 | 10 of 15 | +40% (1 of 6) | 3 of 12 | 14 of 17 |
| Hugging Face Hub | varied | -8% (3 of 6) | 0 of 12 | 0 of 0 | +54% (0 of 6) | 0 of 15 | 0 of 0 |

In the scripted workload a session's tool wait went from 2385 ms to 107 ms on
Microsoft Learn and from 479 ms to 109 ms on the Hub with the proxy. The mod's
figures are 2108 ms to 1269 ms and 420 ms to 162 ms.

On a workflow that repeats, the proxy was faster than the mod that replaced
it. Three differences show in the calls:

- **It served the session's first call.** Every search on Microsoft Learn
  came from a prefetch, 12 of 12, where the mod served none. The searches were
  about half of what a session waited on tools there, and that is most of the
  gap on that server.
- **A served call cost less:** about 18 ms through the proxy, 25 ms to 28 ms
  through the mod.
- **A call it did not answer cost nothing measurable.** Unanswered Hub calls
  took a median 84 ms to 86 ms with the proxy and 84 ms to 88 ms without, and
  the built-in `ToolSearch` 18 ms and 19 ms. The mod's hooks add about 9 ms
  to the first and about 22 ms to the second. In the Hub's varied workload,
  where neither version served anything, sessions waited 8% less on tools
  with the proxy and 54% more with the mod.

The proxy also started sooner. In the two learning pairs of the scripted
Microsoft Learn workload it served 7 of 12 calls and the mod 2 of 12; its
very first session served 3 of 6.

It spent more of the server to do it: 18 unused prefetches to the mod's 10
in that workload, and in the varied one it started 8, used 1, and its
sessions waited 15% longer, where the mod started none. In the repeat
workload neither is ahead on both servers, and that workload does not repeat
from run to run for either.

Session time fell 19% in the proxy's scripted Microsoft Learn sessions
(13.5 s to 11.0 s), about what removing 2.3 s of tool wait gives. It is the
largest change in session time in this benchmark.

The causes, as far as they were found:

- **The unserved searches** are a tool the mod cannot serve: one that returns
  structured content. See [why the search is never served](#why-the-search-is-never-served).
- **The slower start** is by design. The mod prefetches a tool only after a
  real call through Claude Code has reported it read-only; the proxy took the
  server's own annotation when it connected and could prefetch a tool it had
  never seen run.
- **The dearer served call** is by design too. A served call still runs
  through the host's permission check and PreToolUse hooks before the mod
  answers it (§13.29); the proxy answered from its buffer.
- **The cost on a call it does not answer** comes with being a mod: its hooks
  run on every tool call, built-in tools included, where the proxy saw only
  MCP calls to its own server. How that time divides between the host
  dispatching a hook and the mod's own calls to the host was not measured.

The proxy here was run by its config-file path and not 0.25's `speculate run`
observer, and the six-workload run was made at another hour than the mod's;
the scripted Microsoft Learn row was repeated with both at once and came out
the same (-95% and -44%). Neither speed nor hit rate is why v1.0 replaced the
proxy: it could not see the permission settings, the hooks, or the shell
commands that the mod's safety rules are built on, and it had to rewrite
every server registration to be reached.

#### Hit rate

Tool wait depends on the server as much as on Speculate. Hit rate does not:
it is how often a call the model made was answered from a prefetch. Warm
pairs of the runs above, beside the share of prefetches that were used:

| Server | Workload | Mod: hit rate | Mod: prefetches used | Proxy 0.25.0: hit rate | Proxy 0.25.0: prefetches used |
| --- | --- | ---: | ---: | ---: | ---: |
| Microsoft Learn | scripted | 67% (24 of 36) | 71% (24 of 34) | 100% (36 of 36) | 67% (36 of 54) |
| Microsoft Learn | repeat | 56% (10 of 18) | 100% (10 of 10) | 50% (9 of 18) | 43% (9 of 21) |
| Microsoft Learn | varied | 0% (0 of 18) | none started | 6% (1 of 18) | 13% (1 of 8) |
| Hugging Face Hub | scripted | 100% (36 of 36) | 71% (36 of 51) | 100% (36 of 36) | 71% (36 of 51) |
| Hugging Face Hub | repeat | 17% (3 of 18) | 18% (3 of 17) | 42% (5 of 12) | 33% (5 of 15) |
| Hugging Face Hub | varied | 0% (0 of 19) | none started | 0% (0 of 12) | none started |
| All six | | 50% (73 of 145) | 65% (73 of 112) | 66% (87 of 132) | 58% (87 of 149) |

The mod's other runs gave 46%, 32%, 6%, 100%, 43% and 0% in the same order
(the first run, whose scripted Microsoft Learn workload differed) and 64%
for the scripted Microsoft Learn workload with `claude-sonnet-5-5`. In the
two learning pairs of that workload the hit rate was 17% for the mod (2 of
12) and 58% for the proxy (7 of 12).

The proxy's hit rate is higher overall, and the whole of that is two rows.
On the scripted Microsoft Learn workload the mod served every fetch and no
search; the proxy served both. The Hub's repeat row is the workload that does
not repeat from run to run. The mod used more of what it prefetched.

To separate prediction from what happens after it, both versions were run
once more at the same time on the scripted Microsoft Learn workload (8
pairs, 6 warm, `same-time/` in the result files), with the predictor's own
recall recorded:

| Version | Recall@1 | Recall@3 | Hit rate | Prefetches | Used | Unused | Tool wait per session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Mod | 63% (24 of 38) | 92% (35 of 38) | 63% (24 of 38) | 27 | 89% | 3 | -44% (6 of 6) |
| Proxy 0.25.0 | 63% (24 of 38) | 87% (33 of 38) | 97% (37 of 38) | 58 | 64% | 21 | -95% (6 of 6) |

- **Prediction is the same in both.** The first choice was right for 24 of
  38 calls in each, and the right call was among the first three for 35 and
  for 33.
- **The mod serves its first choice and little else.** Its hit rate equals
  its recall at 1. The right call was among its first three predictions for
  35 of 38 calls, which includes at least 9 of the 12 searches, and it served
  none of those searches. It started 27 prefetches for 38 calls; the proxy
  started 58. So 29 points of hit rate were lost after a correct prediction,
  not for want of one.
- **The proxy's hit rate is above its recall at 3.** Some of what it served
  came from predictions that recall does not count as next-call predictions.
- **It is a trade, and the versions sit at opposite ends of it.** The proxy
  made 21 reads nothing used, three and a half a session, to serve 13 more
  calls. The mod made 3.

##### Why the search is never served

!!! note "No longer true"

    This explains the 2026-11-21 result. A tool that returns structured
    content has been served since `24a6579`: see the
    [2026-11-22 results](#results-after-the-prediction-changes-2026-11-22).

The mod records a tool as servable only when Claude Code hands its hook the
tool's result as an array of content blocks (`hooks/register.ts`), because
that is the form in which a mod can hand a result back. Microsoft Learn's
search declares an `outputSchema` and returns `structuredContent` beside its
text block, and for it the hook receives a string. A probe mod recorded the
shapes under Claude Code 2.1.330: a string for `microsoft_docs_search`, an
array of blocks for `microsoft_docs_fetch`, and the Hub's tools return no
structured content. The mod's store accordingly holds `servable: false` for
the search, so every prediction of it is dropped as `not-servable` before it
starts. That is the 12 searches, and it is the whole of the hit-rate gap on
this server.

The proxy has no such limit. It sits on the MCP connection and passes on
whatever the server returned.

The serial rule was the first suspect and is not the cause. The mod runs one
speculative call at a time against every server, where the proxy ran two
against an HTTP server (§13.29). The scripted session was replayed offline
through the mod's own core on a virtual clock, with the search servable, 500
ms and 280 ms calls and one second between them: every call was served from
the third session on, searches and the opening call included, under the
serial budget and under the proxy's HTTP budget alike.


#### Run-to-run variation

The whole Haiku benchmark was run twice on the day. The first run
(`first-run/` in the result files) was made before the runner's first commit;
its summaries are recomputed by the committed rules. Change in median tool
wait per session, warm pairs, with the pairs that waited less:

| Server | Workload | First run | Reported run |
| --- | --- | ---: | ---: |
| Microsoft Learn | scripted | -34% (4 of 6) | -40% (6 of 6) |
| Microsoft Learn | repeat | -14% (5 of 6) | -56% (6 of 6) |
| Microsoft Learn | varied | -6% (3 of 6) | -9% (2 of 6) |
| Hugging Face Hub | scripted | -61% (6 of 6) | -61% (6 of 6) |
| Hugging Face Hub | repeat | -64% (6 of 6) | +40% (1 of 6) |
| Hugging Face Hub | varied | +55% (3 of 6) | +54% (0 of 6) |

The first run's Microsoft Learn scripted row is a slightly different
workload: the server's top two hits were sections of one page, so each half
of the session fetched one url twice, and the mod never prefetches a repeat
of the call that triggered the prediction. The plan step now requires two
distinct pages. The scripted and varied rows repeat; the repeat rows do not,
on either server. Six pairs of a workload in which the model chooses the
calls are not enough to give that workload a number.

#### Limits

- Six warm pairs per workload, one day, one network location. No claim of
  statistical significance is made, and the repeat workload shows how far a
  run can move.
- Both servers are fast. Neither is the seconds-per-call server the design
  argues from, where a served call would save the most and the per-call
  overhead would matter least. Nothing here says what happens there.
- Headless sessions with one prompt. There is no person, so no idle time
  between turns, and prompt-named reads and long-idle expiry were not
  exercised. Sessions were allowed MCP read tools only, so no shell command
  or file edit ever flushed a prefetch.
- The published v1.0.0 was not measured apart from `main`. With no shell or
  file writes in a session, the unreleased flush rule had nothing to act on,
  but that is an inference, not a measurement.
- Not measured: Context7, which refused some anonymous calls from this
  network with "Monthly quota exceeded" (the kind of budget an unused prefetch
  spends); GitHub's hosted server, which needs a token; any stdio server; a
  managed installation.

## Offline replay

Two instruments replay calls with no server and no model.

`npm run bench:replay` replays the sessions a live run kept (`--keep`)
through the mod's core, driven as the hooks drive it: memory carried from
session to session, the recorded prompt, the model's recorded time before
each call, and a prefetch answered with what the server answered the recorded
call. It prints which calls the core would have served. Its use is to try a
change to prediction against what a model really did, in a second and at no
cost. For the changes of 2026-11-22 it gave, before each was measured live,
97%, 95% and 50% for the three mock workloads; the live run then gave the
same three numbers. It is still not a measurement. The model's calls are
fixed to the recording, where a real model might have asked differently once
a call came back sooner.

```bash
SPECULATE_BENCH_LIVE=1 npm run bench:live -- --scenario mockgithub --keep
npm run bench:replay -- --dir /tmp/speculate-live-XXXX --workload repeat --verbose
```

`npm run eval` replays a synthetic corpus through the generic learner and
scores whether the agent's next call, tool and arguments both, was among the
predictions. It has no clock and no server. At `9f46b24` (2026-11-22):

| Corpus | Pairs | recall@1 | recall@3 | Predictions wasted per hit |
| --- | ---: | ---: | ---: | ---: |
| Workflow archetypes (headline) | 1,470 | 57.2% | 86.0% | 1.85 |
| Adversarial floor | 300 | 8.7% | 8.7% | 9.08 |

The corpus has no prompts and no call times, so the prompt reading and the
parallel steps of 2026-11-22 are outside it. Recall at 3 was 85.9% before
them; the difference is the rule for a literal that only ever agreed with a
derivation.

Cold start, workflow archetypes with no warm-up excluded, recall@3: 0% in
session 1, 50.0% in session 2, 68.3% in session 3, 74.2% in sessions 4 and 5,
85.0% in sessions 6 to 10, and 91.6% from session 11.

Read it beside the live results, not instead of them. The corpus is authored
sessions in which workflows recur, so its headline is nearest the live
scripted workload. The live varied workload is what the same learner does
when they do not.

## History: the 0.x proxy

Everything below measured the MCP proxy that v1.0 removed, with instruments
that no longer exist in this repository. To run one, check out the release it
names (the last proxy release is `v0.25.0`). The numbers are snapshots of
those versions and are not claims about the mod.

### Instruments removed in v1.0

| Command | What it measures | Limits |
| --- | --- | --- |
| `npm run bench` (alias: `bench:repeated`) | Full MCP proxy tool wait on changing repeated workflows, with separate persisted learning per arm | Authored fixtures with injected upstream latency; no claim about ordinary traffic or hosted-service latency |
| `npm run eval` | Generic offline replay prediction recall and adversarial floor | No real proxy timing or whole-task speedup |
| `npm run bench:remote` | Alternating off/on sessions against actual hosted MCP servers | Network and service noise; repeats an identical script; requires explicit live opt-in |
| Real filesystem and Git E2Es | Full proxy sessions with actual local operations | Disposable fixtures; inexpensive local reads may cost more to prefetch than they save |
| `npm run bench:mock` | Historical GitHub-rule mechanics example with injected delay | Explicit domain rules and disabled persistence; does not qualify the general learner |

The unused daily-workflow generator had no runner and was removed in v0.20,
along with its unused comparison API. The repeated-workflow harness and its
paired accounting remain maintained.

### Repeated workflows

Build before running; the driver invokes `dist/src/cli.js` from each target.
The default command compares this checkout with speculation off and on. It uses
three seeds, four training sessions, four held-out sessions, and 120 ms injected
latency. Each arm has independent state, shared only across that arm's sessions
for the same workflow and seed. Execution order rotates across sessions.

```bash
npm run build
npm run bench -- --json repeated.json
```

For a release comparison, build both checkouts and supply a baseline. This adds
an enabled baseline arm (`stable`) alongside off and candidate. `off` runs the
baseline revision; `candidate` defaults to this checkout. `--arms` can select
explicit arms for diagnostic runs.

```bash
npm run bench -- --baseline ../speculate-baseline --candidate . \
  --seeds 1,2,3,4,5 --train 8 --holdout 8 --latency 120 --json repeated-release.json
```

Use a fresh output path for a new comparison. The driver writes a JSON artifact
and adjacent `.progress.log`; an existing compatible artifact is merged by
session identity, while incompatible settings are rejected. Progress reports
are not a substitute for the completed artifact.

Train chronologically on earlier sessions. Held-out identifiers, optional calls,
and ordering change; each request is scored before its result can teach that
arm. Earlier held-out sessions can teach later ones, so this is online
chronological evaluation, not a frozen-model test. Fixture domains belong only
in `bench/` and `test/`. Do not tune production mechanisms on held-out answers.

Report cold and held-out results separately, preserve the unpredictable control,
and compare full output digests for every paired session. A useful prediction
is a ready hit or an in-flight join. A join still waits for unfinished work.
Report those counts separately, together with misses, speculative calls,
upstream calls, predictor recall, wait samples and p50/p95, and state size.

At the final snapshot, every speculative call must have exactly one outcome:

```text
speculative calls = ready hits + in-flight joins + terminal wasted + outstanding
shutdown waste = terminal wasted + outstanding at snapshot
```

Outstanding ready/in-flight work is counted as abandoned on close. Report waste
per useful call as well as absolute waste; ready hit rate alone hides joins and
unused upstream work. Estimated saved time in stats is distinct from measured
tool wait. Driver CPU/RSS does not measure all proxy/server process resources.
Neither tool-wait reductions nor offline recall establish end-to-end task gains.

### Real-server checks

Hosted scenarios require live opt-in. The harness checks each tool's
`readOnlyHint` before calling it and aborts if a requested tool is not explicitly
read-only. The following scenarios need no credential:

```bash
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario context7
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario mslearn
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario mslearn-cold
SPECULATE_E2E_LIVE=1 npm run bench:remote -- --scenario huggingface

# GitHub: config holds a ${VAR} placeholder resolved in the child's environment.
SPECULATE_E2E_LIVE=1 GITHUB_TOKEN=$(gh auth token) npm run bench:remote
```

Report every alternating run, including cold starts and regressions. A warm
median here is runs 2 and 3 of an identical script; it describes a favorable
repeated workflow. Schema-backed candidates can sometimes help a first pass,
while learned transitions require evidence. Host/network changes between
separate runs prevent attributing all timing differences to a source change.

The two opt-in local E2Es use SDK-backed stdio servers, actual filesystem
operations, and a disposable Git repository:

```bash
SPECULATE_REAL_E2E=1 npx vitest run test/filesystem-real-e2e.test.ts
SPECULATE_REAL_E2E=1 npx vitest run test/git-real-e2e.test.ts
```

These real harnesses accept `SPECULATE_E2E_TARGET_ROOT=/path/to/built/checkout`,
so one driver can compare revisions. Machine-readable summaries use the labels
`REMOTE_E2E`, `FILESYSTEM_REAL_E2E`, and `GIT_REAL_E2E`.

### v0.20 qualification against v0.19

This is a simplification and prediction-lifecycle release. Validation on
2026-09-07 used Node 22.23.2 on Linux and the released v0.19.0 commit
`3c503a015bc7f841a77e03d54c4cf7ed1b4cf64a` as the baseline. It does not
establish a general task-speed improvement.

#### Paired repeated workflows

The complete comparison ran all five workflows over seeds 1, 2, and 3, with
four training and four held-out sessions per seed and 120 ms injected latency.
All 360 proxy sessions completed, and paired output digests matched. Each
held-out arm contained 336 real tool calls across 60 sessions.

| Held-out metric | Off | v0.19.0 | v0.20.0 |
| --- | ---: | ---: | ---: |
| Ready hits | 0 | 13 | 13 |
| In-flight joins | 0 | 191 | 191 |
| Useful calls / real calls | 0/336 | 204/336 | 204/336 |
| Speculative upstream calls | 0 | 287 | 287 |
| Terminal wasted calls | 0 | 83 | 83 |
| Predictor recall@3 | n/a | 67.8571% | 67.8571% |
| Mean tool wait | 123.42 ms | 96.25 ms | 96.25 ms |
| p95 tool wait | 129.66 ms | 129.42 ms | 129.35 ms |
| Peak state file | 0 bytes | 30,545 bytes | 29,714 bytes |

Cold useful calls also matched at 11/84, with 13 wasted calls in each enabled
arm. The unpredictable control issued no speculation. The candidate preserved
useful work and waste totals; measured wait was effectively unchanged. Removing
duplicate latency storage reduced the peak state file in this fixture, but the
queue-lifetime correction did not demonstrate a throughput gain here.
Supplemental validation overlapped part of this run; sub-millisecond timing
differences should not be attributed to the release.

```bash
npm run bench -- --baseline ../speculate-release-baseline --candidate . \
  --seeds 1,2,3 --train 4 --holdout 4 --latency 120 --json repeated-release.json
```

#### Feedback ablation

The operational feedback cutoff remains alongside correctness calibration.
They address different outcomes: a correct prediction can expire before the
real call arrives. Their shared scoring implementation was consolidated.

Two otherwise identical builds differed only in the operational cutoff
(`FEEDBACK_EFFECTIVENESS_FLOOR`: 0.15 versus 0). With seed 1, four training
and four held-out sessions, all five repeated workflows, and 120 ms injected
latency, both builds served 68 useful predictions in 112 held-out calls,
issued 96 speculative calls, and wasted 28. This fixture alone did not show a
reason to delete the cutoff.

A deterministic ablation exercised the production predictor, calibration,
latency model, metrics, and cache with an injected clock. It offered 100 correct
list-to-detail predictions with a 200 ms latency estimate and the normal
30-second TTL. When requests arrived after 30.001 seconds, the cutoff stopped
after eight wasted calls; removing it wasted all 100. With requests at five
seconds, both variants served all 100. The recovery fixture also exposed the
tradeoff: when the first 20 requests arrived too late and later requests were
timely, the cutoff stayed muted, while calibration alone recovered to 80 hits with 20 wasted
calls. That recovery limitation remains; this release does not introduce a
new exploration mechanism. These are controlled fixtures, not live-server
performance measurements.

#### Other validation

The default test suite passed 853 tests with seven platform/opt-in skips.
Strict documentation build and the production TypeScript build passed. A clean
package install completed MCP initialization, tool discovery, and a real tool
call against the bundled fixture on Node 18.20.8. Clean builds remove `dist`
before compiling so retired modules cannot remain in a published tarball.

Generic replay recall@3 stayed at 85.9184%, with the adversarial floor at
8.6667% and prediction waste per hit at 1.8480. This corpus models triggered
calls; startup timing is explicitly unmeasured, and constant-argument
transitions now receive the ordinary next-call lifetime.

Both versions passed the real filesystem and Git E2Es using the same current
drivers. Filesystem useful predictions stayed at 30/44 with five terminal
wasted calls. Unconstrained Git stayed at 36/45 with eight wasted calls. In the
cheap-read Git default-admission check, the baseline issued no speculation;
the candidate issued three calls, of which two were useful and one wasted,
before later sessions suppressed speculation. These validation runs overlapped
other local checks and do not isolate a release speedup.

The credential-free live Microsoft Learn check completed three off/on pairs
without tool errors. Candidate useful calls were 2/6, 2/6, and 5/6. Measured off
waits were 1589, 1344, and 1648 ms; on waits were 1387, 1103, and 622 ms.
Outstanding predictions at the final snapshots were 2, 2, and 4, so zero
completed waste at those snapshots does not mean zero terminal waste. This
was a candidate off/on check, not a live comparison with v0.19.

### Historical hosted-server snapshots

These earlier snapshots used three alternating off/on runs each with no
per-server prediction configuration. Warm tool wait is the median of runs 2
and 3, after repeating the identical session.

| Server | Auth | Warm tool wait | Reduction |
| --- | --- | --- | ---: |
| Context7 | none | 9.4 s to 3.1 s | 67% |
| GitHub hosted MCP | token | 5.0 s to 1.6 s | 67% |
| Microsoft Learn | none | 2.3 s to 1.1 s | 54% |
| Hugging Face Hub | none | 259 ms to 139 ms | 46% |

They reported zero completed waste but predated final outstanding-batch
accounting, so they do not establish zero wasted calls. Current harnesses
expose outstanding work and count it as abandoned at shutdown. These are
historical observations, not current-release qualification. Full run history
and caveats remain in the [implementation notes](implementation-notes.md) and
[release notes](releases.md).

### Historical qualification: v0.19 versus v0.18

The upgrade passed the release gates set before measurement. The clearest
benefit is more useful prefetches on repeated workflows whose arguments depend
on earlier calls. These are controlled MCP fixtures with 120 ms injected
upstream latency, not measurements of GitHub or Linear service performance.

#### Before and after

Five seeds each ran eight training and eight held-out sessions through the
full MCP proxy. Speculation off, v0.18.0, and the candidate used the same
fixtures with independent persisted state and rotating arm order. The run
contained 1,200 sessions and 6,720 requested calls. Each repeated workflow
below has 200 held-out requests per arm.

| Repeated workflow | v0.18 mean wait | v0.19 mean wait | Reduction | Useful before | Useful after |
| --- | ---: | ---: | ---: | ---: | ---: |
| CI investigation | 83.80 ms | 73.72 ms | 12.03% | 54.5% | 70.0% |
| PR review | 86.79 ms | 80.37 ms | 7.39% | 80.0% | 85.5% |
| Issue triage | 97.99 ms | 82.16 ms | 16.15% | 70.0% | 89.5% |
| Renamed tools | 98.53 ms | 83.60 ms | 15.15% | 69.5% | 90.0% |

"Useful" combines ready cache hits and joins of already-issued speculative
calls. A join still waits for the remaining work; it is not an instant hit.

Across those four workflows (800 requests per enabled arm):

| Metric | v0.18 | v0.19 |
| --- | ---: | ---: |
| Mean measured tool wait | 91.78 ms | 79.96 ms |
| p50 / p95 wait | 108.18 / 140.43 ms | 79.45 / 141.05 ms |
| Ready cache hits | 119 | 104 |
| In-flight joins | 429 | 566 |
| Useful rate | 68.50% | 83.75% |
| Misses | 252 | 130 |
| Speculative calls issued | 768 | 886 |
| Wasted calls, including outstanding at shutdown | 220 | 216 |
| Waste per useful call | 0.401 | 0.322 |
| Total upstream calls | 1,020 | 1,016 |
| Predictor recall@3 | 73.75% | 95.00% |
| Largest observed state file | 20,270 B | 20,554 B |

The pooled mean wait reduction is 12.87%, or 11.81 ms per requested call.
Ready hits decreased; the additional useful work was predominantly joined
in flight. PR-review waste increased from 40 to 56 calls, although its
waste/useful ratio remained below one. Tail latency did not improve.

#### Controls and uncertainty

The unpredictable control made 320 held-out requests per arm and issued zero
speculative calls in either version. Its mean wait was 139.94 ms for v0.18 and
128.58 ms for v0.19. The apparent improvement is timing noise, not learning:
the stable arm included a 2,472 ms outlier. Timing spikes affected multiple
arms, including off. Every full output digest matched across all 400 paired
sessions. No outliers were removed from the release-gate calculation.

Cold sessions produced 19 useful calls out of 140 requests in both versions,
with 21 wasted calls each. Mean cold wait changed from 113.29 to 117.29 ms.
The added learner history did not improve cold-start useful rate.

Held-out evaluation is online and chronological: each request is evaluated
before its result can teach that arm. Earlier held-out sessions can inform
later ones. IDs, optional calls, and ordering change; production learner
code contains no workflow names or domain examples. The fixtures remain
authored tests, not a sample of ordinary user traffic. The two passing
fixtures have related branch structures: they show transfer across changed
tools and arguments, with limited evidence of broader workflow diversity.

All five seeds improved the mean over the four repeated workflows. A
10,000-resample seed bootstrap gives an exploratory 95% interval of
11.17–12.32 ms saved per call. With five seeds, this is not a claim of
statistical significance or a prediction of whole-task speedup. Each passing
workflow exceeded 15% in three of five seeds; the renamed aggregate passed
by only 0.15 percentage points. The pooled interval does not establish a
confidence bound above either workflow's threshold. CPU/RSS measurements
cover only the driver.

#### Release gates and other checks

The fixed performance gate required at least two varied workflows to reduce
mean wait by at least 15% and improve useful rate by at least 10 percentage
points. Issue triage and renamed tools passed. Waste, negative-control
speculation, exact outputs, and offline recall-regression gates also passed.

The existing offline corpus improved recall@3 from 84.6259% to 85.9184%; its
adversarial floor stayed at 8.6667%. Waste/hit fell from 1.9984 to 1.8480.
Linux and macOS CI passed 868 tests with 7 skips; Windows passed 865 with
10 skips. Node 18 CLI compatibility was checked. The three-platform
[CI run](https://github.com/lukebward/speculate/actions/runs/34157066999)
tested the frozen runtime.

Supplemental results limit the claim. The existing 120 ms filesystem fixture
kept its 30/44 useful rate and changed mean wait from 50.58 to 51.06 ms.
Real local Git changed from 17.98 to 19.08 ms and 24/45 to 18/45 useful calls,
while the off arm itself became faster and admission issued fewer cheap
reads. Live Microsoft Learn produced 10/18 useful calls before and 9/18 after,
with eight terminal wasted calls each. Separate host/network conditions make
those runs unsuitable for isolating an upgrade speedup.

#### Reproduce and inspect

The baseline is commit `1371efef3758d6bdf679556867c0c4828a9d6657`.
The frozen candidate is `9d61a06d96ea5749c5382120948ca11854737409`;
later release changes are documentation only. Build both checkouts, then run
the candidate's driver:

```bash
npm run bench:repeated -- --baseline ../speculate-baseline --candidate . \
  --seeds 1,2,3,4,5 --train 8 --holdout 8 --latency 120 --json repeated.json
```

The [release artifacts](https://github.com/lukebward/speculate/releases/tag/v0.19.0)
include raw repeated results, summaries, and source/build hashes. Local path
fields in public copies are normalized; timing samples and output digests
are unchanged.
