# BobFlow Section 4 Direction: Parameterized Context Compaction

## 1. Core framing

The new direction is to frame BobFlow context construction as a **parameterized compression / compaction problem**.

Instead of saying that BobFlow has several fixed context modes, we define a single renderer:

```ts
summarize(dossier, params) -> context
```

The renderer takes a structured BobFlow dossier and a parameter vector, then produces the exact prompt context sent to the LLM. The research problem becomes:

> When the context becomes too large, how should BobFlow choose the `summarize()` parameters so that the context is token-efficient while preserving, or occasionally improving, the agent's next-action accuracy?

This is a better framing than treating context as an unstructured text summary. BobFlow has a structured substrate: operators, DAG edges, execution results, table profiles, lineage metadata, edit history, and task information. Therefore compression can be expressed as **typed rendering decisions** instead of unconstrained natural-language summarization.

---

## 2. Thesis sentence

A possible thesis for Section 4:

> BobFlow formulates context construction as dataflow-aware compaction. A single renderer, `summarize`, exposes a typed parameter space for controlling how operators, results, and history are represented. A compaction policy chooses these parameters from dataflow-derived features, optimizing token cost while preserving the evidence needed for the next action.

A shorter version:

> BobFlow compresses context by tuning how the current dataflow is rendered, rather than by blindly truncating or freely summarizing the interaction history.

---

## 3. Why this is the right abstraction

The previous framing was roughly:

```text
trajectory context vs. snapshot/latest context vs. hybrid context
```

That framing is useful, but it makes the design look like a few hand-written modes.

The new framing is more general:

```text
BobFlow state
  -> build dossier
  -> choose summarize parameters
  -> summarize(dossier, params)
  -> compact context
```

This makes the context system tunable, learnable, and implementable.

The key distinction is:

- Prior flat-history systems compress by dropping, truncating, or summarizing raw messages.
- BobFlow compresses by changing the **rendering fidelity** of structured dataflow objects.

Examples:

```text
source operator:      sample -> shape
settled interior op:  sample -> shape
dead operator:        render -> omit
frontier op:          shape -> sample/rich
wide table:           full columns -> capped schema/stats
join point:           no stats -> join-key stats
thrashing op:         no history -> code/result history
```

This turns compression into a structured policy problem.

---

## 4. Formalization

At step `t`, BobFlow maintains a state:

```math
S_t = (T, N_t, O_t, D_t)
```

where:

- `T` is the task;
- `N_t` is the event sequence;
- `O_t` is the observation store;
- `D_t` is the current dataflow DAG.

From this state BobFlow builds a **dossier**:

```math
Z_t = buildDossier(S_t)
```

The dossier contains the structured information needed for context rendering:

- current DAG;
- live, deleted, superseded, and blocked operators;
- operator roles;
- edit history;
- execution status;
- result summaries;
- table-shape flags;
- token-cost estimates;
- task features.

Then BobFlow chooses a parameter vector:

```math
p_t = \pi(Z_t, B)
```

where `B` is the context budget and `π` is the compaction policy.

Finally:

```math
C_t = summarize(Z_t, p_t)
```

The objective can be written as:

```math
\max_\pi\; \mathbb{E}[\text{TaskSuccess}] - \lambda\,\mathbb{E}[\text{ContextTokens}]
```

or, more conservatively:

```math
\min_\pi\; \mathbb{E}[\text{ContextTokens}]
\quad\text{s.t.}\quad
\text{TaskSuccess does not decrease.}
```

Given the current evidence, the second formulation is safer: context tuning appears to be mostly a **cost lever**, with a small number of accuracy-critical cases.

---

## 5. The `summarize()` action space

The `summarize()` parameter space should be presented as the action space of context compaction.

### 5.1 Per-operator rendering parameters

For each operator `v`, the renderer can choose:

```ts
detail: "omit" | "shape" | "sample" | "rich"
sampleRows: number
includeSchema: boolean
includeStats: boolean
includeValueFormatHints: boolean
includeStructuralHints: boolean
includeCode: boolean
includeCodeHistory: boolean
includeResultHistory: boolean
```

Interpretation:

- `omit`: do not render the operator.
- `shape`: render only compact structural information such as schema and shape.
- `sample`: render a small table sample.
- `rich`: render sample plus statistics, hints, and diagnostic information.

### 5.2 Flow-level parameters

These are cheap diagnostic signals computed from dataflow execution:

```ts
cardinalityAlarms: boolean
joinAlarms: boolean
coercionAlerts: boolean
errorContext: boolean
loaderHints: boolean
```

