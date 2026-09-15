# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""Embedded in native operators only when nativeFlowEvidence is enabled.

These checks observe full in-memory inputs and outputs. They never sample a
table and then assert a population fact. Diagnostic failures cannot fail the
operation. Candidate searches and emitted evidence are bounded; measured
counts use all rows. The worker copies this DataFrame metadata to the reserved
result-statistics channel; no user data column or stdout envelope is added.
"""


def _native_flow_value(value):
    import pandas as pd
    try:
        if pd.isna(value):
            return None
        if hasattr(value, "item"):
            value = value.item()
    except (TypeError, ValueError):
        pass
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value[:72] if isinstance(value, str) else value
    return str(value)[:72]


def _native_flow_json(value):
    import json
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=_native_flow_value)


def _native_flow_emit(facts, frame):
    if facts:
        # Each operation emits one envelope; the renderer applies a separate
        # character budget to the whole block, independent of column stats.
        frame.attrs["__native_flow_evidence__"] = {"version": 1, "facts": facts[:4]}


def _native_flow_prepare_compute(frame, columns):
    """Copy referenced source expressions in the SAME SELECT as their output.

    These private projections survive replacements and SQL window reordering,
    so a witness never assumes input/output positional alignment. Only direct
    column references found by this conservative lexer are considered.
    """
    import re
    try:
        known = {str(c) for c in frame.columns}
        taken = known | set(columns)
        aliases, pairs = {}, []
        for target, expr in list(columns.items())[:6]:
            bare = re.sub(r"'(?:[^']|'')*'", " ", str(expr))
            refs = []
            for match in re.finditer(r'"((?:[^\"]|\"\")+)"|\b([A-Za-z_][A-Za-z0-9_]*)\b', bare):
                quoted, word = match.groups()
                if word and bare[match.end():].lstrip().startswith("("):
                    continue
                name = quoted.replace('""', '"') if quoted else word
                if name in known and name not in refs:
                    refs.append(name)
            for source in refs[:4]:
                if source not in aliases:
                    alias = "__native_flow_source_" + str(len(aliases))
                    while alias in taken:
                        alias += "_"
                    taken.add(alias)
                    aliases[source] = alias
                pairs.append((source, target))
        return aliases, pairs
    except Exception:
        return {}, []


def _native_flow_finish_compute(frame, aliases, pairs):
    try:
        facts = []
        for source, target in pairs:
            raw, derived = frame[aliases[source]], frame[target]
            for label, mask in (
                ("null → " + _native_flow_json(target) + " non-null", raw.isna() & derived.notna()),
                ("non-null → " + _native_flow_json(target) + " null", raw.notna() & derived.isna()),
            ):
                count = int(mask.sum())
                if count:
                    row = frame.loc[mask].iloc[0]
                    witness = {"input": {source: _native_flow_value(row[aliases[source]])},
                               "output": {target: _native_flow_value(row[target])}}
                    facts.append(_native_flow_json(source) + " " + label + ": " + str(count)
                                 + " row(s); witness " + _native_flow_json(witness))
        _native_flow_emit(facts, frame)
    except Exception:
        pass
    # Remove only the private projections we actually created. Original user
    # columns, including columns with the same prefix, are preserved.
    return frame.drop(columns=list(aliases.values()))


def _native_flow_aggregate(source, output, properties):
    import math
    import pandas as pd
    try:
        keys = properties.get("groupBy") or []
        aggs = properties.get("aggregations") or []
        targets = {a.get("col") for a in aggs if a.get("col")}
        facts = [str(len(source)) + " input rows → " + str(len(output))
                 + " aggregate row(s); grouping keys " + _native_flow_json(keys)]
        # One contribution count per target, under the same numeric cleaning
        # contract as compileAggregate. Do not silently assume every row counts.
        for a in aggs[:3]:
            col = a.get("col")
            if not col or col not in source.columns:
                continue
            raw = source[col]
            values = raw
            numeric = a["fn"] in ("sum", "avg", "mean", "median", "stddev")
            if numeric and raw.dtype == object:
                values = pd.to_numeric(raw.astype(str).str.replace(",", "", regex=False).str.strip(), errors="coerce")
            present = int(values.notna().sum())
            lost = int((raw.notna() & values.isna()).sum())
            if present != len(source) or lost:
                facts.append(a["fn"] + "(" + _native_flow_json(col) + "): " + str(present)
                             + "/" + str(len(source)) + " non-null inputs; " + str(lost)
                             + " non-null value(s) became null during numeric parsing")
        candidates = [c for c in source.columns if c not in keys and c not in targets][:24]
        if keys and len(source):
            groups = source.groupby(keys, dropna=False, observed=True, sort=False)
            n_groups = groups.ngroups
            collisions = []
            for col in candidates:
                if source[col].nunique(dropna=False) > 512:
                    continue
                sizes = groups[col].nunique(dropna=False)
                bad = sizes[sizes > 1]
                # Prefer rare violations of an otherwise stable association.
                # This is evidence of a joint relationship, not a declaration
                # that these are entity keys or that the grouping is wrong.
                if 0 < len(bad) <= max(1, math.ceil(n_groups * 0.05)):
                    collision_key = bad.index[0]
                    vals = collision_key if len(keys) > 1 else (collision_key,)
                    mask = pd.Series(True, index=source.index)
                    for key, val in zip(keys, vals):
                        mask &= source[key].isna() if pd.isna(val) else source[key].eq(val).fillna(False)
                    sample = source.loc[mask, col].drop_duplicates().iloc[:3]
                    witness = {"key": {k: _native_flow_value(v) for k, v in zip(keys, vals)},
                               col: [_native_flow_value(v) for v in sample]}
                    collisions.append((len(bad), str(col),
                        "Grouping keys map to multiple " + _native_flow_json(str(col)) + " values in "
                        + str(len(bad)) + "/" + str(n_groups) + " groups; witness " + _native_flow_json(witness)))
            facts.extend(x[2] for x in sorted(collisions, key=lambda x: (x[0], x[1]))[:2])
        elif len(source):
            # Rare low-cardinality partitions of the ACTUAL input population.
            # Their semantic meaning (e.g. whether a flag excludes a row) is
            # left to the agent and task; no benchmark-specific names appear.
            partitions = []
            for col in candidates:
                if source[col].nunique(dropna=False) not in range(2, 5):
                    continue
                counts = source[col].value_counts(dropna=False)
                rare = int(counts.min())
                if rare / len(source) <= 0.2:
                    parts = {str(_native_flow_value(k)): int(v) for k, v in counts.items()}
                    partitions.append((rare, str(col), "Input population by " + _native_flow_json(str(col))
                                       + ": " + _native_flow_json(parts)))
            facts.extend(x[2] for x in sorted(partitions, key=lambda x: (x[0], x[1]))[:2])
        _native_flow_emit(facts, output)
    except Exception:
        pass


def _native_flow_join(left, right, output, properties):
    try:
        raw = properties.get("on") or []
        raw = [raw] if isinstance(raw, str) else raw
        pairs = [(v, v) if isinstance(v, str) else tuple(v) for v in raw]
        if not pairs or properties.get("type") == "cross":
            _native_flow_emit(["Cross join: " + str(len(left)) + " × " + str(len(right))
                               + " input rows → " + str(len(output)) + " output rows"], output)
            return
        lkeys, rkeys = [p[0] for p in pairs], [p[1] for p in pairs]
        # Semi-joins against DISTINCT keys count matched INPUT rows. Output
        # counts are never used to infer unmatched rows under fanout. pandas
        # merge matches null keys, exactly as the actual native join does.
        lk, rk = left[lkeys].copy(), right[rkeys].copy()
        lk.columns = rk.columns = ["k" + str(i) for i in range(len(pairs))]
        def matched(a, b):
            marker = "__native_flow_match__"
            return int((a.merge(b.drop_duplicates(), how="left", indicator=marker)[marker] == "both").sum())
        facts = ["Join keys " + _native_flow_json(pairs) + "; matched input rows: left "
                 + str(matched(lk, rk)) + "/" + str(len(left)) + ", right "
                 + str(matched(rk, lk)) + "/" + str(len(right)) + "; output " + str(len(output)) + " rows",
                 "Rows with repeated join keys: left " + str(int(lk.duplicated(keep=False).sum()))
                 + "/" + str(len(left)) + ", right " + str(int(rk.duplicated(keep=False).sum()))
                 + "/" + str(len(right))]
        disagreements = []
        common = [c for c in left.columns if c in right.columns and c not in lkeys and c not in rkeys][:24]
        for col in common:
            rcol = str(col) + "_right"
            if col not in output.columns or rcol not in output.columns:
                continue
            # Non-null pairs only: nulls from an outer join are not mismatches.
            a, b = output[col], output[rcol]
            mask = a.notna() & b.notna() & a.ne(b).fillna(False)
            count = int(mask.sum())
            if count:
                row = output.loc[mask].iloc[0]
                witness = {"left": _native_flow_value(row[col]), "right": _native_flow_value(row[rcol])}
                # Categorical identifiers often explain an over-broad key;
                # numerical measurements can legitimately differ at every row.
                rank = 0 if a.dtype == object or str(a.dtype).startswith("str") else 1
                disagreements.append((rank, -count, str(col), _native_flow_json(str(col))
                    + " disagrees in " + str(count) + " output row(s) with two non-null values; witness "
                    + _native_flow_json(witness)))
        facts.extend(x[3] for x in sorted(disagreements, key=lambda x: (x[0], x[1], x[2]))[:2])
        _native_flow_emit(facts, output)
    except Exception:
        pass
