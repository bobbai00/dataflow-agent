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
  /** Each dataflow call states `why`, and entries show it. */
  taskWhy?: boolean;
}

/** Stated once, in the stable head of the prompt, so the explanation costs one
 * cached prefix for the whole session. The agent cannot use a reference form
 * nobody told it about: without this it used task history 14 times in 114 turns. */
const TASK_ENTRIES_LAYOUT =
  "\n\nThis is one session of numbered tasks. Each completed task appears once, as an entry: the request; the changes it made to the dataflow (added, modified, restored or deleted operators, each as the statement you wrote, with its doc, its row count and columns, `⚠ EMPTY` when a table came out with no rows, and the task whose definition it replaced); the rows of the tables it read (`Tables read`: a table of at most 20 rows in full, a larger one by its first rows, and `same rows as shown in task N` when nothing changed); and the answer with the tables it was read from. Entries never change. `# Tables now` then lists every current table with the task that created it, the tasks that changed it, and `recomputed tN` when something upstream changed after the rows an entry shows, and flags tables that are empty or failed right now. A table's current definition is in the latest entry that lists it. A number an earlier task reported is in that task's entry: read it there instead of observing the table again, unless the table was recomputed since.";
/** How a task is worked, stated once. The steps are DSGym's, which answers
 * the same benchmark with two model calls per turn; the last sentence is the
 * dataflow's own repair: one reassignment recomputes everything downstream. */
const TASK_METHOD =
  "\n\nWork each task as a careful analyst. First understand the request: what one row means, which rows are in scope, and the units and rounding the answer needs. Plan the steps before writing statements, and change the plan when a table contradicts it. Later tasks mostly build on tables whose columns you have already seen, so feel free to add several operators in one call whenever you are comfortable with how they fit together; this usually makes the work go faster. Observe only the tables whose results you need, usually the ones the answer is read from. Answer only when the observed tables support every number, and try another approach when they do not. When a request corrects or refines what an earlier task defined, reassign that id so everything built on it recomputes, rather than building a copy beside it.";
/** Visible reasoning as part of the action: the reason rides on the call, so
 * later calls of the task see it and the entry keeps it under the changes. */
const TASK_WHY =
  " Each dataflow call carries `why`: one or two sentences on what the call does and why. It stays with the changes that call makes, and completed tasks show it as a `why:` line above those changes, so write it for a reader coming back in a later task; when a call corrects an earlier definition, say what was wrong.";
const TASK_SESSION_LAYOUT = "\n\nThis is one session of tasks, numbered from 1 in the order they were asked.";
/** The four ways analytical state evolves, each as one dataflow gesture. */
const TASK_STATE_GESTURES =
  ' Every table\'s output at the end of each task is saved, so state evolves in four ways. To make a revision the new default, reassign the same id: everything downstream recomputes. For a one-off alternative, build a new id from the current tables and leave the default alone. To work under an earlier version, use the tool\'s `restore=[{"operator": name, "task": N, "as": new_id}]`: it rebuilds that table as defined at the end of task N under the new id, shares upstream tables that are unchanged since then, copies the ones that changed as `<name>_t<N>`, and its observation says whether the result matches the saved table. To make an earlier version current again, restore with `as` equal to the same id. Read the version\'s definition in its entry before restoring.';

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
  const taskLayout =
    (options.taskCatalog ? TASK_ENTRIES_LAYOUT : options.taskHistory ? TASK_SESSION_LAYOUT : "") +
    (options.taskHistory && options.taskRestore ? TASK_STATE_GESTURES : "") +
    (options.taskCatalog || options.taskHistory ? TASK_METHOD : "") +
    ((options.taskCatalog || options.taskHistory) && options.taskWhy ? TASK_WHY : "");
  return NATIVE_MODE_TEMPLATE.replace("{{OPERATOR_CATALOG}}", nativeCatalogText())
    .replace("{{CONTEXT_LAYOUT}}", contextLayout + snapshotProgress + taskLayout)
    .replace("{{OBSERVATION_SCOPE}}", scope)
    .replace("{{RECALL_TOOL}}", recall);
}

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
