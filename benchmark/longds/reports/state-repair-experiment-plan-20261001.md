# LongDS state-repair evaluation

Implementation base: `23bf08e2f`, including numerical normalization, exact
historical result recovery, and selected execution. Historical state uses the
persistent graph and append-only ReAct history. There is no task catalog.

## Matched conditions

1. Native Dataflow with historical inspect, retrieve and fork disabled.
2. Native Dataflow with these tools and their usage instructions enabled.
3. Original DSGym agent and system prompt over a persistent Python kernel.

The two native conditions share every engine fix, general state-preservation
guidance, execution capability, and retrieval budget. The feature comparison
includes its usage prompt; it does not identify the effect of tools alone.
All three conditions receive the same adapted user messages: original context
and questions, file inventory, JSON answer contract, and general guidance to
preserve complete populations and distinguish temporary scenarios. This is a
diagnostic comparison, not an exact reproduction of the paper leaderboard.

All native retrieval views are available: `full`, `sample`, `sample_stats`.
Record budgets are 100,000 characters for full and 2,000 characters / 50 rows
for samples. Statistics have a separate 2,000-character budget; collection is
enabled before constructing operators. Flow evidence is disabled. A capped
full observation remains partial; downstream computation uses the full table.

Use Luna and Terra at medium reasoning effort, 40 model calls per question,
8,192 output tokens per call, and no solver retries. Preserve all incomplete
attempts and associated usage. Do not select successful reruns as replacements.

## Stages

Start with one Luna pilot repeat: restaurants questions 1–8 and Kiva 1–4,
crossed with all three conditions (36 questions). Audit each completed question
while the sessions run. Before expansion, verify state preservation, historical
tool behavior, engine stability and cost. A failed gate requires diagnosis;
preserve the original candidate and outputs before changing the implementation.

The broader natural-session scopes are predeclared:

| Session | Questions | Main mechanism |
| --- | --- | --- |
| Restaurants | 1–8 | Previous filtered population, temporary feedback check, complete risk pool |
| Kiva | 1–26 | Eligibility ancestry, earlier blends, old formula with current population |
| Kaggle survey | 1–30 | Narrow/broad adopter definitions, denominator changes, global anchors |
| Netflix | 1–36 | Historical score components, rank populations, cross-version comparisons |
| NFL | 1–42 | Repeated rollback, sensitivity branches, player/team dependencies |

Each broader repeat has 142 questions per condition. Use three matched Luna
repeats and then Terra confirmation if the pilot supports expansion. Do not
change the case selection after inspecting which condition wins.

Separately construct controlled episodes from independently verified checkpoints
to test earlier populations, earlier formulas, and old formulas with current
data. Give both native conditions identical graphs, prior answers and history.
Report checkpoint episodes separately from natural end-to-end sessions.

## Evidence and evaluation

- Original Appendix E.2 correctness prompt with DeepSeek V4 Pro.
- Original Appendix E.3 Codex error-classification prompt with its existing
  gpt-5.5/xhigh annotation runner; classify failures under the original rules.
- Frozen requested-field rubrics for deterministic partial credit, with explicit
  answer-shape mapping. Unsupported mappings remain unscored. Ancillary values
  receive a separate factual audit.
- Inspect passing and failing traces for complete population availability,
  selected historical identity, formula, population, eligibility ancestry,
  null global anchors, and downstream cascades.
- Record all solver attempts, cache-aware estimated cost, cached input tokens,
  output tokens, action counts, repeated actions, stale reads, provider errors,
  engine failures and prefix changes. Evaluation usage is separate from solving.

Use a private service profile, ports, databases and computing units. Verify
other containers and service listeners remain unchanged. Inputs and reference
sources are hashed; gold answers never enter solver prompts. Runtime controllers
and raw artifacts live in `logs/longds-state-pilot-20261001` and
`/var/tmp/texera-state-pilot-20261001`.
