# Turn tool transport — design, behaviour, smoke results (2026-10-09/10)

Branch `feat/new-input-output-format`, commits 19dca12d6 (transport) and 942bb055d (harness check).
The registered protocol's turn of statements now travels as the three string fields of one tool
call, `dataflow({ summary, python, statements })`, and a reply without a tool call is the final
answer. This report records why, what each model did on it, and the same 5-task × 4-arm smoke
the text transport was measured with (`results/20261009-text-transport/REPORT.md`).

## 1. Why

The raw text transport removed the JSON action list, but every failure it then needed a guard
for came from the loss of the forced tool call, not from the grammar: Luna opened 18 of 20
attempts with a refusal or an answer from memory, Opus wrote the engine's receipt itself, DeepSeek
wrapped turns in fences and wrote prose after statements, and the `answer:` command collided with
the harness's `**Final Answer:**` line (17 extra calls in one matrix). The review of the
2026-10-09 hardening commit (`6017778f9`) showed those guards being removed one by one on
reasoning alone, with measured regressions.

The turn tool keeps the statements and lets the tool call do the framing:

```json
{
  "summary": "Sum each group across all source rows and order the groups alphabetically.",
  "python": "",
  "statements": "set totals: aggregate(records, by=['group'], outputs={'total': sum('value')})\nset report: sort(totals, by=['group'])\nshow result report full"
}
```

- `python` holds definitions (no fence to parse), `statements` the `set`/`delete`/`execute`/`show`
  lines in order; line numbers in errors count the lines of `statements`.
- There is no answer statement. Tool choice is always `auto`, so a model's extended reasoning
  stays available; a reply without a tool call is the answer, verbatim, once a `show result` of the
  task has succeeded. Before that it is a lapse: the agent appends one correction naming the first
  call to make, with a path taken from the request, at most twice per task.
- The receipt is rendered by statement (`## edits applied`, `## show result …` with `upstream:`,
  shape, records, statistics) and returned as the tool result; the context assembler is the tool
  transport's, so the provider prefix cache and the wire audit work unchanged.

Code: `agent/tools/turn-tool.ts`, `parseTurnFields` in `agent/native/turn-syntax.ts`,
`renderDataflowActionsResult` dispatch in `agent/tools/dataflow-actions.ts`, `transport: "turn"`
on `VercelToolUseDriver`, `acceptTextAnswer` + `turnTransportLapseFeedback` in `texera-agent.ts`,
`{{#turn}}` prompt sections and `registeredExamples` for the turn form, `--driver turn-tool`.

## 2. Smoke: 5 tasks × 4 evidence settings, one run per model

Tasks legal-easy-27, archeology-easy-6, environment-hard-7, biomedical-easy-2, wildfire-easy-2;
agent :3088 on `19dca12d6`, harness pin 4d61e31 (the `**Final Answer: <value>**` instruction in
force), `MODEL_RETRIES_PER_TURN=2`, same parameters as the text-transport matrices. "Text" is the
raw text transport's final matrix (smoke3 for Opus/DeepSeek, smoke4 for Luna); "JSON tool" is the
simplified action tool on the same five tasks, stats+flow setting only.

| Model | Transport | Pass | $/task | Calls | Input/call (cached) | Output tok | Hidden reasoning | Wall | Rejected turns/task |
|---|---|---|---|---|---|---|---|---|---|
| Luna | **turn tool** | **15/20** | **$0.0022** | 4.3 | 5.6k (84%) | 869 | 254 | 30 s | 0.05 |
| Luna | text | 12/20 | $0.0023 | 5.5 | 4.8k (87%) | 833 | 336 | 31 s | 0.95 |
| Luna | JSON tool (stats+flow) | 3/5 | $0.0025 | 4.0 | 5.2k (77%) | 978 | 263 | 28 s | 0 |
| Opus 4.8 | **turn tool** | **18/20** | **$0.0795** | 4.3 | 8.5k (84%) | 1,149 | 0 | 33 s | 0 |
| Opus 4.8 | text | 19/20 | $0.0695 | 4.6 | 7.2k (84%) | 933 | 0 | 33 s | 0 |
| Opus 4.8 | JSON tool (stats+flow) | 5/5 | $0.0630 | 3.4 | 8.0k (83%) | 930 | 0 | 26 s | 0 |
| DeepSeek V4.1 Flash | **turn tool** | **17/20** | **$0.0121** | 8.5 | 9.9k (88%) | 7,149 | 5,071 | 150 s | 0 |
| DeepSeek V4.1 Flash | text | 14/20 | $0.0055 | 6.2 | 6.4k (81%) | 2,561 | 1,441 | 51 s | 0.30 |
| DeepSeek V4.1 Flash | JSON tool (stats+flow) | 4/5 | $0.0142 | 7.2 | 8.5k (84%) | 9,151 | 7,431 | 119 s | 0.40 |

