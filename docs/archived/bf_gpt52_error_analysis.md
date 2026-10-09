# Error Analysis — `DataflowSystemGPT52LatestStatsOn` (BF-Gpt52)

Source: `bobflow/Kramabench/system_scratch/DataflowSystemGPT52LatestStatsOn/` — 104 tasks across 6 workloads (archeology, astronomy, biomedical, environment, legal, wildfire).

Methodology:
- Walked every `react_steps.json` file, scanned every step's `inputMessages`.
- Located every operator block (`### Operator \`name\` (...)`) containing `[ERROR]`.
- Deduplicated by `(task, operator_id, MD5(error message line))` so the same error appearing in multiple consecutive snapshots is counted once.
- Excluded **cascade stubs** (`(skipped — upstream operator \`X\` errored; see [ERROR] above)`) because they are not real failures — they're placeholder blocks shown when an upstream operator failed.

Totals:
- **319** raw appearances of `[ERROR]` operator blocks across all snapshots
- **146** unique errors after dedup
- **26** of those are cascade stubs (no line marker by design — they didn't execute)
- **120** unique origin errors (the real failures analyzed below)

---

## Summary table

| Category | Count | % of origin errors | Suspicious? |
|---|---|---|---|
| Texera schema marshaling (`AttributeType.*`) | 3 | 2.5% | **Framework** |
| NumPy ndarray → pandas boundary (`unhashable type: 'numpy.ndarray'`) | 1 | 0.8% | **Framework** |
| Missing scientific Python packages | 2 | 1.7% | **Runtime image** |
| Pandas semantic / API surprises (`TypeError` family) | 4 | 3.3% | **Library** |
| Library-specific `AttributeError` (`CDFInfo`) | 1 | 0.8% | **Library** |
| Prompt-induced `UnicodeDecodeError` (Win-1252 / Latin-1 bytes) | 18 | 15.0% | **Prompt-induced** |
| Conventional user-code bugs (KeyError, FileNotFoundError, ValueError, etc.) | 91 | 75.8% | normal |

**Top-line read**: ~24% of origin errors (29 of 120) are not "regular user-code bugs" — they're framework / runtime / prompt-induced failures that the agent has limited or no way to recover from with its current toolset.

---

## 1. Texera schema marshaling — framework boundary (3 errors)

The Texera backend's `AttributeType` enum doesn't map every Python type the UDF surfaces. When the marshaller hits an unsupported type, it raises `TypeError`/`KeyError` *outside* user code, so the error has no user-line annotation.

| Task | Operator | Error |
|---|---|---|
| `astronomy-easy-3` | `initialMidAltMidnight2015` | `TypeError: Unmatched type for field 'date', expected AttributeType.TIMESTAMP, got 2015-01-02 (<class 'datetime.date'>) instead.` |
| `astronomy-hard-12` | `loadMockField` | `KeyError: <AttributeType.LIST: 9>` |
| `astronomy-hard-12` | `loadMockFieldArrays` | `KeyError: <AttributeType.LIST: 9>` |

**Diagnosis**:
- `datetime.date` vs `pandas.Timestamp` / `datetime.datetime` — the marshaller only accepts the latter.
- `AttributeType.LIST` (enum value 9) has no handler — the agent tried to surface a list-valued column.

**Agent's recourse**: minimal. The UDF needs to coerce types to ones the marshaller knows about before returning. The Texera prompt could be augmented with: "Return only scalar columns; explode list-valued columns first; cast `date` to `pd.to_datetime(...)` before returning."

**Fix lives in**: Texera backend marshaller (add handlers) **and/or** system prompt (add coercion guidance).

---

## 2. NumPy ndarray → pandas boundary (1 error)

| Task | Operator | Error |
|---|---|---|
| `astronomy-hard-12` | `loadMockFieldArrays` | `TypeError: unhashable type: 'numpy.ndarray'` |

**Diagnosis**: an `ndarray` ended up where pandas requires a hashable value — DataFrame column header, index entry, or `groupby` key. Pandas raises at construction time, so the traceback lands inside pandas internals — no user-line annotation surfaces.

**Agent's recourse**: rewrite the operator to convert arrays to tuples or scalars before they hit pandas constructors. The agent can recover here but it's hard to debug without a clear "which line broke" pointer.

**Fix lives in**: better error formatter that points at the offending user-code construct, OR a prompt note: "When wrapping NumPy results into a DataFrame, convert array-valued cells with `.tolist()` or split into multiple scalar columns."

---

## 3. Missing scientific Python packages (2 errors — runtime image gap)

| Task | Operator | Error |
|---|---|---|
| `astronomy-easy-5` | `altitudeFromTle` | `ImportError: skifield is required for this task (cannot import skifield.itrf_xyz).` |
| `astronomy-hard-11` | `predictMsisDensity` | `ModuleNotFoundError: No module named 'nrlmsise00'` |

**Diagnosis**:
- `skifield` is a typo (the real package is `skyfield`) — the error came from the agent's own code raising a hand-written `ImportError`, but it reveals the package itself isn't there.
- `nrlmsise00` (NRL MSIS atmospheric density model) isn't installed in the agent's runtime image.

**Agent's recourse**: none. The agent cannot install packages. Re-runs will keep failing on these two tasks.

**Fix lives in**: agent runtime image — add `skyfield` and `nrlmsise00` to the Python environment.

---

## 4. Pandas semantic / API surprises (4 errors — library-level)

The user code is essentially correct but trips on a pandas pitfall:

| Task | Operator | Error |
|---|---|---|
| `astronomy-easy-5` | `majorAltitudeChanges2024` | `TypeError: Cannot use .astype to convert from timezone-naive dtype to timezone-aware dtype. Use obj.tz_localize instead or series.dt.tz_localize instead` |
| `astronomy-hard-11` | `predictMsisDensity` | `TypeError: create_options() got an unexpected keyword argument 'f107a'. Did you mean 'f107'?` |
| `environment-hard-10` | `parseWollastonTidy` | `TypeError: boolean value of NA is ambiguous` |
| `wildfire-hard-17` | `stationIdKeyCheck` | `TypeError: cannot safely cast non-equivalent float64 to int64` |

**Diagnosis**: pandas gotchas the model needs to know about — tz-naive vs tz-aware, NA truthiness, lossy int casting. The `f107a` case is `nrlmsise00`'s API drift.

**Agent's recourse**: rewrite the operator with the workaround pandas suggests in the error message. The model usually does — these are recoverable.

**Fix lives in**: nothing to fix — these are normal pandas behavior. Could add a "common pandas pitfalls" appendix to the prompt for the agent to consult.

---

## 5. Library-specific AttributeError (1 error)

| Task | Operator | Error |
|---|---|---|
| `astronomy-hard-8` | `inspectSwarmCdf` | `AttributeError: 'CDFInfo' object has no attribute 'get'` |

**Diagnosis**: `cdflib` (CDF — Common Data Format used for ESA Swarm satellite data) returns a class instance, not a dict. The agent assumed dict-like access.

**Fix lives in**: prompt note "library objects may not be dict-like; inspect with `dir(...)` or library docs" — or load the package's signature into context.

---

## 6. Prompt-induced UnicodeDecodeError (18 errors — biggest single category)

By far the largest "framework-flavored" category. 17 of 18 are inside `inspect*` operators, which are created because BF's system prompt **mandates** an inspection step before every real loader.

The inspection template uses `pd.read_csv(...)` (UTF-8 default) with no `encoding=` fallback. Real-world files saved from Excel or older systems contain Windows-1252 / Latin-1 bytes that aren't valid UTF-8 — the inspection step blows up immediately.

| Byte | Character meaning | Count |
|---|---|---|
| `0x92` | Windows-1252 right single quote `'` | 7 |
| `0x93` | Windows-1252 left double quote `"` | 5 |
| `0xa0` | Latin-1 non-breaking space | 4 |
| `0x96` | Windows-1252 en-dash `–` | 1 |
| `0xf3` | Latin-1 lower-case `ó` | 1 |

The 17 inspection-step errors are distributed across `legal` and `wildfire` tasks:

| Task | Operator |
|---|---|
| `legal-easy-12` | `inspectCategories` |
| `legal-easy-13` | `inspectCategories` |
| `legal-hard-17` | `inspectCategories` |
| `legal-hard-18` | `inspectReportCategories` |
| `legal-hard-22` | `inspectIdentityTheft` |
| `legal-hard-23` | `inspectIdentity` |
| `legal-hard-23` | `inspectFraudOther` |
| `legal-hard-24` | `inspectStateIdentityTheft` |
| `legal-hard-24` | `inspectStateFraudOther` |
| `legal-hard-28` | `inspectCategories` |
| `wildfire-easy-15` | `inspectVariableDescrip` |
| `wildfire-hard-16` | `inspectNoaaVarDesc` |
| `wildfire-hard-17` | `inspectNoaaVariabledescrip` |
| `wildfire-hard-18` | `inspectNoaaVarDesc` |
| `wildfire-hard-19` | `inspectVariableDescrip` |
| `wildfire-hard-20` | `inspectVariableDescrip` |
| `wildfire-hard-21` | `inspectVarDesc` |

Plus one in a real loader (not an inspection op): `legal-hard-8 / metroFraud` — same pattern, different file position.

**Diagnosis**: not really a framework bug — the agent could in principle add `encoding=` itself. But the inspection template in the system prompt offers no such fallback, so the model defaults to UTF-8 and hits the same wall across many tasks.

**Fix lives in**: system prompt. Two-line addition would eliminate ~14% of all origin errors in the run:

> When `pd.read_csv` raises `UnicodeDecodeError`, retry with `encoding='latin-1'` or `encoding='cp1252'`. Many real-world CSVs from Excel use Windows-1252 encoding (smart quotes, en-dashes, non-breaking spaces).

Or change the inspection template itself to default to `encoding='latin-1'` (which is lossless byte-passthrough and never raises on these bytes).

---

## 7. Conventional user-code bugs (91 errors — for reference)

| Exception class | Count | Typical cause |
|---|---|---|
| `KeyError` | 29 | Picked wrong column name (after a typo or stale assumption) |
| `FileNotFoundError` | 22 | Wrong path — often dropping a date suffix or capitalization mismatch |
| `ParserError` | 20 | Pandas tried `read_csv` on text that isn't CSV (e.g. OMNI2 `.txt` is fixed-width: `Expected 2 fields in line 4, saw 6`) |
| `ValueError` | 16 | Various — bad parsing, wrong shape, invalid literal |
| `TypeError` | 6 (after subtracting framework ones above) | Various |
| `AttributeError` | 1 (after subtracting `cdflib`) | `'DataFrame' object has no attribute 'str'` — `.str` accessor needs a Series |
| `IntCastingNaNError` | 1 | Cast NaN to int |

These are normal failures the agent is expected to recover from by rewriting the operator. They don't indicate any system-level issue.

---

## Actionable recommendations (in priority order)

1. **Fix the inspection template's UTF-8 default** (system prompt change). Single highest-impact change: eliminates ~14% of origin errors (17 + likely the 1 real-loader case too). Either:
   - Add a retry rule in the prompt, or
   - Change the inspection template to use `encoding='latin-1'` by default (lossless on bytes).

2. **Install missing astronomy packages in the runtime image**: `skyfield`, `nrlmsise00`. Unblocks at least 2 tasks; without this fix, those tasks will never succeed regardless of agent quality.

3. **Add handlers to the Texera marshaller** for `datetime.date` and `AttributeType.LIST`. Affects 3 origin errors (astronomy-easy-3, astronomy-hard-12 twice). Could alternatively be fully prompt-side: "Return only scalar columns; cast `date` to `pd.to_datetime(...)` before returning; explode list-valued columns first."

4. **Improve error formatter for pandas-internal failures**. When the traceback bottoms out inside pandas/numpy, the BF format currently shows just the error class + the operator code listing (no `> N |` arrow). Adding a "no user-line could be identified — likely a pandas construction issue at boundary" hint would help the model orient faster.

5. **Add a "common library pitfalls" appendix** to the system prompt covering: tz-naive vs tz-aware, pandas NA truthiness, `.str` requires Series not DataFrame, library objects often aren't dict-like. Affects ~5 errors.

---

## Appendix — full method

Script used for this analysis lives in chat transcript. Key decisions:

- **Dedup key**: `(task_id, operator_id, MD5(error_message_line))`. The same operator may appear in many snapshots; we count each unique `(operator × error)` pair once.
- **Cascade exclusion**: blocks containing `(skipped — upstream operator` are filtered out — they are placeholder stubs Texera inserts for downstream nodes when an upstream one errors.
- **Line-marker detection** (used for an earlier separate question): regex matches on `at line \d+ in`, `\(line \d+\)`, or `^\s*>\s*\d+\s*\|`. 116/120 origin errors carry a line marker; the 4 that don't are exactly the Texera-schema (3) and the unhashable-ndarray (1) cases.
- **Category assignment** is "first match wins" against ordered patterns, so an error counted as Texera-schema isn't double-counted as a TypeError.
