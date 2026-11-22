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

The mod at `9f46b24`, after the prediction changes of that day. Loaded from a
copy of the commit (`--mod`).

| File | What it is |
| --- | --- |
| `mockgithub-haiku.json` | The bundled mock GitHub server with 1.5 s added to every call: three workloads, 6 pairs each |
| `mslearn-haiku.json`, `huggingface-haiku.json` | The reported run on the hosted servers: three workloads, 8 pairs each |
| `huggingface-haiku-second.json` | The Hub once more, the same hour: its slow answers move a mean, so it was run twice |
| `mockgithub-haiku-before.json` | The mock server against the mod at `3c9b4a9`, earlier that day, before the changes to prediction. Its varied workload asked about three issues and then three pull requests; the later run alternates them |
| `huggingface-haiku-cold.json` | `--cold` at `3c9b4a9`: the mod's store cleared before every session, to measure what its hooks cost a call |

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
