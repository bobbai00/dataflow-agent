/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/** Read the deterministic seed artifact emitted by gold_prefix.py. This is
 * deliberately narrower than the tool grammar: every generated line is one
 * Parquet scan with a JSON-quoted literal path. Never silently miss an input. */
export function registeredSeedFiles(changes: string): string[] {
  const files: string[] = [];
  for (const [index, raw] of changes.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[A-Za-z_]\w*\s*=\s*scan\(/.test(line))
      throw new Error(
        "seed.changes uses historical expression-mode syntax; regenerate the gold-prefix inputs with this checkout, or run the historical artifact on its recorded revision."
      );
    const match =
      /^set\s+[A-Za-z_]\w*:\s*scan\(\s*files\s*=\s*("(?:\\.|[^"\\])*")\s*,\s*format\s*=\s*"parquet"\s*\)\s*$/.exec(
        line
      );
    if (!match)
      throw new Error(
        `Unsupported seed.changes line ${index + 1}; regenerate the gold-prefix inputs with this checkout.`
      );
    files.push(JSON.parse(match[1]));
  }
  return files;
}

export function seededRetrievalIds(
  actions: readonly { type?: string; operator_ids?: readonly string[]; operator_id?: string }[],
  seededIds: readonly string[]
): string[] {
  return [
    ...new Set(
      actions
        .filter(action => action.type === "retrieve")
        .flatMap(action =>
          (action.operator_ids ?? (action.operator_id ? [action.operator_id] : [])).filter(id => seededIds.includes(id))
        )
    ),
  ];
}

/** Report direct file reads in the selected entry source. Shared helper bodies
 * are not attributed to every operator that carries the same namespace. */
export function directFileReadOperators(
  operators: readonly {
    operatorID: string;
    nativeOp?: { type: string; registeredName?: string; functions?: unknown };
  }[],
  namespace?: { functions: Record<string, { source: string }> }
): string[] {
  return operators
    .filter(op => {
      const view = op.nativeOp;
      const entry = view?.registeredName;
      const source =
        entry && namespace && Object.hasOwn(namespace.functions, entry)
          ? namespace.functions[entry].source
          : JSON.stringify(view?.functions ?? {});
      return view?.type === "Scan" || /read_csv|read_parquet|read_excel/.test(source);
    })
    .map(op => op.operatorID);
}
