/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * System prompts for the Texera agent. Two modes:
 *
 * - `buildNativeModeSystemPrompt` — native mode: the model writes a program of
 *   `name = operator(...)` expressions over the catalog in `native/catalog.ts`
 *   (template `prompts/native-mode.md`; the operator reference is generated
 *   from the catalog, so prompt and parser cannot disagree).
 * - `buildCodeModeSystemPrompt` — code mode: every operator is one free Python
 *   function written through `createOrModifyOperator`. Includes a worked example.
 */

import { readFileSync } from "node:fs";
import { ContextMode, type AgentSettings, type LocalToolDialect } from "../types/agent";
import { nativeCatalogText } from "./native/catalog";

// The CODE-mode system prompt is a template in `prompts/code-mode.md` with two
// context-mode-dependent placeholders — `{{CONTEXT_FORMAT}}` and `{{EXAMPLE}}`.
// They are filled per `contextMode` (see `buildCodeModeSystemPrompt`) so the
// prompt always describes the format the agent actually receives: the LATEST
// `# Current Dataflow` snapshot, or the DELTA/FULL `# Agent Events` trajectory.
// Edit the .md files (template + fragments), not this TypeScript.
const CODE_MODE_TEMPLATE: string = readFileSync(new URL("./prompts/code-mode.md", import.meta.url), "utf8");
const rd = (name: string) => readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8").trimEnd();
const CONTEXT_FORMAT_FRAGMENTS: Record<"latest" | "delta", string> = {
  latest: rd("context-format.latest.md"),
  delta: rd("context-format.delta.md"),
};
const EXAMPLE_FRAGMENTS: Record<"latest" | "delta", string> = {
  latest: rd("example.latest.md"),
  delta: rd("example.delta.md"),
};
// Conditional section: only injected into the DELTA prompt when the context-window
// budget is enabled (compaction can fire), so the model is told its history may
// fold into a `# Dataflow (compacted)` stats deck. When the window is off the
// deck never appears, so the section is omitted to avoid dead tokens.
const COMPACTION_FRAGMENT: string = rd("compaction.delta.md");
/** Multi-turn state recall: describes the `# Prior Turns` catalogue and the
 *  `recallState` pull tool. Selected only when the tool is enabled, so control
 *  arms keep a byte-identical prompt. */
const RECALL_FRAGMENT: string = rd("recall.md");
/** Version-tree navigation (`resumeFrom`): selected only when that tool is
 *  enabled, so arms without it are never told to call a tool they lack. */
const RESUME_FRAGMENT: string = rd("resume.md");
/** Versioned mode: one catalog over an immutable version DAG, strict
 *  (operatorId, turn) references. REPLACES the recall fragment's layout
 *  description when on — the sections recall.md names do not exist here. */
const VERSIONED_FRAGMENT: string = rd("versioned.md");
/** Versioned mode + OPERATOR-LEVEL recall (v3): same catalog, recallState
 *  re-addressed to `"opId (turn N)"`, read-before-you-wire discipline. */
const VERSIONED_OPRECALL_FRAGMENT: string = rd("versioned-oprecall.md");
/** Session layout (non-versioned multi-turn): `# Session` of `## Turn N`
 *  entries + `# Your Task`. REPLACES the context-format fragment when on —
 *  the `# User Task` / `# Agent Events` / `# Current Dataflow` sections that
 *  fragment names do not exist under this layout. */
const SESSION_FRAGMENT: string = rd("session.md");
/** EVIDENCE PRINCIPLES (the `specAudit` knob): the versioned fragment with three
 *  ideas folded INTO the sections that already own them — verify what you report
 *  (Establishing foundations), know the cell each number came from and re-read the
 *  constraining sentences (Answering), and repair an operator built under a
 *  different reading (Every reference names its version).
 *
 *  Deliberately a REPLACEMENT, not an appended section. Appending restated things
 *  the base fragment already said, in a second voice, and in one place
 *  contradicted it — and it introduced vocabulary ("audit block", "check line")
 *  that exists nowhere else in the system, which the model then filled in as a
 *  form. Off by default; when on it supersedes VERSIONED_OPRECALL_FRAGMENT. */
const VERSIONED_PRINCIPLES_FRAGMENT: string = rd("versioned-oprecall-principles.md");
const RENDER_PREFS_FRAGMENT: string = rd("render-prefs.md");
/** Example variants demonstrating render prefs + investigation-operator
 *  cleanup, selected only when the feature is enabled so control arms keep a
 *  byte-identical prompt. */
