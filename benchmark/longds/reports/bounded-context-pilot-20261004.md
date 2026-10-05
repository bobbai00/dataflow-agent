# Bounded-context LongDS pilot — predeclared plan

This pilot compares the current dataflow agent with DSGym on two natural
19-turn LongDS prefixes. It tests whether state retrieval remains useful when
both agents have a bounded context; one repetition cannot establish a broad
accuracy or cost advantage.

The selected cases are `community/kaggle-survey-2021/task2` (Q19 reuses the
Python/Matplotlib subgroup and compares its framework ranking with the earlier
overall ranking) and `business/netflix_movies_and_tv_shows/task3` (Q19 replaces
one historical scoring rule while retaining current components and membership).
All 38 reference answers reproduce with the repository Python environment.
Only notebook-relative data paths were normalized. The initially considered
2020 survey prefix was rejected before solver calls: five published answers
contain NaN. Its gate artifacts remain recorded.

Both arms use Luna at medium reasoning, the identical interface-neutral user
requests, 40 model calls per turn, and 8,192 output tokens per call. The initial
full-input cap is 32,000 estimated tokens, including the system prompt and tool
schemas. One pooled scale, 0.9191098451130497, was calibrated on 270 earlier
development requests without answer scores. Actual provider usage is audited
separately; this estimator is not a tokenizer guarantee. No artificial history
or token padding is added to make the cap bind.

The dataflow arm uses ordinary native ReAct, task/answer/dependency cards,
on-demand task-local historical retrieval, available data statistics, and
runtime answer composition. It has no ledger. Automatic overflow checkpoints
exclude unchanged historical operators. All current references remain available
through state tools.

DSGym retains its Python kernel for the entire prefix. At overflow the same
solver model summarizes complete earlier messages in bounded chunks, retaining
the original request, current question, recent turns, incremental summary and
live variable inventory. Every summarization call, failed provider attempt and
token is included in call limits and cost. No baseline kernel resets occur.
Within an exceptionally large current turn, older printed outputs may be
omitted with an explicit marker; the kernel objects remain available.

The primary measure remains the official LongDS binary judgment with its
existing DeepSeek judge. Additional measures are strict JSON validity, the
frozen Q19 answer-component rubrics (table membership, requested values, rank),
calls including summaries, cache usage, latency, retrieval size, execution/tool
errors, and full-request cap violations. Component metrics recognize only
predeclared answer structures; unfamiliar structures are unscored, not silently
assigned zero. Manual trace audits distinguish wrong cohort/definition,
unsupported reuse, answer formatting and infrastructure errors. A dependency
edge alone does not prove a cascading failure.

All four attempts are retained with frozen source/input hashes. No best-of
selection or score-selected solver retry is allowed. If the cap does not bind,
that is reported; any further cap or control experiment requires a separately
frozen protocol. The comparison bundles prompt/context/interface changes, so it
cannot isolate the causal effect of a single fix. Costs use frozen repository
fallback rates and are estimates, not provider invoices.

## Verification adjustment after the first pass

The first pass completed all 76 answers. It exposed a real overflow failure:
user turns have no owned snapshots, so the starting-workflow identity must be
resolved to its preceding action. The initial unit fixture incorrectly gave
user turns snapshots. The revised regression uses the production structure,
fails on the first-pass implementation, and passes after the fix.

One further paired pass uses exactly the same two prefixes and 32k policy.
The Python baseline additionally receives a generic execution-protocol notice:
the runner executes `<python>` blocks and supplies the subsequent observations,
with no formal function-call tool required. This changes no question, analytical
rule, file, kernel lifetime or reference answer. It addresses model claims that
a verified executable kernel was unavailable. Both passes remain separately
reported; this is verification after a discovered bug, not best-of selection.

The first-pass automatic target-component scorer encountered equivalent JSON
structures with different field names. Those remain unscored in its frozen
metric; a separately labeled manual component audit may map reported fields to
the question-defined table requirements. Official judgments remain unchanged.
