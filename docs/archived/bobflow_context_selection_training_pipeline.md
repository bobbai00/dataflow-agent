# BobFlow Learned Context Selection: End-to-End Implementation Plan

## 0. Goal

This document specifies an end-to-end implementation plan for learning a context selector for BobFlow.

We focus only on the **trajectory vs. latest-dataflow** part of context construction. Result summaries are held fixed across all context variants.

The learning problem is:

> Given a BobFlow state, start from a compact latest-dataflow context and learn which historical trajectory evidence should be added back under a token budget.

The final runtime context is:

```text
learned_context_t = latest_dataflow_context_t + selected_historical_bundles_t
```

The selector should improve the accuracy/token trade-off relative to:

1. full trajectory context;
2. latest-dataflow-only context;
3. hand-written hybrid context;
4. recency-only or FIFO history selection.

---

## 1. Core Design Assumptions

### 1.1 Fixed result summaries

All context variants use the same operator result-summary format.

This means the first implementation does **not** learn:

- which table-profile fields to show;
- which lineage-profile fields to show;
- how to summarize raw tables;
- how to compress error logs.

The only learned decision is whether to include optional **historical evidence** that is present in the trajectory but absent from the latest-dataflow context.

### 1.2 Latest-dataflow context is the mandatory core

At every step `t`, BobFlow builds a mandatory core:

```text
C_latest(t) = task + current dataflow DAG + latest result summary for each live operator
```

The learned model never removes this core in the first implementation.

Rationale: letting the model drop live operators or DAG edges makes the context incoherent and makes training harder. The first version should only learn add-back decisions.

### 1.3 Historical evidence is represented as bundles

The selector should not operate over arbitrary text spans.

Instead, it selects semantically complete bundles such as:

- a failed historical attempt;
- a superseded operator version;
- a deleted operator record;
- an old result summary;
- a previous thought/action rationale.

Each bundle has:

```text
bundle_id
bundle_type
associated_operator_id
associated_version_id
serialized_text
token_cost
feature_vector
```

### 1.4 Training uses contrastive outcomes

We use two endpoint contexts:

```text
C_traj(t)   = full trajectory context at state t
C_latest(t) = latest-dataflow context at state t
```

At the same saved BobFlow state, we compare how the agent behaves under these two contexts.

The contrastive cases are:

| C_traj outcome | C_latest outcome | Interpretation |
|---|---|---|
| success | failure | latest context is missing useful historical evidence |
| failure | success | trajectory contains stale or distracting evidence |
| success | success | latest context is sufficient and cheaper |
| failure | failure | neither endpoint is sufficient; mostly error analysis |

Then we localize useful/harmful historical bundles using add-back and removal tests.

---

## 2. Main Objects and Notation

### 2.1 BobFlow state

At Think step `t`, save the complete state:

```python
State_t = {
    "task": Task,
    "event_sequence": List[Event],
    "observation_store": Dict[Timestamp, Observation],
    "current_dataflow": DataflowDAG,
    "engine_cache": EngineCache,
}
```

Mathematically:

```text
S_t = (T, N_t, O_t, D_t)
```

Where:

- `T`: task;
- `N_t`: event sequence;
- `O_t`: observation store;
- `D_t`: current dataflow DAG.

### 2.2 Event

```python
Event = {
    "event_id": str,
    "timestamp": int,
    "thought": str,
    "action": Optional[Action],
    "llm_response_raw": str,
}
```

### 2.3 Action

```python
Action = {
    "edits": List[Edit]
}
```

Each edit is one of:

```python
InsertOperatorEdit = {
    "edit_type": "insert",
    "operator_id": str,
    "description": str,
    "predecessors": List[str],
    "code": str,
}

UpdateOperatorEdit = {
    "edit_type": "update",
    "operator_id": str,
    "description": str,
    "predecessors": List[str],
    "code": str,
}

DeleteOperatorEdit = {
    "edit_type": "delete",
    "operator_id": str,
}
```

### 2.4 Observation

```python
Observation = {
    "timestamp": int,
    "result_summaries": Dict[OperatorID, ResultSummary]
}
```