const RENDER_PREFS_EXAMPLE_FRAGMENTS: Record<string, string> = {
  latest: rd("example.latest.render-prefs.md"),
  delta: rd("example.delta.render-prefs.md"),
};
// Code-in-snapshot (LATEST-only): the snapshot now renders each operator's code,
// so the context-format description and the worked example change (code blocks
// shown; short summaries). Selected only when the flag is on, so control arms
// keep a byte-identical prompt.
const CONTEXT_FORMAT_CODE_LATEST: string = rd("context-format.latest.code.md");
/**
 * The three Key Principles whose truth depends on whether the agent can see its
 * own code. They used to be unconditional prose in `code-mode.md`, written for
 * the code-blind case, and so contradicted every arm that shows code: the
 * context-format fragment said "your current code **is** shown" while the
 * principles said "code is not preserved in history", "but not its code", and
 * "your code is discarded after each step" — in one prompt.
 *
 * The gate is `noCode` (LATEST *without* code in the snapshot), NOT
 * `enableCodeInSnapshot`: DELTA carries operator code inline in every Action, so
 * DELTA arms were being told their code was gone while looking straight at it.
 * `noCode` is exactly `isCodeShownToAgent()` inverted, which is the same
 * predicate the createOrModifyOperator tool already uses to pick its `summary`
 * description — so prompt and tool schema now agree instead of contradicting.
 *
 * Not cosmetic: "the summary is your only record" drives verbose summaries that
 * restate code the agent can already read, which is wasted output on precisely
 * the arms that pay for the code twice.
 */
const PRINCIPLES_CODE_BLIND: string = rd("principles.code-blind.md");
const PRINCIPLES_CODE_VISIBLE: string = rd("principles.code-visible.md");
const EXAMPLE_CODE_LATEST: string = rd("example.latest.code.md");

/** A4 arm (sourceProvenanceHint): multi-file loads must carry a `__source_file`
 *  column. Grounded in the gold-solution trace dive (2026-07-28): per-file
 *  identity is a load-time fact erased by concat — deriving it later from a
 *  name-suffix regex was a 0%-pass failure mode on legal-hard-29 (n=26), while
 *  file-derived grouping passed 88-100%. Rendered as one principle bullet,
 *  directly after "Load all data before subsetting"; byte-identical when off. */
const PROVENANCE_FRAGMENT =
  "\n- **Multi-file loads must carry provenance**: when one loader reads MULTIPLE files (glob/listdir), add a `__source_file` column recording each row's file before concatenating (`df['__source_file'] = path`). Grouping identity often lives ONLY in the file name (one file per state/station/year) — a row's content cannot recover which file it came from after concat, and deriving that identity from a name-suffix regex instead of the file is a known failure mode. Downstream, group by `__source_file` (or a column derived from it) whenever the question asks per-<unit> and <unit> matches the file layout.";

export function buildCodeModeSystemPrompt(
  contextMode: ContextMode = ContextMode.LATEST,
  compactionEnabled = false,
  _legacyInspectEnabled = false,
  renderPrefsEnabled = false,
  codeInSnapshotEnabled = true,
  sourceProvenanceHint = false,
  recallEnabled = false,
  resumeEnabled = false,
  versionedEnabled = false,
  sessionEnabled = false,
  opRecallEnabled = false,
  specAuditEnabled = false
): string {
  const key = contextMode === ContextMode.DELTA ? "delta" : "latest";
  // The only code-blind configuration: LATEST without code in the snapshot.
  // DELTA always shows code per event, so it is never code-blind.
  const noCode = key === "latest" && !codeInSnapshotEnabled;
  const compaction = key === "delta" && compactionEnabled ? `\n${COMPACTION_FRAGMENT}\n` : "";
  // Versioned mode supersedes the recall fragment: recall.md describes the
  // `# Current Turn` / `# Dataflow` layout, which does not exist under the
  // versioned catalog. The recallState tool itself remains available either way.
  const recall = versionedEnabled
    ? `\n${opRecallEnabled ? (specAuditEnabled ? VERSIONED_PRINCIPLES_FRAGMENT : VERSIONED_OPRECALL_FRAGMENT) : VERSIONED_FRAGMENT}\n`
    : recallEnabled
      ? `\n${RECALL_FRAGMENT}\n`
      : "";
  const resume = resumeEnabled ? `\n${RESUME_FRAGMENT}\n` : "";
  const renderPrefs = renderPrefsEnabled ? `\n${RENDER_PREFS_FRAGMENT}\n` : "";
  // Context format tracks the LAYOUT the agent is fed, which is a separate axis
  // from code visibility: DELTA is always `# Agent Events`, LATEST is
  // `# Current Dataflow` with or without the per-operator Code: blocks.
  // The turn-grouped layouts REPLACE this fragment: under `# Session` the
  // legacy sections don't exist (session.md describes the layout), and under
  // the versioned `# Catalog` the layout lives in versioned.md (injected via
  // the recall slot above), so the format slot is left empty rather than
  // describing sections the agent will never see.
  const contextFormat = versionedEnabled
    ? ""
    : sessionEnabled
      ? SESSION_FRAGMENT
      : key === "delta"
        ? CONTEXT_FORMAT_FRAGMENTS.delta
        : noCode
          ? CONTEXT_FORMAT_FRAGMENTS.latest
          : CONTEXT_FORMAT_CODE_LATEST;
  const example = renderPrefsEnabled
    ? RENDER_PREFS_EXAMPLE_FRAGMENTS[key]
    : key === "delta"
      ? EXAMPLE_FRAGMENTS.delta
      : noCode
        ? EXAMPLE_FRAGMENTS.latest
        : EXAMPLE_CODE_LATEST;
  return CODE_MODE_TEMPLATE.replace(
    "{{CODE_VISIBILITY_PRINCIPLES}}",
    noCode ? PRINCIPLES_CODE_BLIND.trimEnd() : PRINCIPLES_CODE_VISIBLE.trimEnd()
  )
    .replace("{{CONTEXT_FORMAT}}", contextFormat)
    .replace("{{PROVENANCE}}", sourceProvenanceHint ? PROVENANCE_FRAGMENT : "")
    .replace("{{COMPACTION}}", compaction)
    .replace("{{INSPECT}}", "")
    .replace("{{RECALL}}", recall + resume)
    .replace("{{RENDER_PREFS}}", renderPrefs)
    .replace("{{EXAMPLE}}", example)
    .replace(/\n{3,}/g, "\n\n");
}

