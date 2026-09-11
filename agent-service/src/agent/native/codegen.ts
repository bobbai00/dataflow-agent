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
 * Native operator → Python code. Each native operator compiles to ONE
 * `def load()` (Scan) or `def process(<inputs>)` body:
 *
 *   - Filter / Compute / Aggregate carry SQL fragments the agent wrote, so
 *     they run as one DuckDB statement over the input DataFrame (DuckDB is a
 *     worker dependency; SQL scalar/aggregate semantics, NULL handling and
 *     regex come for free, and no SQL→pandas translator is needed).
 *   - Project / Join / Union / Distinct / Sort / Limit have no expressions and
 *     compile to the equivalent pandas call.
 *   - Scan compiles to DuckDB `read_csv` (multi-file glob, union by name,
 *     header / skip / names / all_varchar) with pandas fallbacks for xlsx /
 *     html / json and a raw-line `preview` mode.
 *
 * The generated code is what the engine runs; the agent only ever sees the
 * type + properties. Parameter values are embedded as JSON literals, which
 * Python parses as string/dict/list literals verbatim.
 */

import { NATIVE_BY_TYPE, NATIVE_ID_RE, type NativeOpView } from "./catalog";

export interface CompiledNativeOp {
  /** `DataLoading` for Scan (and a UDF whose code defines `load`), else `DataProcessing`. */
  operatorType: "DataLoading" | "DataProcessing";
  code: string;
}

/** A Python literal for any JSON value (JSON string escapes are valid Python). */
function py(v: unknown): string {
  return JSON.stringify(v)
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None");
}

