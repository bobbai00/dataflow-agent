# Luna: five full Lite sessions against smolagents

Completed on 2026-10-08 UTC. Both arms returned final-answer payloads for all 185 requests and all 370 payloads have valid DeepSeek judgments. Dataflow scored **48/185 (25.9%)**, versus **76/185 (41.1%)** for stock smolagents. Estimated solver cost was **$1.2699 versus $1.2161**, respectively: Dataflow cost 4.4% more. This run does not show an overall accuracy or cost advantage for Dataflow.

## Results

| Lite session | Questions | Dataflow correct | Smolagents correct | Dataflow cost | Smolagents cost |
|---|---:|---:|---:|---:|---:|
| Kiva task1 | 37 | 3 | 14 | $0.2645 | $0.1404 |
| Netflix task2 | 34 | 2 | 9 | $0.2206 | $0.1270 |
| NFL task1 | 42 | 18 | 23 | $0.3257 | $0.3725 |
| Marmara task1 | 36 | 12 | 13 | $0.2329 | $0.4312 |
| WiDS task3 | 36 | 13 | 17 | $0.2262 | $0.1450 |
| **Total** | **185** | **48** | **76** | **$1.2699** | **$1.2161** |

Both were correct on 37 questions; Dataflow alone on 11; smolagents alone on 39; both wrong on 98. Dataflow was cheaper in two sessions, but less accurate in all five. Costs retain every recorded solver call, including unsuccessful calculation attempts. On the 37 questions both answered correctly, Dataflow cost $0.22783 and smolagents $0.20341; this conditional subset does not replace the full comparison.

The upstream state labels overlap, so these denominators do not sum to 185. They classify requests, rather than verify intermediate state:

| Request label | Questions | Dataflow correct | Smolagents correct |
|---|---:|---:|---:|
| Initial | 80 | 16 | 27 |
| Update | 59 | 16 | 23 |
| Rollback | 58 | 17 | 26 |
| Counterfactual | 47 | 11 | 22 |

## Cost and execution

| Metric | Dataflow | Smolagents |
|---|---:|---:|
| Model calls | 820 | 300 |
| Calls per question | 4.43 | 1.62 |
| Input tokens | 25,393,555 | 26,044,844 |
| Cached input fraction | 94.29% | 97.02% |
| Output tokens, including reasoning | 417,678 | 463,058 |
| Uncached input cost | $0.28981 | $0.15506 |
| Cached input cost | $0.47889 | $0.50539 |
| Output cost | $0.50121 | $0.55567 |
| Sum of question solver time | 6,705 s | 4,204 s |

Dataflow uses about 31k input tokens per call, versus 87k for stock, but makes 2.73 times as many calls. Its smaller individual contexts therefore save only 2.5% of total input tokens. More uncached input adds $0.13475; cached-input and output savings offset $0.08096, leaving $0.05380 extra cost. Both caching mechanisms are working; a thin context alone does not ensure lower spending. The trace audit identifies additional definition/result reads, staged authoring and repaired interface errors among the sources of extra calls. This is observed accounting, not a causal ablation of the prompt or catalog.

The timing figures sum actual question solver durations and are not campaign wall time: sessions overlap. Dataflow's observer capture, stack setup and no-model fixtures are excluded from solver duration/cost. Neither arm has a visible provider/API failure, missing usage, incomplete turn or exhausted step limit. Dataflow has execution errors in 37 questions; stock in 22. These are runtime diagnostics, not counts of semantic cascading failures.

Combined solver cost is $2.48603112. The judge incurred $2.68296258917 across 372 unique provider responses, including two format retries for 370 judgments. Copied cache/verdict artifacts are deduplicated. There are no unresolved judgments or unknown judge costs. These are recorded provider/token estimates, not an invoice reconciliation.

## Protocol

One fresh attempt on Kiva task1 (37), Netflix task2 (34), NFL task1 (42), Marmara task1 (36), and WiDS task3 (36): 185 questions per arm. All are LongDS v1.1 Lite sessions. Solver source revision: `438617687`; upstream DataMind: `4b49ef052500c73b07b5a4955e1115da6cd9da16`.

Both arms receive the exact same prepared requests, run `gpt-5.6-luna` through the same gateway, and allow 40 steps per question. Stock smolagents may use its final fallback call after exhausting steps. There is no added input token cap or context compaction. Each session has one fresh attempt, with no solver reruns or score-selected replay. In-loop error recovery is allowed and included in solver cost.