// ============================================================================
// NATIVE mode: a program of operator expressions over the catalog in
// native/catalog.ts. Template in prompts/native-mode.md; the operator
// reference is generated from the same definitions the parser validates
// against, so prompt and validator cannot drift.
// ============================================================================
const NATIVE_MODE_TEMPLATE: string = rd("native-mode.md").replace(/^<!--[\s\S]*?-->\s*/, "");

export interface NativePromptLayoutOptions {
  versioned?: boolean;
  session?: boolean;
  recall?: boolean;
  messageLayout?: AgentSettings["messageLayout"];
  /** Multi-task: completed tasks are shown as question and answer, followed by the catalog. */
  taskCatalog?: boolean;
  /** Multi-task: each completed task's tables are retained. */
  taskHistory?: boolean;
  /** The `restore` step and the four state gestures are explained. */
  taskRestore?: boolean;
  analysisState?: boolean;
  taskEfficiency?: boolean;
  /** The graph is presented as versioned definitions; `supersede`, `bind`, `explain` and `compare` are explained. */
  definitionRegistry?: boolean;
  /** `dataflowReasoning`: the tool takes a required `reasoning` argument, written first. */
  reasoning?: boolean;
  /** Which evidence kinds observed results carry; the prompt documents exactly those. */
  dataEvidence?: boolean;
  flowEvidence?: boolean;
}

/** Stated once, in the stable head of the prompt, so the explanation costs one
 * cached prefix for the whole session. The agent cannot use a reference form
 * nobody told it about: without this it used task history 14 times in 114 turns. */
const TASK_ENTRIES_LAYOUT =
  '\n\nThis is one session of numbered tasks. Each completed task appears once, as an entry: the request; the changes it made to the dataflow, net over the whole task and grouped by the call that produced each one (added, modified, restored or deleted operators, each as the statement you wrote with its doc and function code, its row count and full column list, `missing:` counts and the `values:` of columns with few distinct values over the whole table, `⚠ EMPTY` when a table came out with no rows, and the task whose definition it replaced); the rows of the tables it read (`Tables read`: a table of at most 20 rows in full, a larger one by its first 3 rows, and `same rows as shown in task N` when nothing changed); and the answer with the tables it was read from. Entries never change. `# Tables now` then lists every current table with the task that created it, the tasks that changed it, and `recomputed tN` when something upstream changed after the rows an entry shows, and flags tables that are empty or failed right now. A table\'s current definition is in the latest entry that lists it. The entries are a catalog of everything built so far, not all of its data: every table in `# Tables now` can be observed. When an entry already shows the number you need, read it there. When you need rows it does not show (the rest of a large table, a table read without its rows, one marked `recomputed`), observe that table, for example `dataflow(edits="", observe=["fractional_scan_report"])` for the rest of the task 5 ranking beyond its first rows; it shows the current rows without executing anything.';