These are often low-token and high-value because they directly target silent failure modes.

### 5.3 Trajectory / history parameters

These decide how much past reasoning and history to keep:

```ts
events: "none" | "suffix" | "interleaved"
reasoningReplayK: number
historyDepth: number
contextWindowTokens: number
compactionStrategy: "sliding" | "compress"
deckFidelity: "heavy" | "lean" | "graduated"
```

This is where BobFlow handles context-window overflow.

---

## 6. Three-tier compaction policy

A useful way to organize the method is to divide parameters into three tiers.

### Tier 1: free cuts

These are reductions that should usually be safe and mostly rule-based.

Examples:

- consumed source operator: `sample -> shape`;
- settled interior operator: `sample -> shape`;
- deleted or blocked operator: `render -> omit`;
- very wide table: cap displayed columns;
- unchanged upstream during retry loop: freeze to `shape`.

These reduce cost without usually affecting accuracy.

### Tier 2: cheap accuracy insurance

These should be turned on when their trigger fires because they are cheap and prevent important mistakes.

Examples:

- schema lines;
- join-key statistics;
- categorical value counts;
- value-format hints;
- cardinality alarms;
- coercion alerts;
- error context;
- loader hints.

These are the cases where a smaller context can be more accurate because it surfaces the right diagnostic signal instead of hiding it inside raw rows.

### Tier 3: real trade-offs

These are the decisions that may require tuning or learning.

Examples:

- how much detail to show for the frontier operator;
- whether to show code for the active operator;
- when to include code history;
- how much result history to include for a thrashing operator;
- how many reasoning-replay lines to keep;
- when to compact the old trajectory into a deck;
- whether the deck should be heavy, lean, or graduated.

The key observation is that the hard learning problem is much smaller than the full parameter space. Most of the space can be handled by safe rules and cheap insurance; the true trade-off is localized.

---

## 7. Evidence from the notes

### 7.1 Context tuning is mostly a cost lever

The current evidence suggests that most failures are not fixable by context parameters. Many are action/modeling errors: wrong transformation, missing data, bad aggregation, fabricated time axis, or failure to delete/modify operators.

So Section 4 should avoid claiming that compaction broadly improves accuracy.

A safer claim:

> BobFlow compaction primarily reduces context cost while preserving accuracy. It can improve accuracy in specific failure modes where the missing information is a diagnostic signal, such as join-key statistics or categorical value distributions.

### 7.2 The main accuracy lever is targeted statistics

The clearest accuracy cases are:

- wrong join key: statistics on candidate join-key columns expose the valid key;
- mixed-case categorical filter: value counts expose the need for `.str.lower()`.

This suggests:

```text
stats on decision-critical columns = cheap accuracy insurance
```

The important point is not “show more data”; it is “show the right statistic.”

### 7.3 Compression is not monotonic

Shorter is not always better.

Examples:

- A short table should sometimes be rendered in full; hiding the middle can cause thrash.
- A leaner compacted deck can perform worse than a heavier deck because the removed stats were useful.
- A wide table should not be rendered as raw rows; schema/stats with caps may be better.

Therefore, the paper should emphasize:

> Context compression is not a monotone token-minimization problem. The policy must decide which information has high decision value per token.

### 7.4 LATEST is already lean

Under the current baseline, LATEST already removes event-log history and sends a current snapshot. This matters because many historical cost claims came from older DELTA-style traces.

Therefore, the residual problem under LATEST is not “remove old event history.” It is:

- reduce per-operator re-rendering cost;
- avoid rendering settled/consumed operators in too much detail;
- add targeted diagnostic signals when they matter;
- handle thrashy long-tail runs.

### 7.5 Compaction matters in the tail

For median short runs, compaction may barely matter. The value appears in long, thrashy, or context-window-limited runs.

A useful claim:

> BobFlow should not compress aggressively when it does not need to. Compaction is a tail mechanism: it matters when the context window is tight or the trajectory becomes long.

---

## 8. Training / tuning methodology

The clean methodology is to separate **cost** and **accuracy**.

### 8.1 Cost side: offline replay

Cost is deterministic.

Given a recorded action sequence, BobFlow can replay the same sequence through the current `summarize()` implementation under many parameter settings:

```text
recorded state sequence + parameter policy -> rendered context tokens
```

No LLM calls are required.

This gives exact cost measurements:

```text
task_id
step_t
policy_name
params
context_tokens
per_operator_token_breakdown
```

This should be the first implementation step because it is cheap, rigorous, and re-grounds all old cost claims against the current renderer.

### 8.2 Accuracy side: targeted live A/B

