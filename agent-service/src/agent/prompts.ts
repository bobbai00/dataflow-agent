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
 * System prompts for the Texera agent:
 *
 * - `buildRegisteredNativeSystemPrompt` — the model edits, runs and reads the
 *   Dataflow through the `dataflow(python, statements)` tool (template
 *   `prompts/native-registered.md`; worked examples rendered by the production
 *   receipt renderer in `prompts/registered-examples.ts`).
 * - `buildLocalReactSystemPrompt` — the local text-mode driver's prompt, one per
 *   tool-call dialect.
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
import { exampleStatement, registeredExamples } from "./prompts/registered-examples";

const rd = (name: string) => readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8").trimEnd();

/**
 * The system prompt with the session's instructions appended
 * (AgentSettings.instructions): what this agent should and should not do
 * beyond its mode's prompt, e.g. a study's rules of engagement.
 */
export function withSessionInstructions(prompt: string, instructions: string | undefined): string {
  const text = instructions?.trim();
  return text ? `${prompt.trimEnd()}\n\n## Instructions for this session\n\n${text}\n` : prompt;
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
  /** Which evidence kinds observed results carry. The prompt documents data
   * statistics and, with `flowEvidence`, what runtime stats lines are. */
  dataEvidence?: boolean;
  flowEvidence?: boolean;
  /** Several requests in one session (AgentSettings.multiRequest). */
  multiRequest?: MultiRequestMode;
  /** Catalog entries' functions (AgentSettings.catalogSource). */
  catalogSource?: CatalogSource;
  /** Recent requests a catalog keeps as transcript (AgentSettings.catalogRecent). */
  catalogRecent?: number;
  /** The final answer is an `answer` statement (AgentSettings.answerStatement). */
  answerStatement?: boolean;
  /** Every operator carries a one-line doc; the examples show one (AgentSettings.operatorDoc). */
  operatorDoc?: boolean;
}

/** When an operator gets a `doc`: every operator, or only where the declaration leaves its meaning unclear. */
function operatorDocText(operatorDoc: boolean | undefined): string {
  return operatorDoc
    ? "Give every operator, built-in or Python, a one-line `doc='...'` that says what it does and why the Dataflow needs it, in the task's terms: its population, units, or formula when they matter. `set` replaces the whole operator, so restate its doc; a changed doc alone re-runs nothing. A tool result names operators set without one."
    : "Add optional `doc='...'` to any task-specific operator, built-in or Python, when its population, units, or formula is not clear from the declaration. Routine operators need no boilerplate.";
}