/** How a task is worked, stated once. The steps are DSGym's, which answers
 * the same benchmark with two model calls per turn; the last sentence is the
 * dataflow's own repair: one reassignment recomputes everything downstream. */
const TASK_METHOD =
  "\n\nWork each task as a careful analyst. First understand the request: what one row means, which rows are in scope, and the units and rounding the answer needs. Plan the steps before writing statements, and change the plan when a table contradicts it. Later tasks mostly build on tables whose columns you have already seen, so feel free to add several operators in one call whenever you are comfortable with how they fit together; this usually makes the work go faster. Observe only the tables whose results you need, usually the ones the answer is read from. Answer only when the observed tables support every number, and try another approach when they do not. Keep each analytical choice a later task may revise in its own operator (a population filter, a threshold, a weighting, one component of a score) and build composites such as a score or a ranking from those operators rather than inside one function: then a revision is one reassignment, and an earlier version stays addressable by name and task. When a request corrects or refines what an earlier task defined, reassign that id so everything built on it recomputes, rather than building a copy beside it.";
/** With entries, the `reasoning` of each call is what names its step: completed
 * tasks group their changes under the calls that produced them. */
const TASK_STEPS =
  " Completed tasks list the calls that changed the dataflow in order as `Step 1:`, `Step 2:`, each with its `reasoning` and the changes it produced, so write `reasoning` for a reader coming back in a later task too; when a call corrects an earlier definition, say what was wrong.";
const TASK_SESSION_LAYOUT = "\n\nThis is one session of tasks, numbered from 1 in the order they were asked.";
const ANALYSIS_STATE_METHOD = `

Maintain an executable analysis across tasks. The bounded memory shows selected exact requests, table cards and exact function definitions at the start of the task. Reuse visible shared functions by name. Retrieve missing requirements with dataflow(recall=[N]). Read exact current code and bindings with inspect=["table_or_function"], and values with observe=["table"]. Inspection and recall do not execute. Do not guess an omitted formula or historical answer.

Make stable identities, cleaned data, reusable score components, and parameter tables explicit. A coherent process may use ordinary pandas internally; do not create dozens of tiny operators just to spell out Python. Pass every data dependency as a table input. Keep units, denominator population, null policy and adjustable coefficients in named definitions or parameter tables. Score functions should return their component contributions alongside their total, so an explanation reads the same calculation rather than rebuilding it. Validate keys, units, input-file coverage and component sums where the public request supplies a check; use assertions in a validation process before its consumers. An empty result is not automatically an error.

Choose a useful table grain before materializing large or wide sources. A zero-input process may read immutable source files with pandas and return a coherent cleaned or aggregated analysis table; its doc should identify the files and the returned row meaning. Keep that loader reusable and retain keys and components needed downstream. This avoids transferring large raw tables merely to reduce them immediately. Inspect file previews and schemas first; pass existing analysis tables as explicit inputs instead of reloading them inside downstream functions.

Shared defs persist with the current tables that use them. Redefine a shared helper once to correct all current consumers; downstream tables recompute. Correct the earliest shared definition when later evidence contradicts an assumption. Apply persistent cleaning, imputation and definition changes to the canonical columns used downstream. Keep raw values and temporary candidates under distinct names. Historical outputs stay immutable. Definitions belonging to a fork are independent of later shared-def edits. A def with no table consumer is not retained.

For a persistent update, reassign the same parameter or component table. For a temporary scenario, create a new parameter table and fork the output with explicit boundary replacements in the SAME call, then observe it. Example: edits="trial_policy = parameters(weight=0.25)"; fork=[{"operator":"leaders","as":"trial_leaders","bindings":{"policy":"trial_policy"}}]; observe=["trial_leaders"]. This copies only the affected paths and preserves the current default. Current forks share unchanged live input tables. Adding task=N reuses the definition from completed task N and pins other inputs to saved values. For an old-membership/current-values question, first project the old cohort to keys only, join those keys to current measurements, and bind that resulting table; never accidentally consume old measurement columns. Use at(table, task=N) when the requested object is an old value rather than a computation to rerun.

Batch the required edits and observations. Inspect only definitions you need to change or bind. A read-only request can use an already correct result without any edit. Code or model uncertainty is not repaired by guessing a reference value: verify against the public request and source data.
`;
/** The four ways analytical state evolves, each as one dataflow gesture. */
const TASK_STATE_GESTURES =
  ' Every table\'s output at the end of each task is saved, so state evolves in four ways. To make a revision the new default, reassign the same id: everything downstream recomputes. For a one-off alternative, build a new id from the current tables and leave the default alone. To work under an earlier version, use the tool\'s `restore=[{"operator": name, "task": N, "as": new_id}]`: it rebuilds that table as defined at the end of task N under the new id, shares upstream tables that are unchanged since then, copies the ones that changed as `<name>_t<N>`, and its observation says whether the result matches the saved table. To make an earlier version current again, restore with `as` equal to the same id. Read the version\'s definition in its entry before restoring.';