Dataflow uses native mode, saved result history, append-only prior-task operator catalogs, dependency context, full prompt/reference, and no state ledger or thought replay. Catalog statistics and records are off; sample statistics remain available on requested reads. Full result reads retain their recorded 5,000-character display budget. Stock smolagents 1.23.0 uses its unmodified system prompt, full conversation, a persistent interpreter and its 50,000-character print bound. These are the actual framework configurations, not a claim of identical internal observation layout.

A new isolated backend/agent stack has its own database, Iceberg catalog, result warehouse, workflow resources, service ports and sandbox. The underlying LLM gateway is shared. Sandbox workers see raw data and scratch only; gold, references, repository secrets and reports are inaccessible. Four no-model live tests passed before launching Dataflow. Initial stack startup/fixture attempts and observer capture are harness work; solver costs exclude them.

Each solver has a $5 dispatch guard. Costs use the frozen gateway rates, with cache discounts, and are estimates rather than invoices. Judge costs are reported separately. Both arms use the same upstream binary rubric and `deepseek/deepseek-v4-pro` through OpenRouter. Fixed denominators include unanswered/unattempted questions; unknown usage and unknown judgments remain explicit. A persisted, nonempty answer is not necessarily a substantive attempt: explicit abstentions are audited separately.

All 439 frozen source files, source-archive contents, 19 raw inputs, prepared requests and per-call usage were checked. Every verdict matches the cache key of its actual answer, reference and shared rubric. The baseline protocol does not separately pin the rubric SHA; the common frozen rubric and exact per-answer cache checks verify what was used. The solver tree stayed unchanged throughout generation. Four no-model live fixtures passed before generation; 24 offline accounting/recovery/verification tests passed. All five native session resources were removed and the isolated stack was stopped. Other stacks and the shared gateway remain running.

This is one run of five selected sessions, not a random sample or a repeated comparison across the entire Lite split. Stock's full history and AST interpreter differ from Dataflow's dependency catalog and engine. This compares these actual frameworks; it does not isolate automatic version retention.

## Nonresponse sensitivity

All 185 dispatched questions stay in the main denominator. A manual audit found five substantive stock nonresponses (2.70%): two immediate abstentions, two abandoned calculations and one unrelated substitute. No equivalent whole-answer nonresponse was found in Dataflow's 185 answers. Computed empty sets remain attempts, even when caused by wrong upstream calculations.

For cost sensitivity, the same question IDs are removed from both arms:

| Paired scope | Questions | Dataflow cost | Smolagents cost | Dataflow premium |
|---|---:|---:|---:|---:|
| All dispatched questions | 185 | $1.26991 | $1.21612 | 4.42% |
| Exclude two immediate abstentions | 183 | $1.25387 | $1.20614 | 3.96% |
| Exclude four explicit abstentions | 181 | $1.24162 | $1.14258 | 8.67% |
| Exclude all five substantive nonresponses | 180 | $1.23346 | $1.13801 | 8.39% |

The cost conclusion holds under each exclusion. Dataflow gets Marmara Q33 and Kiva Q9 right among the excluded questions, so removing these rows also removes valid Dataflow successes. The main scores remain 48/185 and 76/185. This sensitivity conditions on observed answers; it does not reconstruct a hypothetical session without those errors, and earlier errors may still affect later recorded costs.

## State usage and its limits

Accepted Dataflow receipts contain 37 saved-result input references across 15 branch tables, seven historical-result reads, 32 historical-definition reads, four updates to earlier-task tables, and one literal-setting change on an earlier-task table. Execution receipts contain 3,729 cached and 726 executed operator visits. Visits can repeat the same operator; these are not unique computations saved. There are 58 shared-function reuse calls. No saved definition-copy/restore operation or historical answer-source operation was used.

These counts demonstrate use of saved-state and caching mechanisms, not correct analytical reuse. Ordinary Python also retains many named historical tables and columns. The trace controls below show that both sides can have the relevant state available and still select the wrong population, stage or formula. Inspection by itself does not establish which state contributed to the answer.

## Trace audit

These findings are controlled offline checks of agent-authored code; none repairs or changes the frozen live run.