Accuracy requires live runs because changing context can change the agent’s future actions.

But broad live sweeps are expensive and noisy. Therefore, run targeted A/B only where parameters plausibly affect correctness:

- join-heavy tasks;
- filter-heavy tasks;
- dirty-load tasks;
- thrashing tasks;
- tasks where the context variant changes the frontier operator detail;
- tasks where stats or history could expose missing information.

For each candidate policy:

```text
policy A vs policy B
same task / same model / repeated runs
measure final correctness, steps, tokens
```

Because trajectory variance is high, use repeated runs for hard/thrashy cases.

### 8.3 Policy learning options

There are three levels of ambition.

#### Option A: global config search

Treat the selector configuration as hyperparameters.

```math
p^* = \arg\max_p \sum_{tasks} [correct - \lambda tokens]
```

This is the simplest and should be done first.

Methods:

- grid search;
- Bayesian optimization;
- random search;
- CMA-ES.

Output:

```text
one better global SelectorConfig
```

No ML model is required.

#### Option B: per-operator classifier

Train a model that maps operator features to a rendering choice.

Input:

```text
operator role
operator state
data-shape flags
steps since edit
edit count
error state
fan-in/fan-out
budget pressure
```

Output:

```text
omit / shape / sample / rich
plus optional flags such as stats, code, history
```

This is the most natural learned version.

#### Option C: RL / bandit over per-step policy

State:

```text
all operator feature vectors + global context features
```

Action:

```text
per-operator rendering menu + global history/compaction parameters
```

Reward:

```text
correct - lambda * tokens
```

This is the full version, but likely expensive because every rollout is a real agent run.

Recommended path:

```text
A first, then B, avoid C unless there is enough compute.
```

---

## 9. What about “gold standard parameters”?

Avoid the phrase “gold standard parameters.”

There may be many parameter settings that produce the same correct result. A slightly more verbose context may be equally correct but more expensive. A slightly shorter context may be cheaper but risky. So the target is not a single gold parameter vector.

Use **oracle preferences** instead.

For a checkpoint `t`, evaluate several parameter settings:

```math
p^{(1)}, p^{(2)}, \ldots, p^{(k)}
```

Each produces:

```math
C_t^{(j)} = summarize(Z_t, p^{(j)})
```

Measure:

```math
Q_t(p^{(j)}) = \text{agent quality under } C_t^{(j)}
```

and:

```math
T_t(p^{(j)}) = \text{tokens of } C_t^{(j)}
```

Define a preference:

```math
p^{(a)} \succ p^{(b)}
```

if either:

1. `p(a)` gives better task quality, or
2. both have equal task quality but `p(a)` uses fewer tokens.

This creates a ranking or pairwise-learning problem, not a brittle gold-label problem.

---

## 10. Relationship to ACON, ZipAct, and GenericAgent

### ACON

ACON treats context compression as optimizing reward minus context cost. It learns compression guidelines from contrastive failures: when uncompressed context succeeds but compressed context fails, the compression likely dropped important information.

BobFlow can use the same high-level optimization framing, but the compressor is different.

- ACON: optimize natural-language compression guidelines.
- BobFlow: optimize typed `summarize()` parameters over dataflow objects.

This is a sharper and more systems-oriented action space.

### ZipAct

ZipAct replaces the growing ReAct history with a compact state table.

BobFlow’s analogous move is to replace the raw trajectory with a compact, parameterized rendering of the current dataflow state and selected history.

- ZipAct state: Goal / World / Constraint.
- BobFlow state: DAG / operators / summaries / lineage / revisions / execution status.

### GenericAgent

GenericAgent frames context engineering as maximizing information density under a context budget. BobFlow shares this high-level goal, but uses dataflow-specific structure to decide what is dense and relevant.

---

## 11. Suggested Section 4 structure

### 4.1 Context Compaction as Parameterized Compression

Introduce the problem:

```text
At every step BobFlow must build a context under a finite budget.
When the rendered context is too large, it compacts the context by choosing parameters for summarize().
```

Define:

```math
C_t = summarize(Z_t, p_t)
```

and the objective:

```math
minimize tokens subject to preserving next-action accuracy
```

or:

```math
maximize success - lambda * tokens
```

### 4.2 The `summarize()` Action Space

Describe the parameter space:

- per-operator detail;
- table/result rendering;
- flow-level diagnostics;
- code/history options;
- trajectory/window compaction.

Emphasize that the action space is typed and valid by construction.

### 4.3 Dataflow Features for Choosing Parameters

Show why BobFlow can choose parameters better than flat-history agents.

Features:

- operator role: source, interior, frontier, terminal, blocked, deleted;
- liveness and consumer status;
- steps since edit;
- edit count / thrash;
- error status;
- fan-in/fan-out;
- distance to terminal operator;
- table width/height;
- dirty-load flags;
- categorical/numeric-as-text flags;
- budget pressure.

### 4.4 Tuning the Compaction Policy

Present the training/tuning ladder:

1. offline cost replay;
2. targeted live A/B for accuracy;
3. global config search;
4. optional per-operator learned policy;
5. optional RL only if compute allows.

### 4.5 Runtime Algorithm

Algorithm:

```text
1. Build dossier Z_t.
2. Render default context and estimate tokens.
3. If under budget, use default lean rendering.
4. If over budget or in a risky state, extract features.
5. Choose p_t via rule selector / tuned config / learned model.
6. Render C_t = summarize(Z_t, p_t).
7. Send C_t to the LLM.
```

Add guardrails:

- terminal/answer op never omitted;
- active error context preserved;
- wide schema lines capped;
- decision-critical stats preserved;
- active frontier remains sufficiently detailed;
- history only shown for stuck/thrashing operators.

---

## 12. Implementation roadmap

### Step 1: Build offline cost-replay harness

Input:

```text
recorded trajectories
current summarize() implementation
candidate param policies
```

Output:

```text
exact rendered token cost per task, step, operator, and policy
```

This is the highest-value immediate step.

### Step 2: Wire missing safe levers

Implement or verify:

- consumed source -> shape;
- idle/settled operator -> shape;
- dead operator -> omit;
- freeze unchanged upstream during retry loops;
- schema-line cap;
- wide-table guardrails.

### Step 3: Targeted accuracy A/B

Test:

- join-key stats;
- categorical value counts;
- error context;
- history/code for thrashing operators.

Use repeated runs on the few tasks where these could plausibly change correctness or step count.

### Step 4: Train or tune selector

First tune global config.

Then, if there is enough data, train a per-operator classifier:

```text
features -> render menu choice
```

### Step 5: Evaluate

Compare:

- LATEST baseline;
- rule selector;
- tuned selector;
- learned selector;
- sliding window;
- compress deck;
- graduated-fidelity deck.

Metrics:

- final accuracy;
- steps;
- rendered context tokens;
- cumulative input tokens;
- peak context tokens;
- token cost per successful task;
- accuracy/token Pareto curve.

---

## 13. Claims to make and avoid

### Strong claims we can make

- BobFlow turns context compression into a typed rendering-parameter problem.
- Dataflow structure gives useful features for deciding rendering fidelity.
- Cost can be measured exactly offline by replaying recorded action sequences through `summarize()`.
- Compaction is most useful under tight context windows and long/thrashy trajectories.
- Targeted diagnostics such as join-key stats and categorical value counts are cheap and can prevent specific errors.

### Claims to avoid

- “Context tuning broadly improves accuracy.”
- “There is a single gold parameter setting.”
- “Shorter summaries are always better.”
- “The LLM teacher solves context compression.”
- “All old cost numbers still apply under the current renderer.”

### Safest empirical claim

> On the current benchmark, context compaction is primarily a cost-saving mechanism with a narrow but important accuracy edge. BobFlow’s dataflow-aware renderer makes this trade-off explicit and tunable.

---

## 14. One-paragraph paper version

BobFlow treats context construction as a parameterized compaction problem. At each step, BobFlow builds a structured dossier from the task, current dataflow DAG, operator versions, execution results, and history. A shared renderer, `summarize`, converts this dossier into an LLM context according to a typed parameter vector controlling operator fidelity, result summaries, diagnostic annotations, and history replay. The compaction policy chooses these parameters from dataflow-derived features such as operator role, liveness, edit recency, execution status, table shape, and budget pressure. This formulation separates deterministic token-cost measurement from noisy accuracy evaluation: cost can be replayed offline under alternative parameter settings, while accuracy is evaluated through targeted live A/B tests on the few states where additional diagnostic information may affect the next action. In this way, BobFlow avoids both append-only trajectory growth and unconstrained text summarization, instead optimizing a structured rendering of the analysis state.

---

## 15. Final recommended direction

The recommended direction is:

```text
Do not train a free-form summarizer.
Do not search for one gold parameter vector.
Do formulate summarize() as a typed compaction action space.
Do build an offline cost-replay harness first.
Do use targeted live A/B only for accuracy-sensitive levers.
Do frame learning as choosing rendering parameters from dataflow features.
```

This gives Section 4 a clear methods story and a realistic implementation path.