### 2.5 Result summary

Held fixed in this project. The result summary should include the same fields in all context variants.

```python
ResultSummary = {
    "runtime_status": {
        "status": "succeeded" | "failed",
        "error_digest": Optional[str],
    },
    "table_profile": {
        "schema": List[ColumnSchema],
        "sample_rows": List[Dict[str, Any]],
        "value_summary": Dict[str, Any],
        "keys_and_partitions": Dict[str, Any],
        "dirty_data_hints": Dict[str, Any],
        "value_formats": Dict[str, Any],
    },
    "lineage_profile": {
        "cardinality": Dict[str, Any],
        "join_check": Optional[Dict[str, Any]],
        "coercion_check": Optional[Dict[str, Any]],
    }
}
```

---

## 3. Endpoint Context Builders

Implement two deterministic context builders.

### 3.1 Full trajectory context

```python
def build_trajectory_context(state: State) -> Context:
    """
    Serialize task + all previous events + all observations.
    This is high-recall but can contain stale information.
    """
```

Expected content:

```text
Task
For each event in chronological order:
    thought
    action edits
    observation summaries
```

Important implementation decision:

- For the first experiment, keep code handling consistent.
- Either strip code from both contexts, or treat code as a separate optional bundle.
- Do not let the trajectory context include code while latest context strips code unless the experiment explicitly studies code as a variable.

Recommended first version:

```text
strip code from both contexts
```

This isolates historical evidence from code availability.

### 3.2 Latest-dataflow context

```python
def build_latest_context(state: State) -> Context:
    """
    Serialize task + current DAG skeleton + latest result summary for each live operator.
    """
```

Expected content:

```text
Task
Current dataflow DAG:
    for each live operator:
        operator id
        natural-language description
        predecessor ids
        latest fixed result summary
```

Do not include:

- deleted operators;
- superseded operator versions;
- old thoughts;
- old actions;
- old result summaries;
- failed attempts unless they belong to the latest live operator summary.

---

## 4. Candidate Historical Bundles

Candidate bundles are optional pieces that can be added to `C_latest(t)`.

```python
def extract_candidate_bundles(state: State) -> List[Bundle]:
    ...
```

### 4.1 Bundle schema

```python
Bundle = {
    "bundle_id": str,
    "checkpoint_id": str,
    "bundle_type": str,
    "associated_operator_id": Optional[str],
    "associated_version_id": Optional[str],
    "associated_event_ids": List[str],
    "associated_observation_ids": List[str],
    "serialized_text": str,
    "token_cost": int,
    "metadata": Dict[str, Any],
}
```

### 4.2 Bundle types

#### 4.2.1 Historical attempt bundle

Represents an earlier attempt to insert or update an operator.

```text
Bundle type: historical_attempt
Contains:
    event timestamp
    thought summary
    edit type
    operator id
    operator description
    predecessor ids
    execution status
    error digest, if failed
```

Example rendering:

```text
Historical attempt at t=7 for operator op_join:
- edit: insert join operator
- predecessors: op_movies, op_ratings
- description: join ratings with movies on movie_id
- result: failed
- error: KeyError: movie_id missing from ratings table
```

#### 4.2.2 Superseded-version bundle

Represents an older version of a currently live operator.

```text
Bundle type: superseded_version
Contains:
    old version description
    old predecessor list
    old execution status
    later update that superseded it
```

Example rendering:

```text
Superseded version of op_filter:
- old desc: keep movies after 2000
- later updated to: keep movies before 2000
- old result: succeeded
```

#### 4.2.3 Deleted-operator bundle

Represents an operator no longer in the current DAG.

```text
Bundle type: deleted_operator
Contains:
    deleted operator id
    former description
    former predecessors
    last execution status
    deletion timestamp
```

Example rendering:

```text
Deleted operator op_join_old:
- former desc: join on title
- predecessors: op_movies, op_ratings
- last status: succeeded but produced 0 rows
- deleted at t=9
```

#### 4.2.4 Old result-summary bundle

Represents the result summary of a superseded or deleted operator.

