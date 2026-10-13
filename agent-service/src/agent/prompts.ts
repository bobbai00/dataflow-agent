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
 * - `buildRegisteredNativeSystemPrompt` — native mode: the model edits, runs
 *   and reads the Dataflow through the `dataflow(python, statements)` tool
 *   (template `prompts/native-registered.md`; worked examples rendered by the
 *   production receipt renderer in `prompts/registered-examples.ts`).
 * - `buildCodeModeSystemPrompt` — code mode: every operator is one free Python
 *   function written through `createOrModifyOperator`. Includes a worked example.
 */

import { readFileSync } from "node:fs";
import {
  ContextMode,
  type CatalogSource,
  type LocalToolDialect,
  type MultiRequestMode,
  type RetrievalSettings,
} from "../types/agent";
import { observationFormat, type ObservationFormatOptions } from "./native/observation-format";
import { registeredCatalogText } from "./native/registered";
import { availableRetrievalViews, EVIDENCE_CHAR_LIMIT, FULL_RESULT_CHAR_LIMIT } from "./native/retrieval";
import { registeredExamples } from "./prompts/registered-examples";

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
  sourceProvenanceHint = false
): string {
  const key = contextMode === ContextMode.DELTA ? "delta" : "latest";
  // The only code-blind configuration: LATEST without code in the snapshot.
  // DELTA always shows code per event, so it is never code-blind.
  const noCode = key === "latest" && !codeInSnapshotEnabled;
  const compaction = key === "delta" && compactionEnabled ? `\n${COMPACTION_FRAGMENT}\n` : "";
  const renderPrefs = renderPrefsEnabled ? `\n${RENDER_PREFS_FRAGMENT}\n` : "";
  // Context format tracks the LAYOUT the agent is fed, which is a separate axis
  // from code visibility: DELTA is always `# Agent Events`, LATEST is
  // `# Current Dataflow` with or without the per-operator Code: blocks.
  const contextFormat =
    key === "delta"
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
    .replace("{{RENDER_PREFS}}", renderPrefs)
    .replace("{{EXAMPLE}}", example)
    .replace(/\n{3,}/g, "\n\n");
}

// ============================================================================
// NATIVE mode: the `dataflow(python, statements)` tool over built-in operators
// and registered Python functions. Template in prompts/native-registered.md;
// the operator index is generated from the definitions the parser validates
// against, and the worked examples are rendered by the production receipt
// renderer, so prompt, parser and receipts cannot drift.
// ============================================================================

export interface NativePromptLayoutOptions extends RetrievalSettings, ObservationFormatOptions {
  maxOperatorResultCharLimit?: number;
  maxResultRows?: number;
  /** Which evidence kinds observed results carry; the prompt documents exactly those. */
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  /** Several requests in one session (AgentSettings.multiRequest). */
  multiRequest?: MultiRequestMode;
  /** Catalog entries' functions (AgentSettings.catalogSource). */
  catalogSource?: CatalogSource;
  /** Recent requests a catalog keeps as transcript (AgentSettings.catalogRecent). */
  catalogRecent?: number;
  /** Focused tasks shown in full (AgentSettings.focusTasks). */
  focusTasks?: number;
  /** A call may end with `answer {...}` (AgentSettings.answerStatement). */
  answerStatement?: boolean;
  /** The tool takes `answer` (AgentSettings.answerField). */
  answerField?: boolean;
}

const nativeFragment = (name: string) =>
  rd(name)
    .replace(/^<!--[\s\S]*?-->\s*/, "")
    .trim();

