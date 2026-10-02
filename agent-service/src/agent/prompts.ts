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
 * - `buildNativeModeSystemPrompt` — native mode: the model writes a set of
 *   `name = operator(...)` expressions over the catalog in `native/catalog.ts`
 *   (template `prompts/native-mode.md`; the operator reference is generated
 *   from the catalog, so prompt and parser cannot disagree).
 * - `buildCodeModeSystemPrompt` — code mode: every operator is one free Python
 *   function written through `createOrModifyOperator`. Includes a worked example.
 */

import { readFileSync } from "node:fs";
import {
  ContextMode,
  type AgentSettings,
  type LocalToolDialect,
  type RetrievalSettings,
  type RetrievalView,
} from "../types/agent";
import { graphCatalogText } from "./native/catalog";
import { availableRetrievalViews, EVIDENCE_CHAR_LIMIT, nativeResultTransportLimit } from "./native/retrieval";

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
// NATIVE mode: named operator expressions over the catalog in
// native/catalog.ts. Template in prompts/native-mode.md; the operator
// reference is generated from the same definitions the parser validates
// against, so prompt and validator cannot drift.
// ============================================================================
const NATIVE_MODE_TEMPLATE: string = rd("native-mode.md").replace(/^<!--[\s\S]*?-->\s*/, "");

export interface NativePromptLayoutOptions extends RetrievalSettings {
  maxOperatorResultCharLimit?: number;
  maxResultRows?: number;
  versioned?: boolean;
  session?: boolean;
  recall?: boolean;
  messageLayout?: AgentSettings["messageLayout"];
  /** `dataflowReasoning`: the tool takes a required `reasoning` argument, written first. */
  reasoning?: boolean;
  /** Which evidence kinds observed results carry; the prompt documents exactly those. */
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  /** `nativeChecks`: operators carry `check:` lines; the prompt says what they are. */
  checks?: boolean;
  stateHistory?: boolean;
}

/** Explain only the evidence families enabled for this agent. */
export function nativeEvidenceText(options: { dataEvidence?: boolean; flowEvidence?: boolean }): string {
  const parts: string[] = [];
  if (options.dataEvidence)
    parts.push(
      'Statistics are computed independently of the displayed records, with bounded collection and display budgets. Data measurement lines report null and distinct counts, ranges, and value frequencies. Check row and column coverage: a partial prefix or non-exhaustive list does not describe every value. With full row coverage, a column\'s "nonnull values" list and other=0 enumerate all its nonnull values, even when records are partial. This does not establish row order or pair values across columns. Unknown counts are not zero. Null counts exclude text markers such as "NA" until you explicitly normalize them. Raw-line previews have no parsed-column statistics; complete small tables omit redundant statistics. Before reducing a table, check the values of eligibility fields and the valid count of the measured column; project and retrieve those columns if their statistics are omitted.'
    );
  if (options.flowEvidence)
    parts.push(
      "Retrieval automatically adds selected flow evidence about the result and the intermediate operators that produced it, even when you did not request their tables. Flow measurement lines describe conversion failures, join matching, filter retention, reducer denominators and Window offsets/boundary nulls; flow guarantees describe operator contracts. Cast failed-value examples and Join unmatched-key examples or duplicate-key examples show bounded, first-encountered values with counts. Examples may be clipped and are not an exhaustive distribution. Compare the measurements with the task's population, key identity and calculation. Repair a transformation or justify the exclusions before using its aggregate. Evidence refers to the producing versions. Custom functions have unknown internal row/column mapping."
    );
  if (parts.length)
    parts.push(
      "These measurements have separate display budgets. Use them to check the computation against the task; they do not establish that the chosen population or formula is correct."
    );
  return parts.length ? "\n\n" + parts.join("\n\n") : "";
}

export function nativeRetrievalText(options: NativePromptLayoutOptions = {}): string {
  const views = availableRetrievalViews(options);
  const sampleLimit = options.maxOperatorResultCharLimit ?? 2000;
  const rows = options.maxResultRows ? ` and at most ${options.maxResultRows} records` : "";
  const descriptions = {
    full: `- \`full\`: records up to ${nativeResultTransportLimit(options)} characters. For small final results or decisions requiring individual records; a capped view remains partial.`,
    sample: `- \`sample\`: schema and example records, bounded by ${sampleLimit} characters${rows}. For layout and type checks.`,
    sample_stats: `- \`sample_stats\`: the same small record view (${sampleLimit} characters${rows}) plus up to ${options.dataEvidenceCharLimit ?? EVIDENCE_CHAR_LIMIT} characters of data statistics. Use it to check missingness, ranges, distinct counts and value frequencies.`,
  };
  return [
    "Choose the `view` on every Retrieve. Available views:",
    ...views.map(v => descriptions[v]),
    ...(views.includes("sample_stats")
      ? [
          "For a large parsed table, start with `sample_stats` when checking data quality or distributions. Project to relevant columns if a wide table hides the needed statistics.",
        ]
      : []),
    ...(views.includes("full")
      ? [
          "For large tables, project, filter or aggregate before requesting `full`. Explain why individual records are needed.",
        ]
      : []),
    "Views reuse results without execution. Samples use retained records, not a random sample. Compute searches, comparisons and aggregates over the full data in the graph.",
    "A complete preview is still only a preview of the source. Remove `preview` and execute before computation. Use `preview=1` for workbook headers; larger previews add data rows.",
    ...(options.flowEvidence
      ? [
          `Automatic flow evidence has a separate ${options.flowEvidenceCharLimit ?? EVIDENCE_CHAR_LIMIT}-character budget in every view.`,
        ]
      : []),
  ].join("\n");
}

