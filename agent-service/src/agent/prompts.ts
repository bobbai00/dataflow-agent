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
import { observationFormat, type ObservationFormatOptions } from "./native/observation-format";
import { graphCatalogText, graphCatalogIndexText } from "./native/catalog";
import { availableRetrievalViews, EVIDENCE_CHAR_LIMIT, FULL_RESULT_CHAR_LIMIT } from "./native/retrieval";

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

export interface NativePromptLayoutOptions extends RetrievalSettings, ObservationFormatOptions {
  maxOperatorResultCharLimit?: number;
  maxResultRows?: number;
  versioned?: boolean;
  session?: boolean;
  recall?: boolean;
  resume?: boolean;
  compact?: boolean;
  multiTask?: boolean;
  messageLayout?: AgentSettings["messageLayout"];
  /** `dataflowReasoning`: the tool takes a required `reasoning` argument, written first. */
  reasoning?: boolean;
  /** Which evidence kinds observed results carry; the prompt documents exactly those. */
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  /** `nativeChecks`: operators carry `check:` lines; the prompt says what they are. */
  checks?: boolean;
  stateHistory?: boolean;
  /** `stateLedger`: task ledgers in Answer receipts, provenance cards in Edit receipts, execution notes. */
  stateLedger?: boolean;
  nativePromptDetail?: "full" | "on_demand";
}

const nativeFragment = (name: string) =>
  rd(name)
    .replace(/^<!--[\s\S]*?-->\s*/, "")
    .trim();
const NATIVE_FRAGMENTS = {
  data: nativeFragment("native-data-statistics.md"),
  flow: nativeFragment("native-flow-statistics.md"),
  multiTask: nativeFragment("native-multi-task.md"),
  history: nativeFragment("native-state-history.md"),
  catalog: nativeFragment("native-task-catalog.md"),
  recall: nativeFragment("native-recall.md"),
  resume: nativeFragment("native-resume.md"),
  compact: nativeFragment("native-compact.md"),
  singleExample: nativeFragment("native-example-single.md"),
  dataExamples: nativeFragment("native-example-data.md"),
  flowExamples: nativeFragment("native-example-flow.md"),
  taskExamples: nativeFragment("native-example-tasks.md"),
  reviseExample: nativeFragment("native-example-revise.md"),
  historyExamples: nativeFragment("native-example-history.md"),
  leanExamples: nativeFragment("native-example-lean.md"),
  leanHistoryExamples: nativeFragment("native-example-history-lean.md"),
};

/** What a session offers, as the prompt fragments name it. */
function nativeFlags(options: NativePromptLayoutOptions): Record<string, boolean> {
  const multi = !!(
    options.multiTask ||
    options.stateHistory ||
    options.stateLedger ||
    options.session ||
    options.versioned ||
    options.recall ||
    options.resume ||
    options.compact
  );
  return {
    data: availableRetrievalViews(options).includes("sample_stats"),
    flow: !!options.flowEvidence,
    multi,
    scopedGraph: multi && !options.stateHistory,
    history: !!options.stateHistory,
    ledger: !!options.stateLedger,
    checks: !!options.checks,
  };
}

/** Keep `{{#flag}}…{{/flag}}` when the flag is on and `{{^flag}}…{{/flag}}`
 * when it is off. A section whose markers stand on their own lines takes
 * those lines with it. */
