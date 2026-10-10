# One protocol (2026-10-10)

What `stable` contains after the cleanup, and the five-task check that verifies it.
Branch `feat/new-input-output-format`, commits `59c9b5431` (cleanup) and `6ef445795`
(KramaBench pin `608e9fe`). Agent :3088, `MODEL_RETRIES_PER_TURN=2`, tasks legal-easy-27,
archeology-easy-6, environment-hard-7, biomedical-easy-2, wildfire-easy-2, data and flow
evidence (`evidence_data1_flow1`), one repetition.

## 1. What changed

- **One protocol.** Native mode has one tool, `dataflow(python, statements)`. The JSON
  action tool, the text transport, forced tool choice and the summary field are gone. Tool
  choice is always `auto`, and a reply without the tool is the final answer once a
  `show result` has succeeded. The prompt and its worked examples describe only this tool.
- **Removed with them:** the legacy expression-mode tool and prompt, the answer action,
  multi-task state (task history, state history, state ledger), the recall, resume and
  compaction tools, versioned operators, seeded sources and seed-state loading, answer
  grounding, and the dead rejected-edit and validation-repair paths. Twenty-three settings
  are refused with a reason.
- **LongDS removed:** `benchmark/longds`, the TypeScript multi-turn runners, the `bench.sh`
  commands and the README, AGENTS, env and gitignore entries.
- **Receipt fixes found while porting the tests.** `show operator` printed only "No retained
  metadata."; it now renders the operator's block. A failed execution no longer says its
  results were current. A scan's workbook sheet names and preview budget now reach the model,
  as the prompt promises. Hints use statements (`show schema x from N`, `## call rejected`).
- **Harness.** `run.py` has no `--driver`, and the audits count the final reply as the answer.
  KramaBench sent the removed `seedSources` setting on every agent creation; `608e9fe` sends it
  only when an arm enables it.

## 2. Tests

| Check | Result |
|---|---|
| `bun test` (agent-service) | 1,171 pass, 0 fail, 100 files |
| `bunx tsc --noEmit` | 0 errors |
| `pytest benchmark/retrieval benchmark/runtime` | 182 pass, 1 skipped |
| `pytest bin/test_strict_tools.py` | 5 pass |
| `bun run e2e`, `bun run e2e:errors` (isolated stack) | pass; 4 of 4 |
| `render:native-reference --check` | up to date |

Three runtime tests that imported `benchmark.dsbench` were removed: that package is not in
this branch, so they could never pass here. The strict-tools test now accepts both LiteLLM
return shapes of `_map_tools`.

## 3. Five tasks, data and flow evidence

| Model | Pass | $/task | Calls/task | Output tok/task | Turn tool `f9fb9e548`, same setting |
|---|---|---|---|---|---|
| Luna | 3/5 | $0.0022 | 4.4 | 744 | 4/5, $0.0025 |
| Opus 4.8 | 5/5 | $0.0877 | 4.6 | 1,118 | 5/5, $0.0921 |
| DeepSeek V4.1 Flash | 4/5 | $0.0086 | 7.2 | 5,032 | 4/5, $0.0084 |

Across the 15 attempts there were no rejected calls, no replies before a result, no missing
answers, no timeouts, no crashes, and no audit violations or warnings. Every final answer
carried the requested `**Final Answer:**` line.

The misses are the known misreadings: 68.1 instead of 68.5 on biomedical-easy-2 (Luna and
DeepSeek include the excluded case) and 0.11 instead of 10.87 on environment-hard-7 (Luna
reports the fraction, not the percentage). With one repetition, 12 of 15 against 13 of 15 is
one attempt each way: Luna lost environment-hard-7 and DeepSeek gained it.

The context replays each step as planned: the model's own text, the one `dataflow` call with
both fields, then the receipt as the tool message. Opus wrote text beside 16 of its 18 calls,
DeepSeek beside 8 of 31, Luna beside none. The data-and-flow system prompt is 17,108
characters on the wire (17,386 before: the summary lines left, one prose line came in).

Run directories (gitignored, dev2 worktree): `benchmark/retrieval/runs/20261010-oneprotocol-{luna,opus48,deepseek}`.
