# Live benchmark results

One folder per day of runs, written by `npm run bench:live -- --json`. Each
file holds the run's conditions (`meta`), every session with every call
(`sessions`), and the summaries computed from them. The reading of these
numbers, with their limits, is in
[`docs/design/local-learning-benchmark.md`](../../docs/design/local-learning-benchmark.md).

```bash
npm run bench:live -- --summarize bench/results/2026-11-21/mslearn-haiku.json bench/results/2026-11-21/huggingface-haiku.json
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