/** Synthetic operator examples only. No dataset, benchmark, answer or domain
 * convention is needed to explain choosing a view or checking a contract. */
export function nativeRetrievalExamples(options: NativePromptLayoutOptions = {}): string {
  const views = availableRetrievalViews(options);
  // The basic worked graph already previews a source and reads a small final
  // table. Add the evidence examples only for sessions exposing evidence.
  if (!views.includes("sample_stats") && !options.flowEvidence) return "";
  const call = (reasoning: string, actions: unknown[]) =>
    "```json\n" + JSON.stringify({ reasoning, actions }, null, 2) + "\n```";
  const retrieve = (operator_id: string, view: RetrievalView) => ({ type: "retrieve", operator_id, view });
  const parts = ["### Choosing a result view", "Each example below is an independent choice for an existing result."];
  if (views.includes("sample"))
    parts.push(
      "Check column names and example formatting:",
      call("Check the parsed table's layout.", [retrieve("source", "sample")])
    );
  if (views.includes("sample_stats"))
    parts.push(
      "Check the selected population and measurement validity before reducing it:",
      call("Check the selected rows and valid values.", [retrieve("eligible", "sample_stats")]),
      'For a numeric column named value, full-coverage null=4/20 means mean("value") uses 16 nonnull values. Check whether excluding those four nulls matches the task\'s missing-value policy. If the task needs only a set of values, an untruncated nonnull-values list with full row coverage and other=0 establishes that set; further records are needed for row associations or order.'
    );
  if (views.includes("full"))
    parts.push(
      "Read the associations between identifiers and values in a small final table:",
      call("Read each identifier and its corresponding result.", [retrieve("final_rows", "full")])
    );
  if (options.flowEvidence) {
    const view = views.includes("sample_stats") ? "sample_stats" : views.includes("sample") ? "sample" : views[0];
    parts.push(
      "### Acting on flow evidence",
      'Suppose the task requires decimal measurements and the graph is source -> typed -> total. A Cast reports conversion failures=2/20 and failed-value examples "1.5" × 1; "2.5" × 1. The current integer conversion conflicts with that requirement. Resolve the finding before using the aggregate:',
      call("Use the decimal type required by the task and recompute the dependent result.", [
        { type: "edit", changes: "update operator typed: cast(value=float64)" },
        { type: "execute" },
        retrieve("total", view),
      ]),
      'For a Join, unmatched-key examples ["A 1"] and ["A1"] suggest checking key representation. Normalize only if the source definitions establish the same identity. Duplicate-key examples require checking the intended join cardinality; duplicates can be legitimate.',
      'For a Window, lag("value", offset=3) with boundary nulls=3/20 in one partition describes three unavailable predecessors. Check the resolved offsets against the requested relationship. A row offset does not establish regular time intervals.'
    );
  }
  return parts.join("\n\n");
}