```text
Bundle type: old_result_summary
Contains:
    operator id
    version id
    result summary
    timestamp
```

Use sparingly because these can be long.

#### 4.2.5 Thought/action rationale bundle

Represents reasoning that may explain why Bob chose or abandoned a path.

```text
Bundle type: rationale
Contains:
    thought text, optionally compressed to one or two sentences
    associated action ids
```

These bundles may be noisy. Include them in the candidate set but track their type explicitly so the model can learn whether they help.

---

## 5. Checkpoint Collection

### 5.1 Checkpoint timing

Save a replayable checkpoint before every LLM Think call:

```python
def save_checkpoint(state: State, task_id: str, trajectory_id: str, step_t: int) -> Checkpoint:
    ...
```

Also save checkpoints around important events:

- immediately after an insert;
- immediately after an update;
- immediately after a delete;
- immediately after execution failure;
- immediately after successful repair;
- when DAG size or history length crosses a threshold.

### 5.2 Checkpoint schema

```python
Checkpoint = {
    "checkpoint_id": str,
    "task_id": str,
    "trajectory_id": str,
    "step_t": int,
    "state_path": str,
    "current_dag_hash": str,
    "event_count": int,
    "live_operator_count": int,
    "deleted_operator_count": int,
    "superseded_version_count": int,
    "failure_count_so_far": int,
    "trajectory_context_path": str,
    "latest_context_path": str,
    "trajectory_tokens": int,
    "latest_tokens": int,
}
```

### 5.3 Replay requirements

Each checkpoint must be sufficient to replay alternative contexts from the same underlying state.

Store:

- serialized state object;
- dataflow DAG;
- engine cache or deterministic recomputation mechanism;
- data lakehouse snapshot identifier;
- model name;
- system prompt;
- context rendering version;
- random seed or decoding configuration;
- task evaluator.

---

## 6. Endpoint Evaluation

At each checkpoint, run the agent under both endpoint contexts.

```python
def evaluate_endpoint_contexts(checkpoint: Checkpoint) -> EndpointComparison:
    C_traj = build_trajectory_context(checkpoint.state)
    C_latest = build_latest_context(checkpoint.state)

    result_traj = run_one_decision_or_rollout(C_traj, checkpoint)
    result_latest = run_one_decision_or_rollout(C_latest, checkpoint)

    return compare(result_traj, result_latest)
```

### 6.1 Evaluation modes

Use two modes.

#### Cheap mode: one-step evaluation

Generate one action, execute it, then score:

```text
next_action_valid
next_action_exec_success
action_match_reference
progress_score
```

This is cheaper and useful for generating many labels.

#### Expensive mode: continuation rollout

Generate one action under the tested context. Execute it. Then continue the rest of the task under a fixed reference context policy.

Recommended continuation policy:

```text
rich_hybrid_or_high_recall_policy
```

This isolates the effect of the context used at the checkpoint.

### 6.2 Quality score

Define a scalar quality score:

```python
def compute_quality(result: AgentRunResult) -> float:
    return (
        alpha * result.action_match_reference
        + beta * result.execution_success
        + gamma * result.progress_score
        + delta * result.final_task_score
        - eta * result.remaining_steps_penalty
    )
```

Recommended initial weights:

```yaml
quality_weights:
  action_match_reference: 0.0
  execution_success: 0.3
  progress_score: 0.2
  final_task_score: 0.5
  remaining_steps_penalty: 0.0
```

If full rollouts are too expensive, start with:

```yaml
quality_weights:
  action_match_reference: 0.3
  execution_success: 0.5
  progress_score: 0.2
  final_task_score: 0.0
```

### 6.3 Endpoint comparison schema

```python
EndpointComparison = {
    "checkpoint_id": str,
    "Q_traj": float,
    "Q_latest": float,
    "traj_success": bool,
    "latest_success": bool,
    "traj_tokens": int,
    "latest_tokens": int,
    "case_type": str,
    "result_traj": AgentRunResult,
    "result_latest": AgentRunResult,
}
```

`case_type` is one of:

```text
traj_success_latest_fail
traj_fail_latest_success
both_success
both_fail
```

---

## 7. Localized Interventions

Endpoint comparisons give context-level labels. Localized interventions turn them into bundle-level labels.

### 7.1 Add-back tests

Use when:

```text
Q_traj > Q_latest + epsilon
```

This means latest context likely omitted useful historical information.

For each candidate bundle `i`:

```text
C_without_i = C_latest
C_with_i    = C_latest + bundle_i
```

Evaluate both.

```python
def run_addback_test(checkpoint: Checkpoint, bundle: Bundle) -> BundleIntervention:
    C0 = build_latest_context(checkpoint.state)
    C1 = add_bundle(C0, bundle)

    R0 = evaluate_context(C0, checkpoint)
    R1 = evaluate_context(C1, checkpoint)

    return BundleIntervention(
        intervention_type="add_back",
        Q_without=Q(R0),
        Q_with=Q(R1),
        delta_Q=Q(R1)-Q(R0),
    )
```

Positive label:

```text
delta_Q > epsilon
```

Interpretation:

> This historical bundle improves latest-dataflow context.

### 7.2 Removal tests

Use when:

```text
Q_latest > Q_traj + epsilon
```

This means trajectory likely contains stale or harmful information.

For each candidate bundle `i` in the trajectory:

```text
C_with_i    = C_traj
C_without_i = C_traj - bundle_i
```

Evaluate both.

```python
def run_removal_test(checkpoint: Checkpoint, bundle: Bundle) -> BundleIntervention:
    C1 = build_trajectory_context(checkpoint.state)
    C0 = remove_bundle(C1, bundle)

    R1 = evaluate_context(C1, checkpoint)
    R0 = evaluate_context(C0, checkpoint)

    return BundleIntervention(
        intervention_type="remove",
        Q_without=Q(R0),
        Q_with=Q(R1),
        delta_Q=Q(R1)-Q(R0),
    )
```

Negative label:

```text
delta_Q < -epsilon
```

Interpretation:

> This bundle harms the trajectory context.

### 7.3 Cost-only preference for both-success cases

If both endpoint contexts succeed:

```text
Q_traj ≈ Q_latest
```

Then prefer the cheaper context.

For training, this can produce weak negative labels for extra trajectory bundles:

```text
historical bundles omitted by latest are redundant at this state
```

Use these labels with lower weight.

### 7.4 Skip most both-fail cases

If both endpoints fail:

```text
Q_traj low and Q_latest low
```

Do not label all bundles as bad. The failure may be due to:

- model limitation;
- missing result-summary detail;
- impossible task;
- evaluator issue;
- wrong earlier state.

Keep these cases for error analysis, not primary supervised training.

---

## 8. Bundle-Level Labels

For every intervention, define:

```text
delta_Q = Q_with_bundle - Q_without_bundle
```

Use a three-way label:

```python
def label_from_delta(delta_Q: float, epsilon: float) -> str:
    if delta_Q > epsilon:
        return "positive"
    elif delta_Q < -epsilon:
        return "negative"
    else:
        return "neutral"
```

Interpretation:

| Label | Meaning |
|---|---|
| positive | useful historical evidence |
| neutral | redundant or no measurable effect |
| negative | stale/noisy/harmful evidence |

Use label confidence:

```python
label_confidence = min(1.0, abs(delta_Q) / confidence_scale)
```

If using repeated runs:

```python
delta_Q_mean = mean(delta_Q_over_seeds)
delta_Q_std = std(delta_Q_over_seeds)
label_confidence = abs(delta_Q_mean) / (delta_Q_std + small_constant)
```

---

## 9. Feature Extraction

For each bundle `i` at checkpoint `t`, extract only features observable at step `t`.

```python
def featurize_bundle(bundle: Bundle, state: State) -> FeatureVector:
    return {
        **type_features(bundle),
        **temporal_features(bundle, state),
        **version_liveness_features(bundle, state),
        **dag_lineage_features(bundle, state),
        **execution_features(bundle, state),
        **data_summary_features(bundle, state),
        **task_features(bundle, state),
        **cost_features(bundle),
    }
```