/** Quote a column name as a DuckDB identifier. */
function ident(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Shared DuckDB prelude: register the input frame(s) with duplicate-safe names and
 *  mixed-type object columns coerced to text so DuckDB's pandas scan never rejects them. */
const DUCK_PRELUDE = `    import duckdb
    def _ready(f):
        g = f.copy()
        seen, names = {}, []
        for c in g.columns:
            c = str(c); k = seen.get(c, 0); seen[c] = k + 1
            names.append(c if k == 0 else c + '_' + str(k))
        g.columns = names
        for c in list(g.columns):
            s = g[c]
            if s.dtype == object:
                nn = s.dropna()
                if len(nn) and not nn.map(lambda v: isinstance(v, str)).all():
                    g[c] = s.where(s.isna(), s.astype(str))
        return g
    _con = duckdb.connect()
`;

function compileScan(p0: Record<string, any>): string {
  // `format: "whitespace"` is the natural way to ask for space-aligned columns; it means `delim: "whitespace"`.
  const p: Record<string, any> = p0.format === "whitespace" ? { ...p0, format: "csv", delim: "whitespace" } : p0;
  const files = Array.isArray(p.files) ? p.files : [p.files];
  const header = p.header !== false;
  const skip = Number(p.skipLines ?? 0);
  const allText = Boolean(p.allText);
  const encoding = typeof p.encoding === "string" && p.encoding.trim() ? p.encoding.trim() : null;
  if (Array.isArray(p.columns) && header && !p.preview) {
    throw new Error(
      "`columns` names the columns of a header-less file and needs `header: false`. This scan keeps the file's header row: drop `columns` and add a `project` with `keep` to select columns."
    );
  }
  const sqlLit = (s: unknown) => "'" + String(s).replace(/'/g, "''") + "'";
  const L: string[] = [];
  L.push("def load():");
  L.push("    import glob, os, json, duckdb, pandas as pd");
  L.push(`    _pats = ${py(files)}`);
  L.push("    files = sorted(set(f for pat in _pats for f in (glob.glob(pat) if any(ch in pat for ch in '*?[') else [pat])))");
  // A wrong path is the most common Scan failure (the task text says `omni2.txt`,
  // the lake has `omni2.text`): name the directory's actual files in the error.
  L.push("    def _not_found(paths):");
  L.push("        hints = []");
  L.push("        for q in paths[:3]:");
  L.push("            d = os.path.dirname(q) or '.'");
  L.push("            if os.path.isdir(d):");
  L.push("                names = sorted(os.listdir(d))");
  L.push("                hints.append(d + '/ contains: ' + ', '.join(names[:40]) + (' ...' if len(names) > 40 else ''))");
  L.push("            else:");
  L.push("                parent = os.path.dirname(d.rstrip('/')) or '.'");
  L.push("                hints.append('no directory ' + d + (' (' + parent + '/ contains: ' + ', '.join(sorted(os.listdir(parent))[:40]) + ')' if os.path.isdir(parent) else ''))");
  L.push("        raise FileNotFoundError('not found: ' + ', '.join(paths) + '. ' + ' | '.join(hints))");
  L.push("    if not files:");
  L.push("        _not_found(_pats)");
  L.push("    missing = [f for f in files if not os.path.exists(f)]");
  L.push("    if missing:");
  L.push("        _not_found(missing)");
  L.push("    ext = os.path.splitext(files[0])[1].lower()");
  L.push(`    fmt = ${py(p.format ?? "auto")}`);
  L.push("    if fmt == 'auto':");
  L.push("        if ext in ('.xlsx', '.xls', '.xlsm'): fmt = 'excel'");
  L.push("        elif ext in ('.html', '.htm'): fmt = 'html'");
  L.push("        elif ext in ('.json', '.jsonl', '.ndjson'): fmt = 'json'");
  L.push("        elif ext == '.parquet': fmt = 'parquet'");
  L.push("        elif ext in ('.gpkg', '.shp', '.npz', '.npy', '.cdf', '.nc', '.h5', '.hdf5', '.pkl', '.zip', '.gz', '.db', '.sqlite'): fmt = 'binary'");
  L.push("        else: fmt = 'csv'");
  L.push("    BINARY_HINT = 'binary format ' + ext + ': scan reads text tables, xlsx, html, json and parquet; read this file with a udf loader (geopandas.read_file for .gpkg/.shp, numpy.load for .npz, cdflib for .cdf)'");
  L.push(`    file_col = ${py(p.fileColumn ?? null)}`);
  L.push("    def _tag(d, f):");
  L.push("        if file_col: d[file_col] = os.path.basename(f)");
  L.push("        return d");
  // Text encoding: the given one, else utf-8 unless the file's first 4 MB say
  // otherwise (then cp1252, which covers the latin-1 / Windows exports seen in
  // practice). DuckDB only reads utf-8, so anything else takes the pandas path.
  L.push(`    _enc = ${py(encoding)}`);
  L.push("    def _text_enc(f):");
  L.push("        if _enc: return _enc");
  L.push("        with open(f, 'rb') as fh: b = fh.read(1 << 22)");
  L.push("        try:");
  L.push("            b.decode('utf-8'); return 'utf-8'");
  L.push("        except UnicodeDecodeError:");
  L.push("            return 'cp1252'");
  if (p.preview) {
    // ---- preview: raw lines for text; sheet / table heads for excel and html; a pointer for binary
    L.push(`    n = ${Number(p.preview)}`);
    // A sheet or html row becomes one text line (cells joined by ' | ', trailing
    // empty cells dropped), so the preview reads like the raw-line preview of a
    // csv and shows where the header row is.
    L.push("    def _row_line(vals):");
    L.push("        cells = ['' if (v is None or (isinstance(v, float) and v != v)) else str(v) for v in vals]");
    L.push("        while cells and cells[-1] == '': cells.pop()");
    L.push("        return ' | '.join(cells)");
    L.push("    if fmt == 'excel':");
    L.push("        rows = []");
    L.push("        xl = pd.ExcelFile(files[0])");
    L.push("        for sh in xl.sheet_names:");
    L.push("            d = xl.parse(sh, header=None, nrows=n, dtype=str)");
    L.push("            for i, r in enumerate(d.itertuples(index=False)):");
    L.push("                rows.append({'sheet': sh, 'row_no': i, 'line': _row_line(r)})");
    L.push("        return pd.DataFrame(rows, columns=['sheet', 'row_no', 'line'])");
    L.push("    if fmt == 'html':");
    L.push("        rows = []");
    L.push("        for i, t in enumerate(pd.read_html(files[0])):");
    L.push("            rows.append({'table': i, 'row_no': 0, 'line': _row_line([str(c) for c in t.columns])})");
    L.push("            for k, r in enumerate(t.head(n).itertuples(index=False), 1):");
    L.push("                rows.append({'table': i, 'row_no': k, 'line': _row_line(r)})");
    L.push("        return pd.DataFrame(rows, columns=['table', 'row_no', 'line'])");
    L.push("    if fmt == 'binary':");
    L.push("        return pd.DataFrame({'file': [os.path.basename(f) for f in files], 'size_bytes': [os.path.getsize(f) for f in files], 'note': [BINARY_HINT] * len(files)})");
    L.push("    rows = []");
    L.push("    for f in files[:5]:");
    L.push("        with open(f, 'r', encoding=_text_enc(f), errors='replace') as fh:");
    L.push("            for i, line in enumerate(fh):");
    L.push("                if i >= n:");
    L.push("                    break");
    L.push("                rows.append({'file': os.path.basename(f), 'line_no': i, 'line': line.rstrip('\\n\\r')})");
    L.push("    return pd.DataFrame(rows, columns=['file', 'line_no', 'line'])");
    return L.join("\n");
  }
  L.push("    parts = []");
  // ---- lines: every line of every file is a row; parse it downstream with compute
  L.push("    if fmt == 'lines':");
  L.push("        for f in files:");
  L.push("            with open(f, 'r', encoding=_text_enc(f), errors='replace') as fh:");
  L.push(`                ls = [l.rstrip('\\n\\r') for l in fh][${skip}:]`);
  L.push("            parts.append(_tag(pd.DataFrame({'line_no': range(len(ls)), 'line': ls}), f))");
  L.push("        return pd.concat(parts, ignore_index=True, sort=False)");
  L.push("    if fmt == 'binary':");
  L.push("        raise ValueError(BINARY_HINT)");
  // ---- excel / html / json / parquet
  L.push("    if fmt == 'excel':");
  L.push("        for f in files:");
  L.push(
    `            parts.append(_tag(pd.read_excel(f, sheet_name=${py(p.sheet ?? 0)}, header=${header ? "0" : "None"}, skiprows=${skip}` +
      (Array.isArray(p.columns) ? `, names=${py(p.columns)}` : "") +
      (allText ? ", dtype=str" : "") +
      "), f))"
  );
  L.push("        return pd.concat(parts, ignore_index=True, sort=False)");
  L.push("    if fmt == 'html':");
  L.push("        for f in files:");
  L.push(`            tables = pd.read_html(f, header=${header ? "0" : "None"}, skiprows=${skip || "None"})`);
  L.push(`            parts.append(_tag(tables[${py(typeof p.sheet === "number" ? p.sheet : 0)}], f))`);
  L.push("        return pd.concat(parts, ignore_index=True, sort=False)");
  L.push("    if fmt == 'json':");
  L.push("        for f in files:");
  L.push("            with open(f, 'r', encoding=_text_enc(f), errors='replace') as fh: txt = fh.read()");
  L.push("            try:");
  L.push("                j = json.loads(txt)");
  L.push("            except ValueError:");
  L.push("                j = [json.loads(l) for l in txt.splitlines() if l.strip()]");
  L.push("            if isinstance(j, dict) and all(not isinstance(v, (dict, list)) for v in j.values()):");
  L.push("                d = pd.DataFrame({'key': list(j.keys()), 'value': list(j.values())})");
  L.push("            elif isinstance(j, dict) and all(isinstance(v, list) for v in j.values()) and len({len(v) for v in j.values()}) == 1:");
  L.push("                d = pd.DataFrame(j)");
  L.push("            else:");
  L.push("                d = pd.json_normalize(j)");
  L.push("            parts.append(_tag(d, f))");
  L.push("        return pd.concat(parts, ignore_index=True, sort=False)");
  L.push("    if fmt == 'parquet':");
  L.push("        return duckdb.connect().sql('SELECT * FROM read_parquet([' + ', '.join(\"'\" + f.replace(\"'\", \"''\") + \"'\" for f in files) + '], union_by_name=true)').df()");
  // ---- pandas text readers: fixed width, whitespace-aligned, commented, non-utf-8
  const pdCommon =
    `header=${header ? "0" : "None"}, skiprows=${skip}` +
    (Array.isArray(p.columns) ? `, names=${py(p.columns)}` : "") +
    (allText ? ", dtype=str" : "") +
    (p.comment ? `, comment=${py(String(p.comment).slice(0, 1))}` : "") +
    ", encoding=_text_enc(f), encoding_errors='replace'";
  L.push("    if fmt == 'fwf':");
  L.push("        for f in files:");
  L.push(`            parts.append(_tag(pd.read_fwf(f${Array.isArray(p.widths) ? `, widths=${py(p.widths)}` : ""}, ${pdCommon}), f))`);
  L.push("        return pd.concat(parts, ignore_index=True, sort=False)");
  const pandasCsv = p.delim === "whitespace" ? `sep=r'\\s+', engine='python'` : `sep=${py(p.delim ?? ",")}`;
  L.push("    def _pandas_csv():");
  L.push("        for f in files:");
  L.push(`            parts.append(_tag(pd.read_csv(f, ${pandasCsv}, ${pdCommon}), f))`);
  L.push("        return pd.concat(parts, ignore_index=True, sort=False)");
  if (p.delim === "whitespace" || p.comment) {
    L.push("    return _pandas_csv()");
    return L.join("\n");
  }
  L.push("    if any(_text_enc(f).lower() not in ('utf-8', 'utf8') for f in files):");
  L.push("        return _pandas_csv()");
  // ---- utf-8 delimited text: DuckDB read_csv over all files at once
  const opts: string[] = [`header=${header ? "true" : "false"}`, `skip=${skip}`, "union_by_name=true"];
  if (Array.isArray(p.columns)) opts.push(`names=[${p.columns.map(sqlLit).join(", ")}]`);
  if (allText) opts.push("all_varchar=true");
  if (p.delim) opts.push(`delim=${sqlLit(p.delim)}`);
  if (p.fileColumn) opts.push("filename=true");
  L.push("    _con = duckdb.connect()");
  L.push("    flist = '[' + ', '.join(\"'\" + f.replace(\"'\", \"''\") + \"'\" for f in files) + ']'");
  L.push(`    d = _con.sql('SELECT * FROM read_csv(' + flist + ', ${opts.join(", ").replace(/'/g, "\\'")})').df()`);
  if (p.fileColumn) {
    L.push(`    d[${py(p.fileColumn)}] = d['filename'].map(os.path.basename)`);
    L.push("    d = d.drop(columns=['filename'])");
  }
  L.push("    return d");
  return L.join("\n");
}

function sqlStage(inputName: string, sqlBuilder: string[], post: string[] = []): string {
  // sqlBuilder: python lines that define `q` (the SQL string) — `t` is registered.
  // post: optional python lines run over the result frame `d` before returning.
  return [
    `def process(${inputName}):`,
    DUCK_PRELUDE.trimEnd(),
    `    t = _ready(${inputName})`,
    "    if t.shape[1] == 0:",
    "        return t",
    "    _con.register('t', t)",
    ...sqlBuilder,
    "    d = _con.sql(q).df()",
    "    for _c in d.columns:",
    "        if str(d[_c].dtype).startswith('timedelta'):",
    "            d[_c] = d[_c].dt.total_seconds()",
    ...post,
    "    return d",
  ].join("\n");
}

function compileFilter(p: Record<string, any>, inp: string): string {
  return sqlStage(inp, [`    q = 'SELECT * FROM t WHERE (' + ${py(String(p.predicate))} + ')'`]);
}

function compileCompute(p: Record<string, any>, inp: string): string {
  return sqlStage(inp, [
    `    cols = ${py(p.columns)}`,
    "    qn = lambda c: '\"' + str(c).replace('\"', '\"\"') + '\"'",
    "    rep = [f'({e}) AS ' + qn(c) for c, e in cols.items() if c in t.columns]",
    "    new = [f'({e}) AS ' + qn(c) for c, e in cols.items() if c not in t.columns]",
    "    sel = '*' + (' REPLACE (' + ', '.join(rep) + ')' if rep else '')",
    "    q = 'SELECT ' + sel + (', ' + ', '.join(new) if new else '') + ' FROM t'",
  ]);
}

const AGG_SQL: Record<string, (c: string | undefined) => string> = {
  sum: c => `SUM(${c})`,
  count: c => (c ? `COUNT(${c})` : "COUNT(*)"),
  avg: c => `AVG(${c})`,
  mean: c => `AVG(${c})`,
  min: c => `MIN(${c})`,
  max: c => `MAX(${c})`,
  median: c => `MEDIAN(${c})`,
  count_distinct: c => `COUNT(DISTINCT ${c})`,
  string_agg: c => `STRING_AGG(${c}, ', ')`,
  first: c => `FIRST(${c})`,
  stddev: c => `STDDEV(${c})`,
};

function compileAggregate(p: Record<string, any>, inp: string): string {
  const keys: string[] = Array.isArray(p.groupBy) ? p.groupBy : [];
  const parts: string[] = keys.map(k => ident(k));
  for (const a of p.aggregations as Array<{ fn: string; col?: string; as?: string }>) {
    const fn = AGG_SQL[a.fn];
    if (!fn) throw new Error(`unknown aggregation function "${a.fn}"`);
    if (a.fn !== "count" && !a.col) throw new Error(`aggregation "${a.fn}" needs a col`);
    const alias = a.as ?? (a.col ? `${a.fn}_${a.col}` : "count");
    parts.push(`${fn(a.col ? ident(a.col) : undefined)} AS ${ident(alias)}`);
  }
  const groupBy = keys.length > 0 ? ` GROUP BY ${keys.map(k => ident(k)).join(", ")}` : "";
  const q = `SELECT ${parts.join(", ")} FROM t${groupBy}`;
  // DuckDB sums integers into HUGEINT, which pandas receives as float64; give
  // integral results back their integer dtype so `243377` does not render as `243377.0`.
  return sqlStage(inp, [`    q = ${py(q)}`], [
    "    for c in d.columns:",
    "        s = d[c]",
    "        if s.dtype.kind == 'f' and s.notna().all() and len(s) and (s % 1 == 0).all() and s.abs().max() < 9.2e18:",
    "            d[c] = s.astype('int64')",
  ]);
}

function compileProject(p: Record<string, any>, inp: string): string {
  const lines = [`def process(${inp}):`, `    d = ${inp}`];
  if (Array.isArray(p.keep)) lines.push(`    d = d[${py(p.keep)}]`);
  if (Array.isArray(p.drop)) lines.push(`    d = d.drop(columns=${py(p.drop)})`);
  if (p.rename && typeof p.rename === "object") lines.push(`    d = d.rename(columns=${py(p.rename)})`);
  lines.push("    return d");
  return lines.join("\n");
}

const JOIN_HOW: Record<string, string> = { inner: "inner", left: "left", right: "right", full: "outer" };

function compileJoin(p: Record<string, any>, inputs: string[]): string {
  const [l, r] = inputs;
  // Self-join (the same table on both sides, e.g. year vs year-1): one
  // parameter, used twice.
  const params = l === r ? l : `${l}, ${r}`;
  const on = (p.on ?? []) as Array<[string, string]>;
  if (on.length === 0 || p.type === "cross") {
    // Cross join: every left row paired with every right row (the way to put two
    // one-row results side by side before a Compute).
    return [
      `def process(${params}):`,
      "    import pandas as pd",
      `    return ${l}.merge(${r}, how='cross', suffixes=('', '_right'))`,
    ].join("\n");
  }
  const leftOn = on.map(x => x[0]);
  const rightOn = on.map(x => x[1]);
  const how = JOIN_HOW[p.type ?? "inner"] ?? "inner";
  return [
    `def process(${params}):`,
    "    import pandas as pd",
    `    return ${l}.merge(${r}, left_on=${py(leftOn)}, right_on=${py(rightOn)}, how=${py(how)}, suffixes=('', '_right'))`,
  ].join("\n");
}

function compileUnion(inputs: string[]): string {
  return [
    `def process(${inputs.join(", ")}):`,
    "    import pandas as pd",
    `    return pd.concat([${inputs.join(", ")}], ignore_index=True, sort=False)`,
  ].join("\n");
}

function compileDistinct(p: Record<string, any>, inp: string): string {
  const subset = Array.isArray(p.columns) ? `subset=${py(p.columns)}` : "";
  return [`def process(${inp}):`, `    return ${inp}.drop_duplicates(${subset}).reset_index(drop=True)`].join("\n");
}

function compileSort(p: Record<string, any>, inp: string): string {
  const by = (p.by as Array<{ col: string; desc?: boolean }>).map(b => b.col);
  const asc = (p.by as Array<{ col: string; desc?: boolean }>).map(b => !b.desc);
  return [
    `def process(${inp}):`,
    `    return ${inp}.sort_values(by=${py(by)}, ascending=${py(asc)}, kind='mergesort').reset_index(drop=True)`,
  ].join("\n");
}

function compileLimit(p: Record<string, any>, inp: string): string {
  const off = Number(p.offset ?? 0);
  const n = Number(p.n);
  return [`def process(${inp}):`, `    return ${inp}.iloc[${off}:${off + n}].reset_index(drop=True)`].join("\n");
}

/** Validate id / input shape and compile one native operator to Python. Throws on a
 *  malformed view — the tool turns that into an `[ERROR]` result for the agent. */
export function compileNativeOp(view: NativeOpView): CompiledNativeOp {
  const def = NATIVE_BY_TYPE.get(view.type);
  if (!def) throw new Error(`unknown native operator type "${view.type}"`);
  const inputs = view.inputs ?? [];
  for (const id of inputs) {
    if (!NATIVE_ID_RE.test(id)) throw new Error(`input operator id "${id}" is not a valid identifier`);
  }
  if (new Set(inputs).size !== inputs.length && view.type !== "Join") {
    throw new Error(`inputs must be distinct operators (got ${inputs.join(", ")})`);
  }
  if (def.inputs === 0 && inputs.length !== 0 && view.type !== "UDF") {
    throw new Error(`${view.type} takes no inputs`);
  }
  if (def.inputs === 1 && inputs.length !== 1) throw new Error(`${view.type} takes exactly one input`);
  if (def.inputs === 2 && inputs.length !== 2) throw new Error(`${view.type} takes exactly two inputs [left, right]`);
  if (def.inputs === "many" && view.type === "Union" && inputs.length < 2) {
    throw new Error("Union needs at least two inputs");
  }
  const p = view.properties as Record<string, any>;
  switch (view.type) {
    case "Scan":
      return { operatorType: "DataLoading", code: compileScan(p) };
    case "Filter":
      return { operatorType: "DataProcessing", code: compileFilter(p, inputs[0]) };
    case "Project":
      return { operatorType: "DataProcessing", code: compileProject(p, inputs[0]) };
    case "Compute":
      return { operatorType: "DataProcessing", code: compileCompute(p, inputs[0]) };
    case "Aggregate":
      return { operatorType: "DataProcessing", code: compileAggregate(p, inputs[0]) };
    case "Join":
      return { operatorType: "DataProcessing", code: compileJoin(p, inputs) };
    case "Union":
      return { operatorType: "DataProcessing", code: compileUnion(inputs) };
    case "Distinct":
      return { operatorType: "DataProcessing", code: compileDistinct(p, inputs[0]) };
    case "Sort":
      return { operatorType: "DataProcessing", code: compileSort(p, inputs[0]) };
    case "Limit":
      return { operatorType: "DataProcessing", code: compileLimit(p, inputs[0]) };
    case "UDF": {
      const code = String(p.code ?? "");
      const m = /def\s+(\w+)\s*\(([^)]*)\)/.exec(code);
      if (!m) throw new Error("UDF code must define `def load()` or `def process(<input ids>)`");
      const params = m[2]
        .split(",")
        .map(s => s.trim().split(":")[0].split("=")[0].trim())
        .filter(Boolean);
      if (m[1] === "load" || params.length === 0) {
        if (inputs.length > 0) throw new Error("a UDF with no parameters is a loader and takes no inputs");
        return { operatorType: "DataLoading", code };
      }
      if (params.length !== inputs.length || params.some((q, i) => q !== inputs[i])) {
        throw new Error(
          `UDF parameters (${params.join(", ")}) must equal the input operator ids in order (${inputs.join(", ")})`
        );
      }
      return { operatorType: "DataProcessing", code };
    }
    default:
      throw new Error(`no compiler for "${view.type}"`);
  }
}
