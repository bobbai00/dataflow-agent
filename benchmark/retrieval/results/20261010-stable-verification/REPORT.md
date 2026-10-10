# Stable verification (2026-10-10)

What `stable` contains after this branch is merged, and the 20-attempt matrices that verify it:
5 tasks × 4 evidence settings, per transport and model. Branch `feat/new-input-output-format`,
KramaBench `1619be6`, agent :3088, `MODEL_RETRIES_PER_TURN=2`, tasks legal-easy-27,
archeology-easy-6, environment-hard-7, biomedical-easy-2, wildfire-easy-2.

## 1. Changes verified

**f9fb9e548** — the fixes listed in the review of the 2026-10-09 hardening commit (`6017778f9`):

1. The campaign audit counts a turn-transport final reply as the answer; an earlier tool-less reply
   is still a lapse.
2. Text transport: generation stops at receipt headings again; a reply that is not a turn is
   answered with a starter turn naming the request's first file; a bare `Final Answer:` line is
   the answer once a result has been shown and a guess before; the prompt no longer invites
   answering with a limitation.
3. Fractions display with 15 significant digits again.
4. The answer-rule sentence stays transport-specific.
5. Every transport renders the same examples: the reading example, the flow repair when flow
   evidence is on, and the answer rule (the two-table repair example is gone).

**c01e6fe7e** — text turns as DeepSeek writes them: the examples' "Engine receipt:" label starts
a fabricated receipt like a receipt heading does; a turn fence still open at the end of the
message closes there; summary, definitions and statements in separate fences are read in place;
Python written without its own fence holds definitions.

## 2. Results

Text transport rows are from c01e6fe7e (the parser commit changes only text-turn parsing); JSON
tool and turn tool rows are from f9fb9e548.

| Transport | Model | Pass | $/task | Calls | Output tok | Rejected turns/task | No answer |
|---|---|---|---|---|---|---|---|
| JSON tool (default) | Luna | 15/20 | $0.0035 | 4.8 | 1,604 | 0.15 | 0 |
| JSON tool (default) | Opus 4.8 | 16/20 | $0.0843 | 4.2 | 1,146 | 0 | 0 |
| JSON tool (default) | DeepSeek V4.1 Flash | 15/20 | $0.0110 | 7.0 | 6,674 | 0.55 | 1 |
| text | Luna | 13/20 | $0.0025 | 6.2 | 961 | 1.50 | 0 |
| text | Opus 4.8 | 19/20 | $0.0665 | 4.3 | 841 | 0 | 0 |
| text | DeepSeek V4.1 Flash | 15/20 | $0.0048 | 6.0 | 2,655 | 0.20 | 0 |
| turn tool | Luna | 16/20 | $0.0023 | 4.2 | 899 | 0 | 0 |
| turn tool | Opus 4.8 | 19/20 | $0.0846 | 4.5 | 1,263 | 0 | 0 |
| turn tool | DeepSeek V4.1 Flash | 15/20 | $0.0085 | 7.2 | 4,758 | 0 | 0 |

Per evidence setting, all three models together (pass of 15):

| Transport | none | data | flow | data+flow |
|---|---|---|---|---|
| JSON tool | 11 | 13 | 11 | 11 |
| text | 11 | 11 | 12 | 13 |
| turn tool | 12 | 13 | 12 | 13 |

Across all 240 attempts: 0 audit violations, 0 timeouts, 0 harness crashes. Every final answer
carried the requested `**Final Answer:**` line. Apart from the four Opus attempts noted below, the
misses are the two known misreadings: 68.1 for 68.5 on biomedical-easy-2 and 0.11 for 10.87 on
environment-hard-7.

## 3. What each fix did, measured

| Fix | Before | After |
|---|---|---|
| Turn-transport audit | 120 false warnings in 60 attempts (smoke8) | 0 |
| Text stop sequences | Opus 1,715 output tok/task, $0.0919 (6017778f9) | 841, $0.0665 |
| Starter turn | Luna 4 of 20 attempts ended in a refusal loop (6017778f9) | 1 of 20 (f9fb9e548), 0 of 20 (c01e6fe7e) |
| Bare `Final Answer:` after a result | rejected, one extra call each (17 in smoke6) | accepted; still rejected before a result (2–4 per Luna run) |
| Number display | `0.042488619119878605` | `0.0424886191198786` |
| One example set | default JSON prompt 16.1k chars; data+flow 19.9k | 13.1k; 16.8k |
| DeepSeek text parsing | 0.80 rejected turns/task (f9fb9e548) | 0.20 |

## 4. Still open

- **JSON tool cost against the measured simplified prompt.** On the data+flow setting (the only
  one the simplified prompt was measured on), Opus costs $0.0864 per task against $0.0630 (+37%),
  with 41k input tokens per task against 27k. Luna: $0.0028 against $0.0025. The prompt is still
  16.8k characters against 10.7k (the reading example shows two calls with full receipts, plus the
  flow repair example), and the docstring guidance adds 1.8 docstrings per task on Opus and 2.4 on
  Luna. The levers are the flow example and the docstring sentence; neither change is measured.
- **Opus on biomedical-easy-2.** Before `6017778f9`, Opus excluded the flagged case in 5 of 5
  attempts (68.5). After it, it included the case in 10 of 24 (68.1): 1/4, 2/4, 4/4, 2/4, 0/4 and
  1/4 across the six runs. In most of those attempts it read `Case_excluded` and decided to keep
  the row. A candidate cause is the reading example's last line, "A sample does not define the
  population; aggregate the whole source", which can read as "do not filter". This needs an A/B
  on the sentence before it is changed.
- **Luna on the text transport** still opens 8 of 20 attempts with a refusal and returns 10 empty
  replies in 20 attempts (1.5 rejected turns per task). The turn tool has none of this.
- **DeepSeek on the JSON tool**: one attempt ended without an answer after two empty replies that
  each followed about 6.9k hidden reasoning tokens.

Run directories (gitignored, dev2 worktree): `benchmark/retrieval/runs/20261010-final-{tool,text,turn}-{luna,opus48,deepseek}`
and `20261010-final2-text-{luna,opus48,deepseek}`.