### 9.1 Type features

```text
bundle_type_one_hot
is_historical_attempt
is_superseded_version
is_deleted_operator
is_old_result_summary
is_rationale
is_code_bundle
```

### 9.2 Temporal features

```text
age_steps = current_step - bundle_timestamp
normalized_age = age_steps / current_step
is_recent_k_1
is_recent_k_3
is_recent_k_5
steps_since_last_reference
occurred_before_most_recent_failure
occurred_after_most_recent_failure
occurred_before_most_recent_update_or_delete
occurred_after_most_recent_update_or_delete
```

### 9.3 Version and liveness features

```text
associated_operator_is_live
associated_operator_is_deleted
associated_operator_is_superseded
associated_operator_has_newer_version
num_newer_versions
was_followed_by_update
was_followed_by_delete
is_latest_version_of_operator
is_first_version_of_operator
current_live_operator_has_same_id
```

These are central BobFlow-specific features.

### 9.4 DAG and lineage features

For the associated operator, compute:

```text
operator_depth
operator_fan_in
operator_fan_out
num_ancestors
num_descendants
distance_to_nearest_sink
is_ancestor_of_current_sink
is_descendant_of_recently_updated_operator
is_upstream_of_failed_operator
is_downstream_of_failed_operator
is_on_branch_of_most_recent_edit
subdag_size_affected_by_operator
```

If a bundle is associated with a deleted operator, compute these features using the historical DAG immediately before deletion, plus indicators that it is no longer live.

### 9.5 Execution features

```text
last_execution_status_success
last_execution_status_failed
error_class_one_hot
has_error_digest
num_failures_for_operator
num_successes_for_operator
was_failure_followed_by_repair
was_success_followed_by_delete
was_success_followed_by_update
failure_repeated_count
```

### 9.6 Data-summary scalar features

Even though result summaries are fixed, scalar properties of those summaries can be predictive.

```text
output_row_count
output_col_count
input_output_row_ratio
input_output_col_delta
schema_width
num_numeric_columns
num_string_columns
num_datetime_columns
max_null_rate
mean_null_rate
max_distinct_count
has_candidate_key
has_dirty_data_hint
has_value_format_hint
has_join_check
join_check_failed
has_coercion_check
coercion_check_failed
```

### 9.7 Task-conditioned features

```text
task_operator_text_similarity
task_bundle_text_similarity
task_mentions_associated_column
task_mentions_associated_file
task_mentions_operator_type
column_name_overlap_count
file_name_overlap_count
```

Implementation options:

- string matching for columns/files;
- TF-IDF similarity;
- embedding similarity, optional.

Start with cheap lexical features before adding embedding features.

### 9.8 Cost features

```text
token_cost
char_count
line_count
num_tables_rendered
cost_fraction_of_remaining_budget
```

Utility and cost should remain conceptually separate, but cost features can help the model learn that long bundles are often not worth including.

---

## 10. Training Dataset

### 10.1 Bundle intervention record

Store one row per tested bundle intervention.

```python
BundleTrainingRecord = {
    "task_id": str,
    "trajectory_id": str,
    "checkpoint_id": str,
    "step_t": int,

    "intervention_type": "add_back" | "remove" | "cost_only",
    "endpoint_case_type": str,

    "bundle_id": str,
    "bundle_type": str,
    "associated_operator_id": Optional[str],
    "associated_version_id": Optional[str],
    "associated_event_time": int,

    "features": Dict[str, float],
    "token_cost": int,

    "Q_without_bundle": float,
    "Q_with_bundle": float,
    "delta_Q": float,
    "label": "positive" | "neutral" | "negative",
    "label_confidence": float,

    "context_without_path": str,
    "context_with_path": str,
    "run_without_path": str,
    "run_with_path": str,
}
```

Recommended storage:

```text
data/
  raw_checkpoints/
  contexts/
  runs/
  bundles/
  features/
  labels/
```

Use JSONL for logs and Parquet for feature tables.

### 10.2 Pairwise ranking records

