# Text transport for the registered protocol — design, model behaviour, smoke results (2026-10-09)

Branch `feat/new-input-output-format` (from `feat/registered-simplify`). The agent's message is a
turn of statements instead of a JSON tool call. This report records why, what each model did
with it, what changed in response, and the end-to-end results on Luna, Opus 4.8 and DeepSeek
V4.1 Flash in all four evidence settings.

## 1. Why

The 2026-10-09 campaign and its analysis (`results/20261009-registered-python-campaign/`) put
the dataflow agent at 2.0–2.2× smolagents' cost on Opus at equal accuracy. After the prompt and
schema cuts on `feat/registered-simplify` (Opus 2.2× → 1.3×), what remained was the protocol
itself:

- Every call carried the tool schema (3.0k characters after the cut, 9.2k before).
- About 30% of each Opus reply was JSON framing: keys, quotes, brackets, `"type": "execute"`,
  repeated operator IDs. On Opus that was 13% of the bill.
- `inspect` returned text the context already held: 72–91% of `source` inspections showed only
  the file path from the task text, and 16–47% of `schema` inspections listed columns already
  on screen.
- The receipt repeated upstream evidence under every retrieved operator.

The review (Bob, 2026-10-09) asked for: no tool calls; a `summary:` line (the keyword avoids
clashing with statements that begin with `set`); keywords `set`, `delete`, `execute`, `show`,
`answer`; `show <resource> <id>` for result, schema, operator, function and builtin; no
`show sheets`; `answer:` as the stop, alone in its turn; the receipt grouped by statement with
the executed upstream operators under `upstream:`, then the result's shape, records and
statistics; the prompt's syntax and example sections rewritten, nothing else.

## 2. What was built