/** What evidence lines are and how to use them, for the kinds that are enabled.
 * Nothing is added when both are off: the prompt never describes lines the
 * agent will not see. */
export function nativeEvidenceText(options: { dataEvidence?: boolean; flowEvidence?: boolean }): string {
  const data = options.dataEvidence === true;
  const flow = options.flowEvidence === true;
  if (!data && !flow) return "";
  const parts = [
    "Evidence lines follow the rows. They are meta-level information: measurements the engine took about the table and about the operator that produced it, not rows of the data and not an answer. Each kind has a character budget of its own and never replaces rows. Use them to decide your next step: whether the table is the one you meant to build, whether a parse, filter, join or grouping did what you intended, and what to check or fix before building on it.",
  ];
  if (data)
    parts.push(
      "`Data measurement` lines describe the observed table itself: per column the null, non-null and distinct counts, the value range and the most frequent values; per table, duplicate rows and all-null rows or columns. `full=N rows` covers the whole output; `partial prefix=n/N rows` covers only the processed prefix. A value list marked non-exhaustive is not the complete set, and unknown is not zero. They are left out when the complete table is shown, because the rows already say it. Typical uses: a key with fewer distinct values than rows is not unique, so check it before a lookup join; nulls in a column you will aggregate change the denominator; a range or value list that does not fit what the column should hold (years outside the task's span, numbers stored as text, spelling variants of one category) means the scan or an earlier step needs fixing."
    );
  if (flow)
    parts.push(
      "`Flow measurement` lines describe what the operator did to its inputs, from counters the engine recorded: `Filter kept=135/1388` means 135 of 1,388 input rows survived; an aggregate reports its groups and each reducer's non-null count, which is its denominator; a join reports matched output rows, matched input rows and matched keys separately; a scan reports the files it read and the rows it parsed. `Flow guarantee` states the operator's contract, and for filter, map and process it starts with your `doc`. `Flow upstream` summarizes how an ancestor table was computed. Typical uses: a filter that kept almost nothing or almost everything, or a join that matched few keys, usually means a wrong predicate, key or value spelling; a reducer whose denominator is below the row count skipped nulls."
    );
  if (data && flow)
    parts.push(
      "With both kinds, flow lines say how many rows each step kept, matched or grouped, and data lines say what the rows now contain. Read them together: a table can have the right row count with wrong values, or the right values in the wrong number of rows."
    );
  parts.push(
    "No evidence line proves that your population, key or formula is the one the task intends" +
      (flow ? "; a process reports only its row counts and its `doc`." : ".")
  );
  return "\n\n" + parts.join("\n\n");
}

/** The paragraph that introduces the `reasoning` argument when it is enabled. */
const REASONING_PARAGRAPH =
  "\n\nWrite `reasoning` first: one or two sentences on why this call and what you expect the observed tables to show, such as a row count, the columns, or a value you can check. It stays in your history with the call. When the observation arrives, compare it with your expectation. A mismatch (a column name that looks like a value, a missing year, an unexpected row count) means an earlier step is wrong: fix that step instead of adapting later steps to it.";