Per setting (pass of 5), turn tool / text:

| Setting | Luna | Opus | DeepSeek |
|---|---|---|---|
| none | 4 / 3 | 5 / 5 | 4 / 4 |
| stats | 4 / 3 | 4 / 5 | 4 / 4 |
| flow | 4 / 3 | 5 / 4 | 5 / 3 |
| stats+flow | 3 / 3 | 4 / 5 | 4 / 3 |

Protocol counters on the turn tool, all three models, 60 attempts: 0 replies without a tool call
before a shown result (lapses), 0 corrections, 0 answers written as statements, 1 rejected turn
(Luna, an unavailable view), 0 timeouts, and all 60 final replies carried the requested
`**Final Answer:**` line. Every miss is the two known misreadings: 68.1 for 68.5 (the mean
includes the excluded case) and 0.11 for 10.87 (a fraction instead of percentage points).

## 3. What the models did

**Luna.** Calls the tool on its first reply in every attempt: the refusal-first behaviour that
cost the text transport one call per task and, after the hardening commit, four whole tasks, is
gone by construction. Final replies are the bare marker line (23 chars on average). 3 more passes
than on text at the same cost and 1.2 fewer calls per task.

**Opus 4.8.** No fabricated receipts (nothing to continue into after the tool call). Its two new
misses are the biomedical exclusion-flag ambiguity, which it also argues out loud in the final
reply ("Two candidate answers: … 68.1 … 68.5") before choosing the wrong one; the JSON tool and
one text arm had it right, the other text arm wrong — variance on a task every model gets wrong
somewhere. Cost is +14% over text: it authored fewer characters (3.3 calls × 525 + a 194-char reply
≈ 1.9k, vs 4.6 replies × 488 ≈ 2.2k) but paid more tokens, 1,149 vs 933, because Python and
statements inside JSON string arguments cost about 1.7 chars per token against 2.4 for plain text;
and the first-call prompt is larger (5.3–6.7k vs 4.4–4.8k tokens: the schema plus the longer flow
example).

**DeepSeek V4.1 Flash.** The best accuracy of the three transports (17/20) and no fence or prose
problems, but tool-calling mode makes it reason far more than raw text does: 5.1k hidden tokens
per task against 1.4k, 8.5 calls against 6.2, 150 s against 51 s. Cost is 2.2× the text transport
and 0.85× the JSON tool. This is a property of the model's tool-call path, not of the schema (the
schema is three strings).

## 4. Bumps on the way

- The harness attempt setup (`benchmark/retrieval/evaluate_task.py`) asserted the retrieval-view
  enum of the JSON action tool's schema and raised `KeyError: 'actions'` on the turn tool, so the
  first launch produced 60 attempts with no agent run. Fixed in 942bb055d: the turn tool's views
  are checked by the parser against the recorded settings, which the settings-drift check covers.
- The runner refuses to reuse a SUT name; a failed launch leaves empty SUT directories under
  `Kramabench/system_scratch` that have to be removed or the run renamed (smoke7 → smoke8).

## 5. Open items

- DeepSeek's reasoning inflation under tool calls. If its cost matters more than its accuracy,
  keep the raw text transport for it; the two share parser, receipts and prompt sections.
- Prompt size in the flow settings: 17.4k chars (none: 13.7k) against the text transport's
  12.6–13.5k; the renderer-backed flow-repair example is 2.7k of it. Trimming it to the filter's
  measured lines would bring the flow settings back on budget.
- The JSON escaping overhead on Opus is inherent to tool arguments; the only lever is shorter
  Python (the prompt already asks for no boilerplate).
- One run per model: the per-task flips above are within the variance measured earlier
  (Luna sd ≈ 3 pts/run on the full benchmark). The 104-task run is the comparison the branch
  still needs.

## 6. How to run

```bash
bin/bench.sh retrieval run \
    --output benchmark/retrieval/runs/<name> --endpoint http://localhost:3088 \
    --tasks legal-easy-27 archeology-easy-6 environment-hard-7 biomedical-easy-2 wildfire-easy-2 \
    --models Luna Opus48 DeepSeek41Flash \
    --arms evidence_data0_flow0 evidence_data1_flow0 evidence_data0_flow1 evidence_data1_flow1 \
    --driver turn-tool --repetitions 1 --workers 2 --full-result-char-limit 5000 --sample-char-limit 1000
```

Run directories (gitignored, dev2 worktree): `benchmark/retrieval/runs/20261009-turntool-smoke8-{luna,deepseek,opus48}`.