function applySections(text: string, flags: Record<string, boolean>): string {
  const keep = (sigil: string, name: string) => {
    if (!(name in flags)) throw new Error(`unknown prompt section {{${sigil}${name}}}`);
    return (sigil === "#") === flags[name];
  };
  return text
    .replace(/^\{\{([#^])(\w+)\}\}\n([\s\S]*?)^\{\{\/\2\}\}\n?/gm, (_, sigil, name, body) =>
      keep(sigil, name) ? body : ""
    )
    .replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, sigil, name, body) => (keep(sigil, name) ? body : ""));
}

/**
 * The example receipts are real renderer output with data and flow
 * statistics on and Markdown tables. Remove what this session's receipts
 * would not contain and use its table syntax, so every example shows exactly
 * what the model will see.
 */
function adaptReceipts(text: string, options: NativePromptLayoutOptions, flags: Record<string, boolean>): string {
  const views = availableRetrievalViews(options);
  const view = views.includes("sample_stats") ? "sample_stats" : views.includes("sample") ? "sample" : views[0];
  return text.replace(/```text\n([\s\S]*?)\n```/g, (_, body: string) => {
    let lines: string[] = [];
    let statistics = false;
    for (const line of body.split("\n")) {
      if (statistics && line.startsWith("|")) continue;
      statistics = !flags.data && line.startsWith("statistics:");
      if (statistics) continue;
      if (!flags.flow && /^\s*- flow\b/.test(line)) continue;
      lines.push(
        line
          .replace(/^records: sample_stats;/, `records: ${view};`)
          .replace(/^records: full;/, `records: ${views.includes("full") ? "full" : view};`)
      );
    }
    // An execute receipt gives a block only to an operator with something to
    // report; without its flow lines, a block may have nothing left.
    let execute = false;
    lines = lines
      .filter((line, i) => {
        if (line.startsWith("### ")) execute = /^### \d+\. execute\b/.test(line);
        if (!execute || !line.startsWith("- **")) return true;
        const end = lines.findIndex((next, j) => j > i && !next.startsWith("  "));
        const fields = lines.slice(i + 1, end < 0 ? lines.length : end);
        if (fields.some(field => /^  - (error|note|check|flow|changed since|differs from|rank change)\b/.test(field))) return true;
        fields.forEach((_, k) => (lines[i + 1 + k] = "\u0000"));
        return false;
      })
      .filter(line => line !== "\u0000");
    const tsv = (line: string) => {
      if (/^\|(?:---\|)+$/.test(line)) return undefined;
      if (!line.startsWith("| ")) return line;
      const cells = line.slice(2, -2).split(" | ");
      return cells.every(cell => cell === "…") ? "…" : cells.join("\t");
    };
    const shown = options.tableFormat === "tsv" ? lines.map(tsv).filter(line => line !== undefined) : lines;
    return "```text\n" + shown.join("\n") + "\n```";
  });
}

/** Explain exactly the evidence sources available to this session. */
export function nativeEvidenceText(options: NativePromptLayoutOptions = {}): string {
  const data = options.retrievalViews
    ? availableRetrievalViews(options).includes("sample_stats")
    : options.dataEvidence;
  return [
    data ? NATIVE_FRAGMENTS.data : "",
    options.flowEvidence
      ? NATIVE_FRAGMENTS.flow.replaceAll(
          "{{FLOW_BUDGET}}",
          String(options.flowEvidenceCharLimit ?? EVIDENCE_CHAR_LIMIT)
        )
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function nativeRetrievalText(options: NativePromptLayoutOptions = {}): string {
  const views = availableRetrievalViews(options);
  const sampleLimit = options.maxOperatorResultCharLimit ?? 2000;
  const rowLimit = options.maxResultRows ?? 50;
  const rows = rowLimit > 0 ? ` and at most ${rowLimit} records` : "";
  const descriptions = {
    full: `Records within ${options.fullResultCharLimit ?? FULL_RESULT_CHAR_LIMIT} characters. A capped view remains partial.`,
    sample: `Schema and retained example records within ${sampleLimit} characters${rows}.`,
    sample_stats: `Schema and retained example records within ${sampleLimit} characters${rows}, plus data statistics within a separate ${options.dataEvidenceCharLimit ?? EVIDENCE_CHAR_LIMIT}-character budget.`,
  };
  return [
    "Choose a `view` on every retrieve:",
    "",
    "| View | Available information |",
    "|---|---|",
    ...views.map(view => `| \`${view}\` | ${descriptions[view]} |`),
    "",
    views.includes("sample_stats")
      ? "Start with `sample_stats` to understand the result and judge what needs further work."
      : views.includes("sample")
        ? "Start with `sample` to understand layout and types."
        : "Check the completeness of every `full` view.",
    "If a wide result hides the fields you need, use `columns`.",
    ...(views.includes("full")
      ? [
          "Request `full` when you need row associations or ordering that the sample and available statistics do not establish. For a large result, compute a focused projection, filter or aggregate in the graph before retrieving its full view.",
        ]
      : []),
  ].join("\n");
}

/** The examples this session's features call for: a single task always, then
 * reading statistics, several tasks and earlier versions when available. */
export function nativeRetrievalExamples(options: NativePromptLayoutOptions = {}): string {
  const flags = nativeFlags(options);
  if (flags.history) return NATIVE_FRAGMENTS.historyExamples;
  return [
    NATIVE_FRAGMENTS.singleExample,
    flags.data ? NATIVE_FRAGMENTS.dataExamples : "",
    flags.flow ? NATIVE_FRAGMENTS.flowExamples : "",
    flags.multi ? NATIVE_FRAGMENTS.taskExamples : "",
    flags.multi ? NATIVE_FRAGMENTS.reviseExample : "",
    flags.history ? NATIVE_FRAGMENTS.historyExamples : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Working across tasks, with the history, catalog and legacy tools the session enables. */
export function nativeStateText(options: NativePromptLayoutOptions = {}): string {
  return [
    NATIVE_FRAGMENTS.multiTask,
    options.stateHistory ? NATIVE_FRAGMENTS.history : "",
    options.stateLedger ? NATIVE_FRAGMENTS.catalog : "",
    options.recall ? NATIVE_FRAGMENTS.recall : "",
    options.resume ? NATIVE_FRAGMENTS.resume : "",
    options.compact ? NATIVE_FRAGMENTS.compact : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
export const NATIVE_STATE_HISTORY = NATIVE_FRAGMENTS.history;

export function buildNativeModeSystemPrompt(
  contextMode: ContextMode = ContextMode.DELTA,
  options: NativePromptLayoutOptions = {}
): string {
  const views = availableRetrievalViews(options);
  const view = views.includes("sample_stats") ? "sample_stats" : views.includes("sample") ? "sample" : views[0];
  const flags = nativeFlags(options);
  const format = observationFormat(options);
  const context = options.versioned
    ? "Your context lists earlier tasks in a catalog, followed by the current task and its calls. Table names refer to their current versions."
    : options.session
      ? "Your context groups earlier calls and observations by task. Earlier tables remain available by name."
      : contextMode === ContextMode.LATEST
        ? "Your context shows the current dataflow and its available results. The latest receipt records what just completed, and earlier execution events may be collapsed; inspect when an operator's details are needed."
        : "Your context holds earlier calls and their observations. Each observation describes the graph when its actions ran, and later edits may have changed it; inspect when you need a current definition, and execute when you need a current result.";
  const table = options.tableFormat === "tsv" ? "a tab-separated table with a header line" : "a Markdown table";
  const fields: Record<string, string> = {
    OPERATOR_CATALOG:
      options.nativePromptDetail === "on_demand"
        ? "Signatures and ports are listed below. Read a needed contract with inspect target=reference, topic=operators, operator_names=[...]. This is documentation, not graph state; it never executes or changes an operator. Reuse reference material already in context.\n\n" +
          graphCatalogIndexText()
        : graphCatalogText(),
    CONTEXT_LAYOUT: context,
    RETRIEVAL: nativeRetrievalText(options),
    RECORD_LAYOUT:
      format.keyValueColumns > 0
        ? `Records with up to ${format.keyValueColumns} columns use ${table}; wider records use one \`column: value\` line per field.`
        : `Records use ${table} at any width.`,
    DATA_STATISTICS: flags.data ? NATIVE_FRAGMENTS.data : "",
    FLOW_STATISTICS: flags.flow
      ? NATIVE_FRAGMENTS.flow.replaceAll(
          "{{FLOW_BUDGET}}",
          String(options.flowEvidenceCharLimit ?? EVIDENCE_CHAR_LIMIT)
        )
      : "",
    EARLIER_TASKS: flags.multi ? nativeStateText(options) : "",
    EXAMPLES:
      options.nativePromptDetail === "on_demand"
        ? flags.history ? NATIVE_FRAGMENTS.leanHistoryExamples : NATIVE_FRAGMENTS.leanExamples
        : nativeRetrievalExamples(options),
  };
  let prompt = NATIVE_MODE_TEMPLATE.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in fields)) throw new Error(`unknown prompt field {{${key}}}`);
    return fields[key];
  });
  prompt = adaptReceipts(applySections(prompt, flags), options, flags);
  // Example calls use only the views this session's tool schema offers.
  prompt = prompt.replace(/"view"\s*:\s*"sample_stats"/g, `"view": "${view}"`);
  if (!views.includes("full")) prompt = prompt.replace(/"view"\s*:\s*"full"/g, `"view": "${view}"`);
  if (flags.history) prompt = prompt.replace(/\bretrieve\b/g, "read").replace(/\bRetrieve\b/g, "Read");
  return prompt.replace(/\n{3,}/g, "\n\n").trim();
}

/** The same contracts and feature-matched examples used by the full prompt. */
export function nativeReferenceText(
  request:
    | { topic: "operators"; operator_names: string[] }
    | { topic: "example"; example: "single" | "statistics" | "history" },
  options: NativePromptLayoutOptions
): string {
  if (request.topic === "operators") return graphCatalogText(request.operator_names);
  const flags = nativeFlags(options);
  if (request.example === "history" && !flags.history) throw new Error("Historical state tools are disabled.");
  if (request.example === "statistics" && !flags.data && !flags.flow)
    throw new Error("Data and flow statistics are disabled for this session.");
  const text =
    flags.history
      ? NATIVE_FRAGMENTS.historyExamples
      : request.example === "single"
      ? NATIVE_FRAGMENTS.singleExample
      : request.example === "history"
        ? NATIVE_FRAGMENTS.historyExamples
        : [flags.data ? NATIVE_FRAGMENTS.dataExamples : "", flags.flow ? NATIVE_FRAGMENTS.flowExamples : ""]
            .filter(Boolean)
            .join("\n\n");
  if (!text) throw new Error("Data and flow statistics are disabled for this session.");
  let rendered = adaptReceipts(applySections(text, flags), options, flags);
  const views = availableRetrievalViews(options);
  const view = views.includes("sample_stats") ? "sample_stats" : views.includes("sample") ? "sample" : views[0];
  rendered = rendered.replace(/"view"\s*:\s*"sample_stats"/g, `"view": "${view}"`);
  if (!views.includes("full")) rendered = rendered.replace(/"view"\s*:\s*"full"/g, `"view": "${view}"`);
  return rendered;
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