- Netflix Dataflow Q1 applies its analysis to rows outside 2015–2019. Adding only the missing window filter makes all 40 checked answer fields match the reference. The stock control already filters the correct window. Later top-five/top-eight and genre-focus errors occur on both sides and are not all explained by Q1.
- WiDS Dataflow Q3 chooses 19 clinical fields instead of the specified 7 and fails to reverse two protective provider rates. Fixing only those selectors/signs reproduces all five reference leaders and scores. Q4 reuses the bad table: a confirmed semantic cascade.
- WiDS Dataflow Q8 inspects the correct expanded-profile definition but compares the alternative against earlier basic-profile ranks carried in its cohort table. Its answer DAG contains the alternative and omits the requested expanded-profile baseline. This is wrong-stage selection with state available.
- NFL Dataflow Q10 reverses a percentile direction on a complete 86-row input. One direction correction reproduces all ten reference identities and values. Q11 remains correct, so the Q10 error does not immediately cascade into it. Both agents use raw `x` instead of the supplied orientation-corrected `x_o` at Q18 and carry the wrong play scores into Q19.
- Kiva Dataflow Q2 mixes fractions and percentages in a penalty. At Q9 it returns only 14 partner rows for selected report countries. Removing only this final restriction produces 183 specialist partners, 21 supported pairs and 17 poverty rows, matching the later reference population anchors. Later questions reuse the narrow table: a confirmed table-scope cascade.
- Stock Kiva Q13 selects a broader strict view even though the supported-pair table exists. Q14 reuses it: a confirmed script cascade. The stock control also retains many named historical tables and columns, answering long-span requests from them.
- Marmara Dataflow Q5 inspects Q4's core-event table, then selects events again from the broader population. Its answer DAG omits that core table. This violates the request even conditional on its own Q4 answer; stock preserves the Q4 identifiers at this step.
- Stock Marmara has bearing-bin, depth-tie and cleaning-baseline differences that carry into later comparisons. Some task wording permits alternative conventions; distinguish these from unambiguous mistakes while retaining the official score. At Q31 it clearly omits the requested W-sector restriction during raw-data reconstruction; successful recomputation does not imply the correct population.
- Four stock Marmara answers explicitly abstain (Q20, Q26, Q32, Q33); Kiva Q9 substitutes file headers for the requested calculation. Q20/Q26 attempt calculations before abandoning them. Their failing dictionary-unpacking statements expose an AST-interpreter limitation in stock smolagents 1.23.0, rather than demonstrating unavailable historical state. All five remain in the main score and incurred cost; paired exclusions are a separate sensitivity.

Historical reads and cache hits prove functioning mechanics, not automatically an advantage over naming retained Python state. Likewise, inspection counts do not prove the answer used the inspected version. Report accepted action/graph lineage evidence rather than all requested actions.

Stock smolagents has no complete table/version observer exporter. Exact full-state and lineage agreement are therefore unavailable for that arm, not zero. Native observer tables are also explicitly marked incomplete when capture limits apply. Strict JSON component agreement requires matching reference field names and array ordering; it can score equivalent answers poorly and is not semantic partial accuracy. It is retained as a diagnostic, not presented as an accuracy benefit.

## Implication for the next experiment

The defensible benefit demonstrated here is observability: recorded inputs and saved table contents make several wrong-stage and narrowed-population failures diagnosable. They did not improve aggregate accuracy in this run. The audits establish selected causal examples, not an exhaustive error taxonomy for every failed answer.

Before another broad campaign, preserve complete working tables separately from report cuts and verify the exact semantic failures above with focused regressions. Then use the previously proposed small paired repair experiment: give both agents the same faulty calculation and review evidence, change one rule, and check row identities, missingness, components, unchanged values and actual downstream results. Match Python's review opportunity and execution capability, and charge all repair work. That directly tests dependency refresh; another historical retrieval count or final-answer score alone would not.

## Artifacts

Shareable, verified per-question scores/costs/configuration are in [luna-scale5-smolagents-20261007.json](luna-scale5-smolagents-20261007.json). It omits raw questions, answers, traces and secrets.

Runtime campaign: `logs/luna-scale5-smolagents-20261007/`. Shared requests and evaluator-only gold are under `run/prepared/`; native source archive, frozen protocol, raw traces and observer captures under `run/pilot/`; stock prompt/config/code/observations under `run/baseline/`. Offline summary, causal replay code/evidence, final verification and judge watcher are under `analysis/`. Private runtime environment files are not for publication. Observer data and traces remain available after resource cleanup.

The judge watcher initially rejected a metadata-only record augmentation. Its runtime-only fix fingerprints the immutable judge-relevant payload and verifies legacy entries against the exact cached judge intent. Completed verdicts are reused, and solver runs are unchanged.