/** How the final answer is given: a reply without the tool, or an answer statement. */
function finalAnswerText(answerStatement: boolean | undefined): string {
  return answerStatement
    ? "Never answer from memory. Give the final answer with an answer statement in a `dataflow` call: `answer <id>` returns that table, and `answer <key>=<id>, <key>=<id>` returns one object with a key per table. A table of one row and one column becomes its value, a one-row table an object, and any other table a list of all its rows, so aggregate or limit first, and build a table for every value the request asks for. The rendering is returned verbatim as your final answer, as the JSON the request asks for, and ends the request; a reply without the tool is not an answer."
    : "Never answer from memory: a reply without the tool is your final answer, so reply without it only after `show result` has displayed what the answer rests on. That reply is returned verbatim, in the user's requested format.";
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
  const previewRows = observationFormat(options).fullPreviewRows;
  const larger =
    previewRows > 0
      ? ` A larger table shows its first ${previewRows} rows (a table read from files shows as many as fit); to read further rows, \`set <new id>: limit(<id>, n=..., offset=...)\` and show that.`
      : "";
  return [
    `Enabled views: ${views.map(view => `\`${view}\``).join(", ")}. The default is \`${first ?? "full"}\`.`,
    first === "sample_stats" && views.includes("full")
      ? `\`show result <id>\` gives the schema, ${rows} and column statistics; ask for \`show result <id> full\`, every record within ${fullLimit} characters, only for a small table whose every row you need.${larger}`
      : first && views.includes("full")
        ? `\`show result <id>\` gives ${lower(sampleText)}. \`show result <id> full\` gives ${lower(full)}${larger} Look at a result without \`full\` first, and ask for \`full\` only when you need every row, such as a small final table or row associations the sample does not establish; reduce a large result in the graph first.`
        : first
          ? `\`show result <id>\` gives ${lower(sampleText)}.`
          : `\`show result <id> full\` gives ${lower(full)}${larger} Check the completeness of every result.`,
    "Use `show result <id>[<col>, ...]` when a wide result hides the fields you need.",
    "Tool results put a text value or column name in double quotes, JSON-escaped, when it is empty, has spaces at either end, holds a tab, line break, backslash or the layout's separator, or would read as a number, true, false or null; the quotes are not part of the text.",
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
    // Field-led: off, the sentence before it ends the paragraph unchanged.
    KEY_NORMALIZATION: format.dataHygiene
      ? " Before you group or join on a text key, check its values: one value can be written in several ways (spacing, case, punctuation) or repeat across files. Normalize a key only where its values actually differ, leave other text columns as the source has them unless the task asks for cleaning, and check that matched counts are plausible after a join."
      : "",
    PYTHON_FIELD: format.optionalPython
      ? "`python` (definitions, left out when there are none)"
      : '`python` (definitions, or `""`)',
    FINAL_ANSWER: finalAnswerText(options.answerStatement),
    REPLY_CONTENT: format.answerOnlyReply
      ? "it holds only what that format asks for, with no account of the steps or checks behind it."
      : "it may span lines and contain Markdown.",
    CONTEXT_LAYOUT:
      contextMode === ContextMode.LATEST
        ? "Your context shows the current graph and available results. Earlier execution events may be collapsed; inspect definitions when relevant details are missing."
        : multiRequest === "catalog"
          ? ((options.catalogRecent ?? 0) > 0
              ? "Your context contains the calls and observations of this task and of the most recent earlier tasks. Each older task appears as its request and a catalog entry: "
              : "Your context contains this task's calls and observations. Each earlier task appears as its request and a catalog entry: ") +
            (options.catalogSource === "docstring"
              ? "the functions it registered or changed, with their signatures and docstrings (source only for a function without one; `show function` reads any source)"
              : "the functions it registered or changed, with their signatures and source") +
            "; the operators it created, changed, or deleted, with results and columns as it left them; the results it showed; and its answer. Entries carry no records; `show result` an earlier table when you need its values. Each observation describes the graph at that time; later edits may have made its results stale."
          : "Your context contains earlier calls and observations. Each observation describes the graph at that time; later edits may have made its results stale.",
    // Only sessions with several requests; a single request's prompt is unchanged.
    MULTI_REQUEST: multiRequest === "off" ? "" : nativeFragment("native-multi-request.md"),
    OPERATOR_CATALOG: registeredCatalogText(undefined, "index"),
    GRAPH_EXAMPLE: (["records", "totals", "report"] as const)
      .map(name => exampleStatement(name, options.operatorDoc))
      .join("\n"),
    FILTER_EXAMPLE: exampleStatement("kept", options.operatorDoc),
    MAP_EXAMPLE: exampleStatement("priced", options.operatorDoc),
    LOADER_EXAMPLE: exampleStatement("loaded", options.operatorDoc),
    OPERATOR_DOC: operatorDocText(options.operatorDoc),
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
    RUNTIME_STATS: options.flowEvidence
      ? "Tool results can include `- runtime stats:` lines: facts the engine measured while your steps ran. They report rows a step treats in a way its code may not intend: values written differently from what a filter or join looks for, keys that found no match, the same records listed in several files, rows a dedupe removed although they differ, rows marked as excluded, repeated header columns a function never read, or a group key that pools different entities. Runtime stats are very helpful for validating your result: for each one, check whether the step did what you intended and whether the data has a trap the question expects you to handle, then keep or fix the step."
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
//   - "qwen-xml"  — the template in `code-mode.md`, where every operator is
//     one Python function written through `createOrModifyOperator`, plus the
//     `<tools>`/`<tool_call>` appendix (`local-qwen-tools.txt`), composed
//     below. It describes the `# User Task` / `# Current Dataflow` context →
//     paired with the SDK assembler `assembleContext` (server.ts).
//   - "react-text" — the standalone `local-react.txt` (plain-text tool list +
//     `Thought / Action / Action Input / Observation`, down to `Begin!`). It
//     describes the `# Event N` context → paired with `assembleLocalReactContext`.
//
// The model uses the ChatML chat template: the gateway wraps this text as
// `<|im_start|>system\n…<|im_end|>` and the per-turn context as
// `<|im_start|>user\n…<|im_end|>` automatically when the driver sends
// role-tagged messages — so NO framing/BOS tokens belong in these files.
// ---------------------------------------------------------------------------
const QWEN_XML_TEMPLATE: string = readFileSync(new URL("./prompts/code-mode.md", import.meta.url), "utf8");
// The template's context format and worked example describe the layout the
// agent receives: the LATEST `# Current Dataflow` snapshot with each operator's
// code, or the DELTA `# Agent Events` trajectory. The DELTA prompt describes the
// `# Dataflow (compacted)` deck only when compaction can fire.
const QWEN_XML_SECTIONS: Record<"latest" | "delta", { format: string; example: string }> = {
  latest: { format: rd("context-format.latest.code.md"), example: rd("example.latest.code.md") },
  delta: { format: rd("context-format.delta.md"), example: rd("example.delta.md") },
};
const QWEN_XML_COMPACTION: string = rd("compaction.delta.md");
const QWEN_TOOL_APPENDIX: string = readFileSync(new URL("./prompts/local-qwen-tools.txt", import.meta.url), "utf8");
const REACT_TEXT_SYSTEM_PROMPT: string = readFileSync(new URL("./prompts/local-react.txt", import.meta.url), "utf8");
/**
 * Returns the local driver's system prompt for the given tool-call dialect.
 * `react-text` is standalone; `qwen-xml` is the `code-mode.md` template
 * (mode-aware, so it matches the SDK context assembler) plus the XML tool-call
 * appendix.
 */
export function buildLocalReactSystemPrompt(
  dialect: LocalToolDialect,
  contextMode: ContextMode = ContextMode.LATEST,
  compactionEnabled = false
): string {
  if (dialect === "react-text") return REACT_TEXT_SYSTEM_PROMPT;
  const key = contextMode === ContextMode.DELTA ? "delta" : "latest";
  const prompt = QWEN_XML_TEMPLATE.replace("{{CONTEXT_FORMAT}}", QWEN_XML_SECTIONS[key].format)
    .replace("{{COMPACTION}}", key === "delta" && compactionEnabled ? `\n${QWEN_XML_COMPACTION}\n` : "")
    .replace("{{EXAMPLE}}", QWEN_XML_SECTIONS[key].example)
    .replace(/\n{3,}/g, "\n\n");
  return `${prompt.trimEnd()}\n\n${QWEN_TOOL_APPENDIX}`;
}