/** The native-mode system prompt for a context mode and message layout. */
export function buildNativeModeSystemPrompt(
  contextMode: ContextMode = ContextMode.DELTA,
  options: NativePromptLayoutOptions = {}
): string {
  const delta = contextMode === ContextMode.DELTA;
  const messageLayout =
    options.messageLayout ?? (options.versioned || options.session ? "turnSplit" : delta ? "native" : "opSplit");
  const inlineInspection = delta && messageLayout === "native";
  const contextLayout = options.versioned
    ? "Your multi-turn context is a `# Catalog` of `## Turn N` entries: prior tasks, their dataflow changes, and answers, followed by the current task and step observations. LATEST collapses current execution results into `### Dataflow`; DELTA keeps event observations. A table name refers to its current version. Answer only the current turn's task."
    : options.session
      ? "Your multi-turn context groups requests and work under `# Session` / `## Turn N`, with a `# Your Task` directive for the current turn. Earlier tables remain live by name. DELTA retains step observations; LATEST shows the current dataflow. Answer only the current turn's task."
      : delta
        ? messageLayout === "native"
          ? "After `# User Task`, your history is the tool-call transcript. Each dataflow tool result contains its receipt and an `Observation`: what changed, the tables you asked to see, and failures. A cached observation may mention an unchanged operator. The most recent event that changed an operator determines its current definition."
          : "After `# User Task`, `# Agent Events` contains each action and its `Observation`: what changed, the tables you asked to see, and failures. The most recent event that changed an operator determines its current definition."
        : "After `# User Task`, `# Current Dataflow` shows every operator's definition as you wrote it, its input row counts, and the results you asked to see. Earlier execution events are collapsed into this snapshot. Current compilation and execution failures remain visible.";
  const snapshotProgress = delta
    ? ""
    : " These are already executed outcomes of your earlier actions, not a proposed workflow. The compact `Last completed action in this task` receipt confirms which call just completed; it does not assert that every operator succeeded. Do not repeat a completed call merely because its tool-call history is collapsed. A visible result body has already been observed; if it already answers the task, answer directly without another tool call." +
      (messageLayout === "opBlock"
        ? " A block showing only `Result: executed, N rows` has never been observed; observe it when its contents are necessary. Do not re-observe an operator whose body is already in its block."
        : " Only a `result not requested` receipt needs a cached observe when its contents are necessary.") +
      " A saved inspection likewise completes that diagnostic pull; read it and proceed instead of repeating the failed edit.";
  const scope = delta
    ? "Each event preserves its own observe choices and result version. A later request does not reveal an earlier hidden table or rewrite the definition echoed by an earlier failure."
    : messageLayout === "opBlock"
      ? "Each operator block carries its definition and the result that definition produced. An observed result stays in its block when you go on to observe something else; it is replaced only when that operator is redefined or re-executed, and an operator you have never observed shows its row count alone. Errors bypass result hiding."
      : "Detailed successful tables follow the most recent call's `observe` list. Other operators keep their definitions and compact result receipts. Errors bypass result hiding.";
  const recall = options.recall
    ? "\n`recallState` retrieves an earlier turn's saved task, answer, and operator evidence without execution; use its advertised schema when prior-turn evidence is needed."
    : "";
  const taskLayout = options.analysisState
    ? options.taskEfficiency
      ? TASK_ENTRIES_LAYOUT +
        ANALYSIS_STATE_METHOD.replace(
          "The bounded memory shows selected exact requests, table cards and exact function definitions at the start of the task.",
          "Immutable completed task entries retain requests, code, observations and answers; the frozen current index identifies later replacements and upstream changes. Read these entries before requesting more history. Identical code, schemas and displayed rows within an entry are referenced once; this does not assert equality of the full underlying tables."
        )
      : ANALYSIS_STATE_METHOD
    : (options.taskCatalog ? TASK_ENTRIES_LAYOUT : options.taskHistory ? TASK_SESSION_LAYOUT : "") +
      (options.taskHistory && options.taskRestore ? TASK_STATE_GESTURES : "") +
      (options.taskCatalog || options.taskHistory ? TASK_METHOD : "") +
      (options.taskCatalog && options.reasoning ? TASK_STEPS : "");
  return NATIVE_MODE_TEMPLATE.replace(
    "{{DATAFLOW_SIGNATURE}}",
    options.reasoning ? "`dataflow(reasoning, edits, delete, observe)`" : "`dataflow(edits, delete, observe)`"
  )
    .replace("{{REASONING_FIELD}}", options.reasoning ? REASONING_PARAGRAPH : "")
    .replace("{{EVIDENCE_TITLE}}", options.dataEvidence || options.flowEvidence ? ", evidence" : "")
    .replace("{{EVIDENCE}}", nativeEvidenceText(options))
    .replace(
      "{{FUNCTION_LIFETIME}}",
      options.analysisState
        ? "Operator ids and shared functions persist across calls. Reuse a stored def by name; redefining it updates all current consumers automatically. Forked definitions are independent."
        : "Operator ids persist across calls; functions do not. A `def` exists only in the call whose `edits` contain it, and each operator keeps its own copy of the function it was given. Never refer to a function from an earlier call by name: to use it again, including when you revise the operator that uses it, write its `def` again in the same call."
    )
    .replace(
      "{{FUNCTION_REFERENCE}}",
      options.analysisState
        ? "Reuse stored functions by name. Redefine a shared helper when correcting the common calculation; use a new function name for an independent definition."
        : "Only functions defined in the same `edits` can be referenced, so a later call that needs the function again repeats its `def`."
    )
    .replace(
      "{{PROCESS_SCOPE}}",
      options.analysisState
        ? "**process** is a reusable analysis component. It may group coherent pandas transformations. Its function takes one DataFrame per declared input and returns one DataFrame with scalar cells; with no inputs it takes no parameters and loads source files itself. Use explicit inputs for existing data and policy tables, and separate definitions for choices that can change independently."
        : "**process** is for what no other operator expresses: custom parsers, binary or fixed-width formats, statistics and fitting, report layouts walked line by line. `f` takes one pandas DataFrame per input, in order, and returns one DataFrame with unique string column names, scalar cells and timezone-aware datetimes; with no inputs it takes no parameters and loads data itself. Do not use process for filtering, deriving columns, grouping or joining."
    )
    .replace(
      "{{COMPONENT_SCOPE}}",
      options.analysisState
        ? "**Reusable components.** Expose stable analytical boundaries and mutable parameters. Reuse shared functions; preserve intermediate tables that later analysis needs."
        : "**One operator, one operation.** Load, filter, derive, join and aggregate in separate operators, so every intermediate table can be observed and fixed on its own. Do not fold several steps into one map or process."
    )
    .replace("{{OPERATOR_CATALOG}}", nativeCatalogText({ analysisState: options.analysisState }))
    .replace(
      "{{CONTEXT_LAYOUT}}",
      contextLayout +
        snapshotProgress +
        taskLayout +
        (options.taskEfficiency ? TASK_EFFICIENCY_METHOD : "") +
        (options.definitionRegistry ? DEFINITION_REGISTRY_METHOD : "")
    )
    .replace("{{OBSERVATION_SCOPE}}", scope)
    .replace("{{RECALL_TOOL}}", recall);
}

