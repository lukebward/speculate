# Live benchmark results

One folder per day of runs, written by `npm run bench:live -- --json`. Each
file holds the run's conditions (`meta`), every session with every call
(`sessions`), and the summaries computed from them. The reading of these
numbers, with their limits, is in
[`docs/design/local-learning-benchmark.md`](../../docs/design/local-learning-benchmark.md).

```bash
npm run bench:live -- --summarize bench/results/2026-11-21/mslearn-haiku.json bench/results/2026-11-21/huggingface-haiku.json
```

## 2026-11-22

After the prediction changes of that day, and then after the change of hooks.
The mod is loaded from a copy of a commit (`--mod`); `meta.mod` names it.

| File | What it is |
| --- | --- |
| `tool-run-hooks/` | The last runs of the day: the mod at `7754dc5`, which answers at `tool.run` and names the MCP tools its hook is for. Run with `--host-tools`, so Claude Code's Artifact tool is in both arms. `mockgithub-haiku.json` (6 pairs a workload), `mslearn-haiku.json` and `huggingface-haiku.json` (8 pairs) |
| `mockgithub-haiku.json` | The reported run on the bundled mock GitHub server with 1.5 s added to every call: three workloads, 6 pairs each, the mod at `feceba2` |
| `mslearn-haiku.json`, `huggingface-haiku.json` | The reported run on the hosted servers: three workloads, 8 pairs each, the mod at `9f46b24` |
| `mockgithub-haiku-9f46b24.json` | The mock server with the mod one commit earlier, before a session's opening reads were started in order |
| `huggingface-haiku-cold.json` | `--cold` at `3c9b4a9`: the mod's store cleared before every session, to measure what its hooks cost a call |
| `with-artifact-tool/` | The day's first runs, before the runner kept Claude Code's Artifact tool out of both arms. With it the host sends the `on` arm a different request, and in those hours each model request took about 170 ms longer there, so session times in these files compare more than the mod. Hit rates and tool waits stand. `mockgithub-haiku-3c9b4a9.json` is the mock server against the mod before the changes to prediction; its varied workload asked about three issues and then three pull requests, where later runs alternate them |

`mockgithub-haiku.json` was written by the runner that records the model's
time to first token. In the other files of this day, the cold run apart, that
figure was added to each session afterwards from the event streams the run
kept; nothing else in them was changed.

```bash
npm run bench:live -- --summarize bench/results/2026-11-22/tool-run-hooks/mockgithub-haiku.json bench/results/2026-11-22/tool-run-hooks/mslearn-haiku.json bench/results/2026-11-22/tool-run-hooks/huggingface-haiku.json
```

```bash
npm run bench:live -- --summarize bench/results/2026-11-22/mockgithub-haiku.json bench/results/2026-11-22/mslearn-haiku.json bench/results/2026-11-22/huggingface-haiku.json
```

## 2026-11-21

| File | What it is |
| --- | --- |
| `mslearn-haiku.json`, `huggingface-haiku.json` | The reported run: three workloads, 8 pairs each, `claude-haiku-5-5` |
| `mslearn-sonnet-scripted.json` | The scripted workload on Microsoft Learn with `claude-sonnet-5-5`; stopped after that workload to limit cost |
| `huggingface-haiku-cold.json` | `--cold`: the mod's store cleared before every session, to measure what its hooks cost a call |
| `proxy-0.25.0/` | `--proxy`: the last proxy release from npm in the `on` arm in place of the mod, three workloads, 8 pairs each |
| `same-time/` | The scripted Microsoft Learn workload once more, the mod and the 0.25.0 proxy run at the same time, with the predictor's recall recorded |
| `first-run/` | The same benchmark run earlier that day, before the runner's first commit. Summaries recomputed by the committed rules; `meta.note` says what differed |