/** How `show result` reads results under the views this session enables. */
export function nativeRetrievalText(options: NativePromptLayoutOptions = {}): string {
  const views = availableRetrievalViews(options);
  const sampleLimit = options.maxOperatorResultCharLimit ?? 2000;
  const rowLimit = options.maxResultRows ?? 50;
  const rows = rowLimit > 0 ? `at most ${rowLimit} example records` : "example records";
  const sample = `The schema and ${rows}, within ${sampleLimit} characters`;
  const full = `Every record within ${options.fullResultCharLimit ?? FULL_RESULT_CHAR_LIMIT} characters; a capped view remains partial.`;
  const first = views.includes("sample_stats") ? "sample_stats" : views.includes("sample") ? "sample" : undefined;
  const sampleText = `${sample}${views.includes("sample_stats") ? `, plus collected column statistics within a separate ${options.dataEvidenceCharLimit ?? EVIDENCE_CHAR_LIMIT}-character budget (check their row and column coverage)` : ""}`;
  const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
  const fullLimit = options.fullResultCharLimit ?? FULL_RESULT_CHAR_LIMIT;
  return [
    `Enabled views: ${views.map(view => `\`${view}\``).join(", ")}. The default is \`${first ?? "full"}\`.`,
    first === "sample_stats" && views.includes("full")
      ? `\`show result <id>\` gives the schema, ${rows} and column statistics; ask for \`show result <id> full\`, every record within ${fullLimit} characters, only for a small table whose every row you need.`
      : first && views.includes("full")
        ? `\`show result <id>\` gives ${lower(sampleText)}. \`show result <id> full\` gives ${lower(full)} Look at a result without \`full\` first, and ask for \`full\` only when you need every row, such as a small final table or row associations the sample does not establish; reduce a large result in the graph first.`
        : first
          ? `\`show result <id>\` gives ${lower(sampleText)}.`
          : `\`show result <id> full\` gives ${lower(full)} Check the completeness of every result.`,
    "Use `show result <id>[<col>, ...]` when a wide result hides the fields you need.",
  ].join(" ");
}