- `agent/native/turn-syntax.ts`: the parser. A turn becomes the JSON tool's action list: one
  edit holding every ```python fence and every `set`/`delete` line at its turn line number (so
  "Changes line N" names the turn's line), then the requests in order. `show result` is an
  execute of the target followed by a retrieve; `show schema` executes first too.
- `agent/llm-drivers/text-turn-driver.ts`: the loop without tools. Each turn is recorded as one
  synthesized `dataflow` call carrying the turn text, so execution, receipts, traces and the
  campaign audit are shared with the tool transport. Generation stops at any receipt header.
- `agent/util/context-utils-text-turn.ts`: the transcript as chat messages — the turn verbatim
  as the assistant message, its receipt as the next user message, never merged.
- `agent/native/turn-receipt.ts`: the receipt by statement.
- `prompts/native-registered.md`: `{{#text}}`/`{{^text}}` sections for syntax and examples;
  built-in contracts, Python rules and analysis principles unchanged.
- `benchmark/retrieval/run.py --driver text-turn`; the driver kind is recorded in the manifest.
- 1,545 agent tests; the runner's Python tests pass.

## 3. What the models did

Three live matrices (5 tasks × 4 evidence settings per model: legal-easy-27, archeology-easy-6,
environment-hard-7, biomedical-easy-2 with a workbook, wildfire-easy-2 with GeoPackages) and a
Luna rerun. Each matrix found behaviour the grammar had not allowed for.

**Opus 4.8**
- Copies the prompt's framing: it wraps its turn in the example's ````turn fence, with the
  ```python fence inside, after a sentence of prose. 23 rejected turns in matrix 1.
- Kept writing after its statements and produced the engine's reply itself: `user## edits
  applied … records: 4 of 153 rows …`, then reasoned from the invented rows and answered 70.0
  (truth 68.5). This is the one failure that corrupts an answer rather than wasting a call.
- Passed a file path to `show sheets`/`show schema` instead of an operator ID.
- Once these were handled: 0 rejected turns in 20 attempts, 4.6 calls per task.

**DeepSeek V4.1 Flash**
- Adds prose after its statements ("Let me first check whether scan supports gpkg…"), wraps
  the turn in a ```text fence after a sentence, leaves an empty ```python``` fence and a stray
  closing fence, or forgets to close a fence before its statements.
- Writes the final answer as a bare `**Final Answer: 68.1**` line after a summary, without
  `answer:`.
- Reasons far less on the text transport: 1.4k hidden reasoning tokens per task against 7.4k
  with the JSON tool, at the same number of calls. Cost per task fell from $0.014 to $0.0055.

**GPT-5.6 Luna**
- With nothing forcing a tool call, its first reply is often a refusal ("I'm sorry, but I can't
  access the data file in this environment") or an answer from memory ("**Final Answer: 10**",
  "Final Answer: Unable to determine"). 18 of 20 attempts in the final rerun still opened with
  a refusal, then proceeded after the rejection receipt.
- Sometimes returns no visible text at all (reasoning only).
- Otherwise writes clean turns; its two failing tasks are the ones every model misses.

## 4. What changed in response (commits on the branch)

| Behaviour | Change |
|---|---|
| Turn framed in a `turn`/`text`/unlabeled fence, with or without prose before it | The fence's lines are read as the turn; an unlabeled fence that reads as Python holds definitions |
| Prose after statements; stray closing fence; unclosed fence before statements; restated summary; fence before the summary | Prose after statements is noted and ignored; a stray closer is dropped; an open fence ends at the first statement; the last summary wins; summary may follow a fence |
| A receipt written by the model | `stopSequences` at the receipt headers; the parser cuts at a header and the receipt says so; the prompt says the receipt is the engine's message |
| Refusal or answer from memory on the first reply | The prompt says the engine reads files through `scan` and that plain text is not read; a prose reply is a rejected turn whose receipt shows a starter turn, so the repeated-failure guard, not a single correction, bounds retries |
| Empty reply | One silent retry; a second empty reply is a rejected turn |
| Bare `Final Answer:` line | Accepted as the answer once a result has been shown; rejected as a guess before that |
| Path given to `show schema` | Pointed error: `first set book: scan(files='<path>'), then show schema book` |
| `show schema` on an operator never executed | Executes it first, as `show result` does |
| Workbook sheet names | Listed in the scan's own receipt; no `show sheets` |

Infrastructure: adjacent same-role context messages are never merged (merging rewrote an
earlier message and broke the append-only prefix the cache and the audit rely on).

## 5. Results

Accuracy counts timeouts and unscored attempts as failures; cost is the campaign's frozen token
pricing. "JSON tool" is the simplified agent (`feat/registered-simplify`) on the same five tasks,
stats+flow setting, one run.

| Run | Pass | $/task | Calls | Input tokens (cached) | Output | Hidden reasoning | Wall | Rejected turns/task |
|---|---|---|---|---|---|---|---|---|
| Luna, text (final, 4 settings) | 12/20 | $0.0023 | 5.5 | 26.1k (87%) | 833 | 336 | 31 s | 0.95 |
| Luna, JSON tool | 3/5 per setting | $0.0025 | 4.0 | 21.0k (77%) | 978 | 263 | 28 s | 0 |
| Opus, text (final, 4 settings) | 19/20 | $0.070 | 4.6 | 33.0k (84%) | 933 | 0 | 33 s | 0 |
| Opus, JSON tool | 5/5 | $0.063 | 3.4 | 27.3k (83%) | 930 | 0 | 26 s | 0 |
| DeepSeek, text (final, 4 settings) | 14/20 | $0.0055 | 6.2 | 39.6k (81%) | 2,561 | 1,441 | 51 s | 0.30 |
| DeepSeek, JSON tool | 4/5 | $0.014 | 7.2 | 61.5k (84%) | 9,151 | 7,431 | 119 s | 0.40 |

Per evidence setting (final matrices; pass of 5):

| Setting | Luna | Opus | DeepSeek |
|---|---|---|---|
| none | 3 | 5 | 4 |
| stats | 3 | 5 | 4 |
| flow | 3 | 4 | 3 |
| stats+flow | 3 | 5 | 3 |

Every failure in the final matrices is one of two tasks that all models miss in both
transports: biomedical-easy-2 (68.1 for 68.5: the mean includes excluded cases) and
environment-hard-7 (0.11 for 10.87: a fraction instead of percentage points). No failure
is caused by the protocol.

How the matrices progressed, showing the effect of the parser work:

| Matrix | Parser state | Luna | Opus | DeepSeek | Rejected turns/task (Luna / Opus / DeepSeek) |
|---|---|---|---|---|---|
| 1 | strict grammar | 12/20, $0.0026 | 14/20, $0.143 | 14/20, $0.0074 | 1.75 / 4.90 / 3.20 |
| 2 | fences, prose, refusals handled | 14/20, $0.0025 | 18/20, $0.070 | 14/20, $0.0050 | 1.30 / 0.70 / 1.05 |
| 3 | final syntax; bare Final Answer accepted | 11/20, $0.0017 | 19/20, $0.070 | 14/20, $0.0055 | 0.60 / 0.00 / 0.30 |
| 4 (Luna only) | bare Final Answer only after a shown result | 12/20, $0.0023 | — | — | 0.95 / — / — |

Matrix 3's Luna drop was a regression of matrix 3's own change: accepting a bare
`Final Answer:` line let Luna end 5 tasks on its first reply with a guess. Matrix 4 has the
guard.

## 6. What this says

- The transport works on all three model families and all four evidence settings, at parity
  with the JSON tool on Luna and Opus, and at a third of the cost on DeepSeek because it reasons
  less per call.
- The savings the campaign analysis predicted for Opus (about 13% from framing) do not show at
  this sample size: Opus's text turns are as long as its JSON calls were (933 vs 930 output
  tokens per task), and it makes one more call per task. Twenty tasks cannot separate a few
  percent either way; the 104-task run would.
- The protocol's real risk is not syntax but the loss of the forced tool call: a model may
  answer from memory, refuse, or write the engine's reply itself. Each has a guard now; the
  stop sequence at the receipt headers is the one that protects answers.

## 7. Open items

- Luna opens most tasks with a refusal and needs the rejection receipt to proceed: one wasted
  call per task (about $0.0003). A first-turn example in the task-independent part of the
  prompt, or an assistant prefill where the provider allows it, may remove it.
- The receipts still carry the flow evidence's long lines (five lines for one filter); the
  report of the campaign lists the trims.
- Lambda predicates for `filter` and a measured `derive` (agreed in the design review) are not
  on this branch.

## 8. How to run

The smoke matrices ran against an agent-service of this branch on the `texera-registered-python`
stack (`/var/tmp/texera-registered-python/profile.sh`) with `MODEL_RETRIES_PER_TURN=2`; the
JSON-tool reference rows ran the same way, so the two transports are comparable with each other
but not with the campaign's cost table, which ran with 0 retries.

```bash
# agent-service of this branch, text transport chosen per run by the runner
bin/bench.sh retrieval run \
    --output benchmark/retrieval/runs/<name> --endpoint http://localhost:3088 \
    --tasks legal-easy-27 archeology-easy-6 environment-hard-7 biomedical-easy-2 wildfire-easy-2 \
    --models Luna Opus48 DeepSeek41Flash \
    --arms evidence_data0_flow0 evidence_data0_flow1 evidence_data1_flow0 evidence_data1_flow1 \
    --driver text-turn --repetitions 1 --workers 2 --full-result-char-limit 5000
```

Run directories (gitignored, on the branch's worktree under `benchmark/retrieval/runs/`):
matrix 1 `20261009-textturn-smoke-{luna4,opus48,deepseek}` (`smoke-luna`, `-luna2`, `-luna3`
are aborted partial starts of the same matrix), matrix 2 `20261009-textturn-smoke2-{luna,opus48,deepseek}`,
matrix 3 `20261009-textturn-smoke3-{luna,opus48,deepseek}`, matrix 4 `20261009-textturn-smoke4-luna`.
