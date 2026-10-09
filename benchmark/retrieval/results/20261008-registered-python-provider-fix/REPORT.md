# Corrected provider validation — 2026-10-08

**All six corrected attempts passed with official score 1.0.** Each of the same
three KramaBench tasks was rerun once on Qwen3.8-27B and DeepSeekV4.1-Flash after
the anchored nonblank-pattern fix. The [original 18 attempts](../20261008-registered-python-pilot/REPORT.md)
remain separate: Qwen was 0/3 and DeepSeek 2/3 before the fix. The other four
models already passed 3/3 each and were not rerun.

| Model | Archeology | Legal | Biomedical | Calls | Failed calls / actions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen3.8-27B | 1 | 1 | 1 | 28 | 2 / 4 |
| DeepSeekV4.1-Flash | 1 | 1 | 1 | 15 | 2 / 4 |

All Qwen calls used **Wafer**. DeepSeek used Together for archeology, Makora for
legal, and **Wafer for biomedical**. Success on the previously affected Wafer
route corroborates the direct paired regex experiment; it was not merely a
switch to an unaffected serving provider. No single-character degeneration or
whole-call schema rejection occurred in the corrected attempts.

The remaining errors were repaired through normal iteration:

- DeepSeek archeology retrieved an operator before execution, then executed it.
- DeepSeek legal initially parsed a footer as numeric data. The engine reported
  the custom function line, and the model revised the function and succeeded.
- Qwen legal revised the same function twice: first for a column name containing
  a trailing space (`KeyError`), then for footer/null numeric conversion
  (`ValueError`). It retrieved the complete 1×1 result, 13.1628, before answering
  after 12 calls; its other tasks had no errors.

Both models returned a successful final answer for every task. There were no
timeouts, no unscored attempts, and no retries beyond these six separately
approved validation attempts. Scores use the unchanged official response
evaluator; individual metrics and answers are preserved in [attempts.json](attempts.json).
This selected three-task pilot does not establish general model accuracy.
Qwen's biomedical answer was numerically correct and supported by the retrieved
join/result, but omitted the task's requested `Final Answer` wrapper. The official
score still gave full credit; correctness and exact presentation are distinct.

## Accounting and latency

All 43 model requests have captured usage, and all six attempts have complete
provider costs. Reconciliation found **zero token-counter mismatches** against
the preserved harness statistics. Cached tokens are a subset of input;
reasoning is a subset of output, not an additional charge.

| Model | Input | Cached input | Output | Reasoning | Public-rate estimate USD | Provider-reported USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen3.8-27B | 323,854 | 270,784 | 5,845 | 2,521 | 0.060476 | 0.023575 |
| DeepSeekV4.1-Flash | 151,254 | 117,760 | 3,595 | 936 | 0.015069 | 0.010152 |

The six attempts total **$0.075545 estimated at frozen public rates**, versus
**$0.033727 reported by the provider**. These separate measures are not mixed.
No cache writes were reported. Scorer, engine, and infrastructure costs are
excluded; missing costs would remain null. Exact billed system-prompt versus
tool-schema token splits are not exposed by these APIs.

| Model | Mean gateway seconds | Mean agent seconds | Mean attempt seconds |
| --- | ---: | ---: | ---: |
| Qwen3.8-27B | 42.20 | 52.60 | 55.37 |
| DeepSeekV4.1-Flash | 11.79 | 21.22 | 24.27 |

Gateway seconds sum captured request durations. Agent time includes model and
tool execution but excludes scoring; attempt time also includes setup, scoring,
and artifact collection. These overlapping measures must not be added.

## Integrity and resources

Audits found **zero invariant violations**: 37 context-prefix checks, 24 retained
profiles, and 1,193 profiled columns. There were 19 successful retrieved targets,
including batched reads. Audits cover captured context and retained results;
they do not prove every possible execution path. Both worker computing units
were terminated after the campaign.

The run used at most two concurrent attempts. Eleven [resource samples](host-resources.jsonl)
were recorded at 15-second intervals on the 16-logical-CPU, 51.5-GB host:

- Available RAM never fell below 13.07 GB in the samples; swap remained zero.
- Free disk stayed at or above 437.99 GB.
- Maximum observed one-minute load was 4.32.
- macOS memory-pressure output reported at least 50% memory free.

These are sampled ranges, not continuous peak measurements. See the
[machine-readable summary](resources-summary.json). Frontend startup was skipped;
an existing frontend remained running. The final launcher status showed 13/13
listed services running. This validates the agent/gateway/engine execution path,
not the browser UI.

## Reproduction and preserved evidence

The [manifest](manifest.json), [source inventory](source-snapshot.json),
[exact prompt/tools](system-info.json), and [settings](settings.json) identify
the corrected run. Its source SHA256 is
`7e245426798cca19cff5839da0410ff092ef8ac3870d10d2dfb628ec60ca0992`.
The captured schema contains `^[\s\S]*\S[\s\S]*$`. The rerun also includes
namespace metadata hardening and cast diagnostic fixes; the paired provider
probe isolates the regex mechanism more narrowly than this integration rerun.

Use the isolated supported-launcher setup in the [primary report](../20261008-registered-python-pilot/REPORT.md#reproduction),
then run the following with a fresh output path. The executed campaign used
explicit user approval for these exact OpenRouter prompts/data/context.

```bash
bin/bench.sh retrieval run \
  --output benchmark/retrieval/runs/20261008-registered-python-provider-fix \
  --endpoint http://localhost:3001 \
  --engine-revision e031c69df-rebuilt-20261008 \
  --repetitions 1 --workers 2 --timeout 900 --direct-artifacts \
  --wire-dir /tmp/registered-python-wire \
  --tasks archeology-easy-6 legal-easy-3 biomedical-hard-3 \
  --models Qwen38_27B DeepSeek41Flash \
  --arms adaptive_flow1_fullstats
```

The runner refuses to overwrite a campaign. Raw traces, snapshots, per-attempt
settings, and wire bodies remain under the ignored output directory above.
Bodies contain benchmark prompts/data; credentials and HTTP headers are omitted.
The tracked bundle retains aggregate/per-task metrics and final answers without
copying all raw traces. `bin/bench.sh retrieval reconcile`, `analyze`, and `audit`
regenerate accounting and audits offline without model or evaluator requests.