export function buildRegisteredNativeSystemPrompt(
  contextMode: ContextMode = ContextMode.DELTA,
  options: NativePromptLayoutOptions = {}
): string {
  const views = availableRetrievalViews(options);
  const format = observationFormat(options);
  const table = options.tableFormat === "tsv" ? "a tab-separated table with a header line" : "a Markdown table";
  const multiRequest = options.multiRequest ?? "off";
  const fields: Record<string, string> = {
    CONTEXT_LAYOUT:
      contextMode === ContextMode.LATEST
        ? "Your context shows the current graph and available results. Earlier execution events may be collapsed; inspect definitions when relevant details are missing."
        : multiRequest === "catalog"
          ? ((options.catalogRecent ?? 0) > 0
              ? "Your context contains the calls and observations of this task and of the most recent earlier tasks. Each older task appears as its request and a catalog entry: "
              : "Your context contains this task's calls and observations. Each earlier task appears as its request and a catalog entry: ") +
            (options.catalogSource === "ledger"
              ? "the functions it registered or changed, with their signatures and docstrings (`show function` reads any source); one line per operator it set, with rows and columns; which earlier tasks it built on; and its answer. Entries carry no records; `show result` an earlier table when you need its values." +
                ((options.focusTasks ?? 0) > 0
                  ? ` After the entries comes the working set: up to ${options.focusTasks} earlier tasks in full, with their request, their functions with source, their operators with every column and a sample, and their answer. It starts as the previous task and what you focused before; \`focus task 3, 7\` (or \`focus <operator>\` for its task) replaces it from your next call, and a task you stop using drops out. Before you build on an earlier task's rule or table, make sure that task is in the working set: its code is where the conventions are.`
                  : "") +
                " Each observation describes the graph at that time; later edits may have made its results stale."
              : (options.catalogSource === "docstring"
                  ? "the functions it registered or changed, with their signatures and docstrings (source only for a function without one; `show function` reads any source)"
                  : "the functions it registered or changed, with their signatures and source") +
                "; the operators it created, changed, or deleted, with results and columns as it left them; the results it showed; and its answer. Entries carry no records; `show result` an earlier table when you need its values. Each observation describes the graph at that time; later edits may have made its results stale.")
          : "Your context contains earlier calls and observations. Each observation describes the graph at that time; later edits may have made its results stale.",
    TOOL_FIELDS: options.answerField
      ? '`python` (definitions, or `""`), `statements` (one per line) and `answer` (the final answer over tables the call computes, or `""`)'
      : '`python` (definitions, or `""`) and `statements` (one per line)',
    FINAL_ANSWER_RULE: options.answerField
      ? "Never answer from memory: finish a request in the call that computes its answer, by writing that answer in `answer` over the tables that hold it. Reply without the tool instead only when the answer needs a judgment the tables cannot hold, and only after `show result` has displayed what it rests on."
      : options.answerStatement
        ? "Never answer from memory: end a request with `answer <id>`, naming the operator whose function returned the answer, or with a reply without the tool after `show result` has displayed what the answer rests on."
        : "Never answer from memory: a reply without the tool is your final answer, so reply without it only after `show result` has displayed what the answer rests on.",
    FINISH: options.answerField
      ? 'To finish, write the answer in `answer` in the call whose statements compute its tables, for example `{"leaders": top[market, score], "total": summary.rows} digits=4`; `""` continues the request. A table becomes its rows (`table[col1, col2]` keeps those columns); `table.column` is the value of a one-row table, or the column\'s values; strings, numbers, true, false and null are literal; `digits=N` rounds every non-integer number. Once the tables compute, the request ends with that answer as JSON, without another call, so build answer tables in the requested shape, order and column names. The answer is refused, and the request stays open, when a table it names fails, is empty, has more than 50 rows, or a column it picks is null throughout. Do not `show result` a table only to copy it into a reply.'
      : options.answerStatement
        ? "To finish, end the call that computes the answer with `answer <id>`: `<id>` is an operator whose function takes the tables the answer rests on and returns the answer as a dict in the requested shape, with the requested keys, nesting, order and rounding, for example `def leaders_answer(top, eligible): return {'leaders': [{'unit': r.unit, 'score': round(r.score, 4)} for r in top.itertuples()], 'eligible_units': int(len(eligible))}`, then `set answer_1: leaders_answer(top, eligible)` and `answer answer_1`. The request ends with that dict as JSON, without another call. `answer <id>` of an ordinary table of up to 50 rows answers with its rows. The answer is refused, and the request stays open, when the operator fails or returns nothing. Show a result first only when you must read it to decide the answer. A reply without the tool is also an answer, verbatim, in the user's requested format; use it only when the answer needs a judgment the tables do not hold, after `show result` has displayed what it rests on."
        : "To finish, reply without calling the tool: that reply is the answer, verbatim, in the user's requested format; it may span lines and contain Markdown. There is no answer statement.",
    FOCUS_STATEMENT:
      (options.focusTasks ?? 0) > 0
        ? "    focus task <n>, ...                        the earlier tasks shown in full from the next call (or focus <id> for its task)"
        : "",
    ANSWER_SOURCE:
      options.answerField || options.answerStatement ? "answer from that result" : "retrieve that result before answering",
    // Only sessions with several requests; a single request's prompt is unchanged.
    MULTI_REQUEST: multiRequest === "off" ? "" : nativeFragment("native-multi-request.md"),
    OPERATOR_CATALOG: registeredCatalogText(undefined, "index"),
    EXAMPLES: registeredExamples(options),
    RETRIEVAL: nativeRetrievalText(options),
    RECORD_LAYOUT:
      format.keyValueColumns > 0
        ? `Records with up to ${format.keyValueColumns} columns use ${table}; wider records use one \`column: value\` line per field.`
        : `Records use ${table} at any width.`,
    DATA_STATISTICS: views.includes("sample_stats")
      ? "Column statistics in `sample_stats` describe the requested result table within their stated coverage: row counts, nulls, distinct values, ranges, and frequent values. Profiles cover at most 128 columns and may cover only a row prefix; missing statistics are unknown. Read `values` for flags, codes, and spellings that define the population, and ranges and nulls for units and fill values; compute exact answer quantities in the graph. A complete small table suppresses redundant statistics." +
        (views.includes("full") ? " The `full` view does not request table statistics." : "")
      : "",
    FLOW_STATISTICS: options.flowEvidence
      ? "Flow lines report what upstream steps did that row counts do not show: rejected filter values, unmatched join keys, cast failures, nulls left out of an aggregate, and values a Python step dropped from a column. Before answering, read the flow lines of the operators the answer depends on, and fix or explain unmatched join keys and filters that rejected requested values."
      : "",
  };
  // The examples already use the actual renderers with the enabled views.
  const prompt = nativeFragment("native-registered.md").replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in fields)) throw new Error(`Unknown registered prompt field ${key}`);
    return fields[key];
  });
  return prompt.replace(/\n{3,}/g, "\n\n").trim();
}

/** Built-in contracts, for `show builtin`; Python definitions are read with
 * `show function` instead of duplicated as documentation. */
export function registeredReferenceText(request: { topic: "operators"; operator_names: string[] }): string {
  return registeredCatalogText(request.operator_names, "full");
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
