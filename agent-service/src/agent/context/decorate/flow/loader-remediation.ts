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

import type { OperatorDecorator, OperatorDecorateCtx } from "../decorator";

/**
 * Flow-L1 (pre-emptive). On a load-stage operator (`DataLoading`) that errored,
 * append a `Loader hint:` remediation line keyed solely on the exception class
 * parsed from the error string. Current snapshot only (inject-once — avoids
 * repeating across FULL-mode history). The dataflow-specific delivery a
 * free-form script agent cannot replicate (it is localized to the load
 * operator boundary).
 */

/** Map an Amber error string to a remediation hint, keyed on exception class.
 *  Exported for reuse/back-compat (was `formatLoaderHint` in context-utils). */
export function formatLoaderHint(errorText: string): string | undefined {
  if (/UnicodeDecodeError|codec can't decode|'utf-8' codec/.test(errorText)) {
    return 'Loader hint: the file is not UTF-8. Re-read with an explicit encoding — try encoding="cp1252" (Windows-1252) first, then encoding="latin-1" (which never fails). Do not retry the default UTF-8.';
  }
  if (/ParserError|Error tokenizing|tokenizing data|Expected \d+ fields/.test(errorText)) {
    return 'Loader hint: CSV parsing failed — likely the wrong delimiter, ragged rows, or metadata/comment lines before the header. Pass an explicit sep=, set engine="python" with on_bad_lines="skip", and/or skiprows= to skip preamble; inspect the first raw lines to find the true header row.';
  }
  if (/FileNotFoundError|No such file|cannot find the (?:file|path)|does not exist/.test(errorText)) {
    return "Loader hint: the path does not exist as written. Use the EXACT file path(s) from the task description verbatim (do not invent directories or rename files); paths may be relative. If a directory or glob is intended, enumerate it and read the matching file(s).";
  }
  if (/ValueError/.test(errorText) && /could not convert|invalid literal|Unable to parse|does not match format/.test(errorText)) {
    return 'Loader hint: a value failed type conversion while loading. Read the affected column(s) as strings first (dtype=str), then clean (strip $, commas, %, whitespace) and convert with pd.to_numeric(..., errors="coerce") or pd.to_datetime(...); or pass the right parse options to the reader.';
  }
  return undefined;
}

export const loaderRemediation: OperatorDecorator = {
  id: "flow.loader_remediation",
  facet: "flow",
  level: 1,
  mode: "preemptive",
  placement: "in-result",
  applies(ctx: OperatorDecorateCtx): boolean {
    return (
      ctx.isCurrent &&
      ctx.op.operatorType === "DataLoading" &&
      !!ctx.info?.error &&
      formatLoaderHint(ctx.info.error) !== undefined
    );
  },
  render(ctx: OperatorDecorateCtx): string[] {
    const hint = ctx.info?.error ? formatLoaderHint(ctx.info.error) : undefined;
    return hint ? hint.split("\n") : [];
  },
};