Optionally derive pairwise preferences within the same checkpoint.

```python
PairwiseRecord = {
    "task_id": str,
    "checkpoint_id": str,
    "bundle_i_id": str,
    "bundle_j_id": str,
    "features_i": Dict[str, float],
    "features_j": Dict[str, float],
    "preferred": "i" | "j",
    "preference_margin": float,
}
```

Construct when:

```text
delta_Q_i > delta_Q_j + margin
```

---

## 11. Model Training

### 11.1 First model: three-class classifier

Train:

```text
f_theta(features) -> P(positive), P(neutral), P(negative)
```

Define utility:

```text
u_hat = P(positive) - P(negative)
```

Recommended models:

1. logistic regression: easiest to interpret;
2. gradient-boosted trees: handles nonlinear feature interactions;
3. random forest: useful sanity check;
4. LambdaMART: use later if pairwise ranking dominates.

Start with gradient-boosted trees plus a logistic-regression baseline.

### 11.2 Training split

Split by task, not by rows.

Do not randomly split bundle rows, because checkpoints from the same task are highly correlated.

Recommended split:

```text
train tasks: 70%
validation tasks: 15%
test tasks: 15%
```

If tasks share datasets or templates, split by template/dataset when possible.

### 11.3 Loss

For three-class classifier:

```text
weighted cross entropy
```

Weight each example by:

```text
example_weight = label_confidence * class_balance_weight * intervention_type_weight
```

Suggested intervention weights:

```yaml
add_back: 1.0
remove: 1.0
cost_only: 0.3
```

### 11.4 Calibration

Calibrate predicted probabilities on validation tasks.

Options:

- Platt scaling;
- isotonic regression.

The selector depends on relative scores, but calibration helps when comparing utility to token cost.

### 11.5 Feature ablations

Train and evaluate the following feature sets:

```text
A. recency only
B. recency + type
C. recency + type + version/liveness
D. recency + type + version/liveness + DAG/lineage
E. all above + execution/data features
F. all above + task-conditioned features
```

The core paper claim is supported if:

```text
D or E significantly improves over A and B
```

---

## 12. Runtime Selection Algorithm

At inference time:

```python
def build_learned_context(state: State, budget_tokens: int, model: UtilityModel) -> Context:
    core = build_latest_context(state)
    core_tokens = count_tokens(core)
    remaining_budget = budget_tokens - core_tokens

    bundles = extract_candidate_bundles(state)

    scored = []
    for b in bundles:
        phi = featurize_bundle(b, state)
        probs = model.predict_proba(phi)
        u_hat = probs["positive"] - probs["negative"]
        scored.append((b, u_hat, b.token_cost))

    selected = select_under_budget(scored, remaining_budget)
    return render_context(core, selected)
```

### 12.1 Selection policy

Initial version:

```python
def select_under_budget(scored_bundles, budget):
    candidates = [x for x in scored_bundles if x.u_hat > 0]
    candidates.sort(key=lambda x: x.u_hat / max(x.token_cost, 1), reverse=True)

    selected = []
    used = 0
    for b, u, c in candidates:
        if used + c <= budget:
            selected.append(b)
            used += c
    return selected
```

Later version:

- solve 0/1 knapsack exactly if candidate count is small;
- use grouped knapsack to maintain coherence.

### 12.2 Coherence constraints

Some bundles require other bundles.

Examples:

```text
If error digest selected, include associated edit description.
If old result summary selected, include operator id and old description.
If deleted operator selected, include deletion event.
```

Represent as dependencies:

```python
Bundle = {
    ...,
    "requires": List[BundleID],
}
```

Selection must close over `requires`.

### 12.3 Rendering order

Use deterministic ordering to reduce position confounds.

Recommended final context order:

```text
1. task
2. current DAG skeleton
3. latest result summaries for live operators
4. selected historical evidence grouped by operator
5. selected global rationales, if any
```

Within each operator group:

```text
current operator
latest summary
selected historical attempts, newest first
selected superseded/deleted records
```

---

## 13. Evaluation

### 13.1 Baselines

Compare:

1. `trajectory`: full trajectory context;
2. `latest`: latest-dataflow-only context;
3. `hybrid`: hand-written hybrid strategy;
4. `recency`: latest + most recent historical bundles under budget;
5. `random`: latest + random historical bundles under budget;
6. `learned`: latest + learned selected bundles;
7. `oracle_addback`: latest + best bundle found by interventions, upper bound.

### 13.2 Metrics

Task quality:

```text
final_task_accuracy
final_answer_exact_match
final_table_similarity
execution_success_rate
number_of_repair_steps
number_of_repeated_failed_actions
```

Cost:

```text
peak_input_tokens
cumulative_input_tokens
cumulative_output_tokens
total_tokens
average_tokens_per_step
```

Efficiency:

```text
accuracy_per_1k_tokens
success_per_total_token_budget
```

Selector quality:

```text
bundle_label_accuracy
positive_bundle_precision
positive_bundle_recall
negative_bundle_precision
pairwise_ranking_accuracy
NDCG@k
```

### 13.3 Main expected result

The ideal outcome:

```text
learned selector ≈ trajectory accuracy
learned selector ≈ latest token cost
learned selector > latest accuracy
learned selector < trajectory token cost
```

### 13.4 Critical ablation

Show that dataflow-specific features matter:

```text
recency only
< recency + version/liveness
< recency + version/liveness + DAG/lineage
< all features
```

If this ordering does not hold, the learned selector may not be adding much beyond simple recency or snapshot rules.

---

## 14. Implementation Modules

Recommended package layout:

```text
bobflow_context_learning/
  __init__.py

  state/
    checkpoint.py
    replay.py
    schema.py

  context/
    render_latest.py
    render_trajectory.py
    render_learned.py
    token_count.py

  bundles/
    extract.py
    render.py
    dependencies.py

  features/
    type_features.py
    temporal_features.py
    version_features.py
    dag_features.py
    execution_features.py
    data_features.py
    task_features.py
    cost_features.py
    featurize.py

  evaluation/
    run_agent.py
    score_action.py
    score_rollout.py
    compare_contexts.py

  interventions/
    endpoint_compare.py
    add_back.py
    remove.py
    label.py

  training/
    dataset.py
    train_classifier.py
    train_ranker.py
    calibrate.py
    evaluate_model.py

  inference/
    selector.py
    knapsack.py
    build_context.py

  experiments/
    collect_checkpoints.py
    collect_labels.py
    run_baselines.py
    run_learned_selector.py
    ablations.py
```

---

## 15. End-to-End Pipeline Commands

Example CLI pipeline:

```bash
# 1. Run high-recall BobFlow and save checkpoints
python -m bobflow_context_learning.experiments.collect_checkpoints \
  --tasks data/tasks/train.jsonl \
  --context_policy trajectory \
  --out data/checkpoints/train/

# 2. Build endpoint contexts
python -m bobflow_context_learning.context.build_endpoints \
  --checkpoints data/checkpoints/train/ \
  --out data/contexts/endpoints/

# 3. Evaluate trajectory vs latest at each checkpoint
python -m bobflow_context_learning.interventions.endpoint_compare \
  --checkpoints data/checkpoints/train/ \
  --out data/endpoint_comparisons/train.jsonl

# 4. Extract candidate historical bundles
python -m bobflow_context_learning.bundles.extract \
  --checkpoints data/checkpoints/train/ \
  --out data/bundles/train.jsonl

# 5. Run add-back/removal interventions
python -m bobflow_context_learning.interventions.collect_labels \
  --endpoint_comparisons data/endpoint_comparisons/train.jsonl \
  --bundles data/bundles/train.jsonl \
  --out data/labels/train.jsonl

# 6. Extract features
python -m bobflow_context_learning.features.featurize \
  --labels data/labels/train.jsonl \
  --out data/features/train.parquet

# 7. Train model
python -m bobflow_context_learning.training.train_classifier \
  --train data/features/train.parquet \
  --valid data/features/valid.parquet \
  --model_out models/context_selector_gbdt.pkl

# 8. Evaluate learned selector
python -m bobflow_context_learning.experiments.run_learned_selector \
  --tasks data/tasks/test.jsonl \
  --model models/context_selector_gbdt.pkl \
  --budget_tokens 8000 \
  --out results/learned_selector_test.jsonl

# 9. Run ablations
python -m bobflow_context_learning.experiments.ablations \
  --features data/features/test.parquet \
  --out results/feature_ablations.json
```

