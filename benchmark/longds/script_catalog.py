# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Executed-script catalog and passive namespace audit; no historical heap API.

When a script's code runs (its body, and the functions and lambdas it defines),
the globals that code loads are its reads; each code object is scanned once,
and nothing is traced inside it. Dependencies are conservative at script-block
granularity, not column lineage.
The evaluator may export values; exports are never exposed to the solver.
"""
import contextlib
import dis
import hashlib
import io
import json
import math
import numbers
from pathlib import Path
import pickle
import sys
import traceback
import types
import pandas as pd


def table_summary(value, statistics=False):
    """Compact metadata of a computed table, never its sample records."""
    if not isinstance(value, (pd.DataFrame, pd.Series)):
        return None
    frame = value.to_frame() if isinstance(value, pd.Series) else value
    rows, columns = frame.shape
    shape = f'{rows} {"row" if rows == 1 else "rows"} × {columns} {"column" if columns == 1 else "columns"}'
    if not statistics:
        names = [f'{str(name)[:48]}:{dtype}' for name, dtype in zip(frame.columns[:16], frame.dtypes.iloc[:16])]
        return shape + '; ' + ', '.join(names) + (f'; +{columns-16} columns' if columns > 16 else '')
    parts = [shape, 'stats full']
    for index in range(min(columns, 3)):
        series = frame.iloc[:, index]
        name = ' '.join(str(frame.columns[index]).split())
        name = name[:48] + ('…' if len(name) > 48 else '')
        details = [f'null={int(series.isna().sum())}/{rows}']
        try:
            distinct = series.nunique(dropna=True)
        except (TypeError, ValueError):
            distinct = 'unknown'
        details.append(f'distinct={distinct}')
        if (pd.api.types.is_numeric_dtype(series.dtype) and not pd.api.types.is_bool_dtype(series.dtype)
                and not pd.api.types.is_complex_dtype(series.dtype)):
            def number(v):
                if isinstance(v, numbers.Integral):
                    return str(int(v))
                return format(float(v), '.4g') if pd.notna(v) and math.isfinite(float(v)) else None
            low, high = number(series.min()), number(series.max())
            if low is not None and high is not None:
                details.append(f'range={low}..{high}')
        parts.append(f'{name}:{series.dtype}({", ".join(details)})')
    if columns > 3:
        parts.append(f'+{columns-3} columns')
    return '; '.join(parts)


def fingerprint(value):
    if isinstance(value, (pd.DataFrame, pd.Series)):
        try:
            body = str(value.shape) + repr(getattr(value, 'columns', None)) + repr(value.dtypes)
            return hashlib.sha256(body.encode() + pd.util.hash_pandas_object(value, index=True).values.tobytes()).hexdigest()
        except (TypeError, ValueError):
            # Unhashable cells such as lists. repr(to_dict()) took ~10 s per
            # 650k-row table; the pickled bytes take ~1 s.
            return hashlib.sha256(pickle.dumps(value, protocol=5)).hexdigest()
    if isinstance(value, types.FunctionType):
        return hashlib.sha256(value.__code__.co_code + repr(value.__code__.co_consts).encode()).hexdigest()
    if isinstance(value, (bool, int, float, str, list, tuple, dict, set, frozenset)):
        return hashlib.sha256(repr(value).encode()).hexdigest()
    return None


# The value types `fingerprint` versions; everything else in the namespace is untracked.
TRACKED = (pd.DataFrame, pd.Series, types.FunctionType, bool, int, float, str, list, tuple, dict, set, frozenset)


class ScriptCatalog:
    def __init__(self, namespace, output_limit=5000, statistics=False):
        self.namespace = namespace
        self.output_limit = output_limit
        self.statistics = statistics
        self.scripts = []
        self.bindings = {}
        self.tasks = []
        # name -> (id, fingerprint) after the last script. Only scripts change
        # the namespace, so an object still bound to its name keeps its version.
        self.versions = {}

    def values(self):
        return {name: value for name, value in self.namespace.items()
                if not name.startswith('_') and name not in {'In', 'Out', 'exit', 'quit', 'get_ipython'}
                and isinstance(value, TRACKED)}

    def execute(self, task_id, source):
        values = self.values()
        before = {name: (self.versions[name][1] if self.versions.get(name, (None,))[0] == id(value)
                         else fingerprint(value)) for name, value in values.items()}
        object_names = {}
        for name, value in values.items():
            if isinstance(value, (pd.DataFrame, pd.Series)):
                object_names.setdefault(id(value), set()).add(name)
        reads = set()
        scanned = {}
        previous_trace = sys.gettrace()

        def trace(frame, event, arg):
            code = frame.f_code
            if event != 'call' or not code.co_filename.startswith('pilot-script-'):
                return None
            names = scanned.get(code)
            if names is None:
                names = scanned[code] = {op.argval for op in dis.get_instructions(code)
                                         if op.opname in {'LOAD_NAME', 'LOAD_GLOBAL'}}
            for name in names:
                if name in before:
                    reads.add(name)
                    reads.update(object_names.get(id(frame.f_globals.get(name)), set()))
            return None

        output = io.StringIO()
        success = True
        try:
            sys.settrace(trace)
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                try:
                    exec(compile(source, f'pilot-script-t{task_id}-{len(self.scripts)+1}', 'exec'), self.namespace)
                except Exception:
                    success = False
                    traceback.print_exc()
        finally:
            sys.settrace(previous_trace)
        values = self.values()
        after = {name: fingerprint(value) for name, value in values.items()}
        self.versions = {name: (id(values[name]), version) for name, version in after.items()}
        writes = sorted(name for name, version in after.items() if before.get(name) != version)
        references = [dict(name=name, **self.bindings[name]) for name in sorted(reads) if name in self.bindings]
        parents = [{'name': r['name'], 'version': r['version'], 'task_id': r['changed_task']} for r in references]
        for name in writes:
            previous = self.bindings.get(name)
            self.bindings[name] = {'version': after[name], 'created_task': previous['created_task'] if previous else task_id,
                                   'changed_task': task_id, 'kind': type(values[name]).__name__, 'parents': parents}
            summary = table_summary(values[name], self.statistics)
            if summary is not None:
                self.bindings[name]['summary'] = summary
        deleted = sorted(set(before) - set(after))
        for name in deleted:
            self.bindings.pop(name, None)
        full = output.getvalue()
        observation = full if len(full) <= self.output_limit else full[:self.output_limit] + '\n[output clipped; inspect this script for another portion]'
        receipt = {'script_id': f't{task_id}_s{len(self.scripts)+1}', 'task_id': task_id, 'source': source,
                   'success': success, 'output': full, 'observation': observation, 'reads': sorted(reads),
                   'writes': writes, 'deleted': deleted, 'references': references,
                   'written_bindings': {name: dict(self.bindings[name]) for name in writes},
                   'lineage_granularity': 'runtime reads, script-block outputs'}
        self.scripts.append(receipt)
        return receipt

    def inspect_task(self, task_id, include_outputs=False, offset=0, limit=12000):
        scripts = [s for s in self.scripts if s['task_id'] == task_id]
        if not scripts:
            raise KeyError(f'No recorded task {task_id}')
        public = [{'script_id': s['script_id'], 'success': s['success'], 'source': s['source'], 'writes': s['writes'],
                   **({'output': s['output']} if include_outputs else {})} for s in scripts]
        text = json.dumps(public, ensure_ascii=False, indent=2)
        if offset < 0 or limit < 1:
            raise ValueError('Invalid text selection')
        portion = text[offset:offset+limit]
        return portion + (f'\n[clipped; total {len(text)} chars; request offset {offset+limit}]' if offset+limit < len(text) else '')

    def export(self, directory):
        """Private observer export; the solver never receives these paths."""
        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True)
        items = {}
        for name, value in self.values().items():
            record = dict(self.bindings.get(name, {}))
            if isinstance(value, (pd.DataFrame, pd.Series)):
                frame = value.to_frame() if isinstance(value, pd.Series) else value
                path = root / (hashlib.sha256(name.encode()).hexdigest() + '.pkl')
                frame.to_pickle(path)
                record.update(rows=len(frame), columns=list(map(str, frame.columns)), file=str(path))
            elif isinstance(value, (bool, int, float, str, list, tuple, dict, set, frozenset)):
                record['value_repr'] = repr(value)[:4000]
            items[name] = record
        (root / 'bindings.json').write_text(json.dumps(items, indent=2, default=str))
        (root / 'scripts.json').write_text(json.dumps(self.scripts, indent=2, default=str))
        return items