export function buildNativeModeSystemPrompt(
  contextMode: ContextMode = ContextMode.DELTA,
  options: NativePromptLayoutOptions = {}
): string {
  const context = options.versioned
    ? "Your context lists prior turns in a catalog, followed by the current task and results. Table names refer to their current versions. Answer the current task."
    : options.session
      ? "Your context groups work by user turn. Earlier tables remain available by name. Answer the current task."
      : contextMode === ContextMode.DELTA
        ? "Your history contains earlier calls and their results. Each result describes the graph at that point; later edits may have changed it. Use inspect when you need the current definition."
        : "Your context shows the current dataflow and its available results. The latest action receipt records what just completed. Earlier execution events may be collapsed; use inspect to recover operator details.";
  const checks = options.checks
    ? "\n\nA check line reports a suspicious header, records repeated across sources, or an empty or duplicating operation inside a custom function. Examine the finding before using its result."
    : "";
  return NATIVE_MODE_TEMPLATE.replace("{{OPERATOR_CATALOG}}", graphCatalogText())
    .replace("{{RETRIEVAL}}", nativeRetrievalText(options))
    .replace("{{STATE_HISTORY}}", options.stateHistory ? NATIVE_STATE_HISTORY.trim() : "")
    .replace("{{RETRIEVAL_EXAMPLES}}", nativeRetrievalExamples(options))
    .replaceAll(
      "{{RETRIEVE_EXAMPLE_VIEW}}",
      availableRetrievalViews(options).includes("sample") ? "sample" : availableRetrievalViews(options)[0]
    )
    .replace(
      "{{FINAL_RETRIEVE_EXAMPLE_VIEW}}",
      availableRetrievalViews(options).includes("full") ? "full" : availableRetrievalViews(options)[0]
    )
    .replace(
      "{{EVIDENCE}}",
      nativeEvidenceText({ ...options, dataEvidence: availableRetrievalViews(options).includes("sample_stats") }) +
        checks
    )
    .replace("{{CONTEXT_LAYOUT}}", context)
    .replace(
      "{{RECALL_TOOL}}",
      options.recall ? "\nUse recallState to read an earlier turn's saved work without execution." : ""
    );
}

export const NATIVE_STATE_HISTORY =
  `
## Historical state across tasks

All user tasks share this graph. Each task is a user request, numbered from 1 in conversation order. Completed tasks retain their operator definitions, incoming edges, custom functions, and available result observations. Earlier answers can be incorrect; check the computation you reuse.

Before editing for a task that reuses an earlier stage, restores a baseline, or runs a sensitivity check, identify the earlier task and Inspect its relevant operator with include_implementation=true. Inspect the task overview first if you do not know the operator ID. Skip another inspection only when the needed definition and input state are already visible and unchanged. Then choose the population, formula and eligibility gates separately; do not reconstruct a saved gate or copy numbers from prose.

When narrowing a working population, connect from its existing eligible table so prior filters remain ancestors unless the user replaces them. Check the incoming edges, not just the operator's name or description. Reuse a saved eligibility flag instead of testing only one component of its decision. Keep the full reusable population separate from a limited report; future analysis should branch from the full table unless the user requests that displayed subset.

Preserve the row set on which an existing percentile or aggregate was computed; filtering a report is not a request to rebuild its ranks. Inspect the complete score expression before applying an earlier scoring rule, including blend terms from other inputs. Keep global baselines available to every row that needs them, including rows unmatched by an optional join. After a repair changes input edges, Retrieve the affected intermediate result and check row counts and required fields before continuing.

- Inspect one saved operator: {"type":"inspect","target":"state","task_id":2,"operator_id":"eligible","include_implementation":true}. This shows its definition, immediate input definitions, saved row counts and historical connections. Follow input IDs for deeper dependencies. With null task_id it shows the operator across completed tasks, including dependency hashes; unchanged expressions can still have changed upstream state.
- Find operators in a task: set task_id to that task and operator_id to null, with include_implementation=false for a compact overview of operators changed or retrieved there. Definitions describe task-end state; retrieved receipts preserve the original read identities, which can refer to older tasks. Activity is a navigation aid, not proof that a read determined the answer. Set both IDs to null only when you need the completed task list. No history index is inserted automatically.
- Read an earlier output: {"type":"retrieve","task_id":2,"operator_id":"eligible","view":"{{RETRIEVE_EXAMPLE_VIEW}}"}. The same available views and completeness checks apply. Retrieval never executes or substitutes today's output.
- Reuse an earlier branch: {"type":"fork","task_id":2,"operator_id":"eligible","new_operator_id":"earlier_eligible"}. This atomically copies that operator and every upstream definition under new IDs, preserving historical edge positions. The receipt gives the ID mapping. The live branch is unchanged. Retrieve earlier_eligible to read an available saved observation; {"type":"execute","operator_ids":["earlier_eligible"]} recomputes its upstream branch for downstream analysis. Fork preserves definitions, not external file contents; recomputation reads the supplied files.

For a temporary sensitivity check, fork the baseline before editing its copy. Continue later default work from the baseline unless the user adopts the change. To apply an older formula to a current population, inspect the old expression and use Edit to create it with current input edges, or explicitly rewire a fork after inspecting its mapping. A wholesale historical rollback would also restore the older population. Editing a fork or any ancestor invalidates its saved observation; Execute before retrieving its changed output. Keep custom functions limited to one operation so useful intermediate states remain independently addressable.

Inspect results return after the entire action list. Make edits that depend on them in the next call. Fork followed by Retrieve is a valid batch when the source and new IDs are already known.
` +
  "\n" +
  rd("state-history-examples.md").replace(/^<!--[\s\S]*?-->\s*/, "");

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