---

## 16. Pilot Plan

Start small.

Suggested pilot:

```text
50 tasks
2 trajectories per task
5 checkpoints per trajectory
= 500 checkpoints
```

At each checkpoint:

```text
1 endpoint comparison: trajectory vs latest
3 to 5 localized bundle interventions if endpoints differ
```

Expected labels:

```text
500 endpoint comparisons
300 to 1000 localized bundle labels
```

First pilot questions:

1. How often does trajectory beat latest?
2. How often does latest beat trajectory?
3. Which bundle types explain the differences?
4. Are version/liveness/DAG features predictive beyond recency?
5. Does the learned selector beat latest-only at the same budget?

---

## 17. Common Failure Modes and Safeguards

### 17.1 Trajectory is not an oracle

Trajectory context is high-recall, but it can fail because stale information distracts the LLM.

Do not label all trajectory-only information as useful.

### 17.2 Endpoint difference is not item-level causality

If trajectory succeeds and latest fails, the difference may contain many bundles. Use add-back tests to localize.

### 17.3 Avoid circular labels

Do not label:

```text
live operator = useful
deleted operator = useless
```

Those labels would merely teach the model the heuristic we already know.

Labels should come from behavior differences:

```text
with bundle vs without bundle
```

### 17.4 Avoid leakage from future information

Runtime features must be observable at checkpoint `t`.

Allowed as labels, but not features:

- final answer lineage;
- final task correctness;
- later repair success;
- future use of an operator.

### 17.5 Control position effects

Changing which bundles appear may also change where information appears in the prompt.

Use a deterministic rendering order for all context variants.

### 17.6 Control code availability

If trajectory includes code but latest strips code, failures may reflect missing code rather than missing history.

First implementation recommendation:

```text
strip code from both endpoint contexts
```

Then add a separate experiment:

```text
code as optional historical bundle
```

---

## 18. Minimal MVP Checklist

The minimal working version requires:

- [ ] checkpoint saver;
- [ ] trajectory context renderer;
- [ ] latest context renderer;
- [ ] token counter;
- [ ] endpoint evaluator;
- [ ] candidate bundle extractor;
- [ ] add-back intervention runner;
- [ ] removal intervention runner;
- [ ] bundle featurizer;
- [ ] label builder;
- [ ] classifier training script;
- [ ] runtime selector;
- [ ] baseline evaluation script.

The first publishable result requires:

- [ ] learned selector beats latest-only at matched token budget;
- [ ] learned selector reduces tokens compared with trajectory;
- [ ] learned selector beats recency-only selection;
- [ ] dataflow feature ablation improves prediction/performance;
- [ ] qualitative examples of positive and negative bundles.

---

## 19. Suggested Section 4 Mapping

This implementation maps to the paper section as follows.

### 4.1 Context construction as contrastive selection

Define trajectory and latest-dataflow context as two endpoints of the completeness/conciseness trade-off.

### 4.2 Historical evidence bundles

Define what information is present in trajectory but absent from latest-dataflow context.

### 4.3 Contrastive data collection

Explain endpoint comparison, four cases, add-back tests, and removal tests.

### 4.4 Dataflow-derived features

Describe type, temporal, liveness, DAG, execution, data-summary, task, and cost features.

### 4.5 Learned budgeted construction

Define the model, utility score, budgeted selection, coherence constraints, and final prompt rendering.

---

## 20. One-Sentence Summary

BobFlow learns context selection by contrasting full trajectory context with compact latest-dataflow context at the same replayable state, localizing useful or harmful historical bundles through add-back/removal tests, training a lightweight utility model over dataflow-derived features, and selecting positive-utility bundles under the remaining token budget.