/** The state of a session read as versioned definitions. The vocabulary is the
 * user's: "the equal-weight form introduced earlier, not the currently active
 * weighted form", "roll back only the adopter side", "keep the boundary now in
 * effect". Every version is a table, so a request that names versions is a
 * binding, not a rebuild; a comparison is a compare operator, not a function. */
const DEFINITION_REGISTRY_METHOD = `

The task starts from \`# Definitions\`: the current graph read as analytical definitions with versions. A definition is a table the analysis depends on (a cleaned sample, a cohort, a grouping rule, a score, a parameter table, a fitted result). It gains a version when you reassign its id (the earlier version keeps its saved values, readable with at(name, task=N)) or when you declare a new table as its successor with \`supersede={"new_table": "old_table"}\` in the call that creates the new table. The ACTIVE version is what current tables read. Entries show each function by its \`def\` signature only: call a function by name to reuse it, and \`inspect=["name"]\` returns its exact body when you need to change it.

Read the request in this vocabulary. "The earlier form", "the initial definition", "the version introduced in task N", "the narrow boundary" name an earlier version; "the currently active", "now in effect", "keep unchanged" name the active one. Then act on versions, not on code:
- Update (the request revises a definition for good): reassign the same id, or build the new table and supersede the old one, so everything downstream recomputes or follows the successor.
- Counterfactual or Rollback (the request wants an existing result under another version of one or more definitions, without changing the default): \`bind=[{"target": "resilience_score", "as": "narrow_resilience", "versions": {"size_composites": "v1"}}]\`. A version is \`v2\`, \`t11\` (the version active at task 11), \`active\`, or a table id. The runtime rebuilds only the paths from those versions to the target under the new name, keeps the default untouched, and reports what it bound. Observe the new table in the same call. Composition is one bind with several definitions.
- Comparison ("compare with the earlier ranking", "which rows moved", "does the winner change"): \`d = compare(new_table, old_table, keys=["prof"])\` gives one row per key with \`in_a\`, \`in_b\`, \`<col>_a\`, \`<col>_b\`, \`<col>_delta\`; aggregate or filter it. Never copy numbers from an earlier observation into code and never re-derive an earlier version in a new function when the version exists as a table.
- Provenance ("which definition produced this", a result that looks inconsistent): \`explain=["table"]\` prints the lineage with the version of every definition it read and flags ancestors that read a superseded version.

Keep definitions as tables: put a population into its own table (keys and the columns later tasks need) before reporting on it; put adjustable numbers into a parameters(...) table passed as an input instead of literals inside functions; when a process fits a model, return its row-level predictions or error flags as a table, and put the one-row summary in a separate table, so a later task can reuse the exact fit. When a later request contradicts an earlier definition (a unit, a ratio direction, a population), correct that definition where it was established; the graph recomputes its consumers.
`;

const TASK_EFFICIENCY_METHOD = `

Work from the current request and the smallest sufficient existing dependency chain. Keep fitted predictions, populations and component contributions as tables so reporting and explanations reuse their exact computation. Distinguish a complete population from a top-k or sampled display before choosing a denominator. Old entries record historical facts; the current index and observations identify replacements. Old failures outside the requested dependency chain do not require a repair.

Before a call, check the tool contract: process(A, B, fn=f, doc="...") uses positional table inputs and a function with exactly one parameter per input; a zero-input loader has zero parameters. Shared functions persist in this mode. Changing a doc or a binding does not change a function body. When revising a formula, actually redefine the function (or choose the requested historical definition) and check the resulting component values.

Inspect or recall only a missing definition or requirement; do not search batches of past tasks already visible in the entries. Inspect accepts at most six names and recall at most three task numbers. An identical response already visible in this task is referenced instead of repeated. Prefer the supplied file inventory and source documentation when locating a new source. Batch known edits and observe the final table plus only intermediate checks needed to validate it. Project needed answer columns before observing a wide result; a small complete answer table avoids repeated missing-row reads.

On an error, use its stage and failing line to identify the cause. After two unsuccessful repairs of the same calculation, first check its input columns, population counts, null policy and upstream definition. Diagnose an unexpected empty population before adding null fallbacks. Preserve working upstream tables and change the smallest faulty component instead of regenerating data loading, fitting and reporting together. For an unchanged infrastructure failure, check available diagnostics before another identical retry; rewriting a formula does not repair worker health. Keep useful analytical verification. Before answering, check that the observed fields answer the CURRENT request, with its population, units and rounding, rather than a previous task.
`;

// ---------------------------------------------------------------------------
// Local-react (in-house local LLM) system prompts — one per tool-call dialect.
//
// The local LLM's tool catalog + output-format instructions are baked into its
// system prompt (no `tools` on the wire; the driver parses the model's text).
// The two dialects pair a prompt with the context renderer that prompt
// describes, so the model's stated input format matches what it actually sees:
//   - "qwen-xml"  — the CODE-mode body (`code-mode.md`, shared with the
//     vercel-tool-use driver) + the `<tools>`/`<tool_call>` appendix
//     (`local-qwen-tools.txt`), composed below. It describes the
//     `# User Task` / `# Current Dataflow` context → paired with the SDK
//     assembler `assembleContext` (server.ts).
//   - "react-text" — the standalone `local-react.txt` (plain-text tool list +
//     `Thought / Action / Action Input / Observation`, down to `Begin!`). It
//     describes the `# Event N` context → paired with `assembleLocalReactContext`.
//
// The model uses the ChatML chat template: the gateway wraps this text as
// `<|im_start|>system\n…<|im_end|>` and the per-turn context as
// `<|im_start|>user\n…<|im_end|>` automatically when the driver sends
// role-tagged messages — so NO framing/BOS tokens belong in these files.
// ---------------------------------------------------------------------------
// `qwen-xml` is NOT a standalone file: it is the CODE-mode prompt (the single
// source of truth in `code-mode.md`, shared with the vercel-tool-use driver)
// plus the XML tool-call appendix in `local-qwen-tools.txt` (the `# Tools` /
// `<tools>` catalog + `<tool_call>` output-format instructions). Composing at
// load time keeps the body in lock-step with `code-mode.md` — no drift — and
// is why the qwen-xml dialect is paired with the SDK context assembler
// (`assembleContext`, server.ts): `code-mode.md` describes the `# User Task` /
// `# Current Dataflow` context that assembler renders, so prompt and context
// agree. `react-text` keeps its standalone `# Event N` prompt + the
// `assembleLocalReactContext` renderer.
const QWEN_TOOL_APPENDIX: string = readFileSync(new URL("./prompts/local-qwen-tools.txt", import.meta.url), "utf8");
const REACT_TEXT_SYSTEM_PROMPT: string = readFileSync(new URL("./prompts/local-react.txt", import.meta.url), "utf8");
/**
 * Returns the local driver's system prompt for the given tool-call dialect.
 * `react-text` is standalone; `qwen-xml` is the CODE-mode body (mode-aware, so
 * it matches the SDK context assembler) plus the XML tool-call appendix.
 */
export function buildLocalReactSystemPrompt(
  dialect: LocalToolDialect,
  contextMode: ContextMode = ContextMode.LATEST,
  compactionEnabled = false
): string {
  if (dialect === "react-text") return REACT_TEXT_SYSTEM_PROMPT;
  return `${buildCodeModeSystemPrompt(contextMode, compactionEnabled).trimEnd()}\n\n${QWEN_TOOL_APPENDIX}`;
}
