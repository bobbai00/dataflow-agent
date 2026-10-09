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

"""One session, several arms (dataflow builds and the Python baseline) on
the same questions and judge. The first table gives accuracy, output and
calls per question (all and state-change questions), cost, shared-function
reuse, in-place changes of earlier state, saved-input notes and how many
saved references differed from the current table. The second splits the
output: reasoning and visible tokens, code characters (all edits or
scripts), the part in rejected edits, docstrings and doc= text, read
actions, and the share of state-change code tokens that repeat 8-token
runs written in earlier questions."""
import argparse
import ast
from collections import Counter
import gzip
import json
from pathlib import Path
import re

STATE = ('Update', 'Rollback', 'Counterfactual')
REF = re.compile(r'\b([A-Za-z_]\w*)@([1-9]\d*)\b')


def answers(run):
    if (run / 'records.json').exists():
        return run
    verification = run / 'replay-verification.json'
    return Path(json.loads(verification.read_text())['source']) if verification.exists() else run


def capture(run, q):
    path = run / f't{q:02d}' / 'observer' / 'capture.json.gz'
    return json.loads(gzip.open(path, 'rt').read()) if path.exists() else None


def table_version(cap, name):
    version = (cap or {}).get('observerTables', {}).get(name, {}).get('version')
    return version.get('id') if isinstance(version, dict) else version


def arm(run, gold, limit=None):
    run = answers(run)
    records = [r for r in json.loads((run / 'records.json').read_text()) if limit is None or r['turn_id'] <= limit]
    c = Counter()
    functions = Counter()
    for r in records:
        q = r['turn_id']
        state = any(l in gold[q - 1].get('state_type', []) for l in STATE)
        judge = run / f't{q:02d}' / 'judge.json'
        score = json.loads(judge.read_text()).get('score') if judge.exists() else None
        for key in ('', 'state_'):
            if key and not state:
                continue
            c[key + 'q'] += 1
            c[key + 'correct'] += score == 1
            c[key + 'output'] += r['stats'].get('output_tokens') or 0
            c[key + 'calls'] += r['stats'].get('llm_calls') or 0
        c['cost'] += r['stats'].get('cost_usd') or 0
        batches = [b for b in r.get('native_actions', []) if isinstance(b, dict)]
        if not batches:
            continue
        before = capture(run, q - 1) if q > 1 else None
        before_ops = {o['operatorID'] for o in (before or {}).get('workflow', {}).get('workflow', {}).get('operators', []) if not o.get('savedResult')}
        before_fns = set()
        for o in (before or {}).get('workflow', {}).get('workflow', {}).get('operators', []):
            view = o.get('nativeOp') or {}
            if (view.get('properties') or {}).get('shared'):
                before_fns |= set(view.get('functions') or {})
        changed = False
        for b in batches:
            for a in b.get('actions', []):
                if not isinstance(a, dict):
                    continue
                if a.get('type') == 'edit':
                    text = a.get('changes', '')
                    for line in text.splitlines():
                        m = re.match(r'^(\w+)\s*=\s*(\w+)', line)
                        if m:
                            if m.group(1) in before_ops:
                                changed = True
                            if m.group(2) in functions:
                                functions[m.group(2)] += 1
                        d = re.match(r'^def (\w+)', line)
                        if d:
                            if d.group(1) in before_fns:
                                changed = True
                                c['redefinitions'] += 1
                            functions.setdefault(d.group(1), 0)
                    for m in REF.finditer('\n'.join(l for l in text.splitlines() if l and not l[0].isspace())):
                        name, n = m.group(1), int(m.group(2))
                        saved, now = table_version(capture(run, n), name), table_version(before, name)
                        if saved and now:
                            c['ref_differs' if saved != now else 'ref_same'] += 1
        c['changed_earlier_state'] += changed
        steps = run / f't{q:02d}' / 'react_steps.json.gz'
        if steps.exists():
            blob = json.dumps(json.loads(gzip.open(steps, 'rt').read())['steps'])
            c['frozen_notes'] += blob.count('is the same table as the current')
    c['functions'] = len(functions)
    c['single_use'] = sum(1 for v in functions.values() if v <= 1)
    return c


def usage(step):
    u = step.get('usage')
    if isinstance(u, str):
        try:
            u = ast.literal_eval(u)
        except (ValueError, SyntaxError):
            u = {}
    return u or {}


TOKEN = re.compile(r"[A-Za-z_]\w*|\d+(?:\.\d+)?|\S")
DOCS = re.compile(r'"""(?:.|\n)*?"""|\bdoc\s*=\s*"(?:[^"\\]|\\.)*"')


def calls(run, q):
    """(kind, text, accepted) for every edit, script and read in the question."""
    steps = run / f't{q:02d}' / 'react_steps.json.gz'
    if steps.exists():
        for s in json.loads(gzip.open(steps, 'rt').read())['steps']:
            results = {r.get('toolCallId'): r for r in (s.get('toolResults') or [])}
            for call in s.get('toolCalls') or []:
                args = call.get('input')
                if not isinstance(args, dict):
                    continue
                out = (results.get(call.get('toolCallId')) or {}).get('output')
                status = {a.get('index'): a.get('status') for a in (out.get('actions') or [])} if isinstance(out, dict) else {}
                for i, a in enumerate(args.get('actions') or [], start=1):
                    if not isinstance(a, dict):
                        continue
                    if a.get('type') == 'edit':
                        yield 'code', a.get('changes') or '', status.get(i) in ('ok', None)
                    elif a.get('type') == 'read':
                        yield 'read', json.dumps(a), True
        return
    for path in sorted((run / f't{q:02d}').glob('[0-9][0-9][0-9]-response.json')):
        for choice in json.loads(path.read_text()).get('choices') or []:
            for call in (choice.get('message') or {}).get('tool_calls') or []:
                try:
                    code = json.loads(call['function']['arguments']).get('code')
                except (ValueError, KeyError, AttributeError):
                    continue
                if code:
                    yield 'code', code, True


def tokens_used(run, q):
    """(output, reasoning) tokens of one question, from the step or response usage."""
    steps = run / f't{q:02d}' / 'react_steps.json.gz'
    out = reasoning = 0
    if steps.exists():
        for s in json.loads(gzip.open(steps, 'rt').read())['steps']:
            u = usage(s)
            out += u.get('outputTokens') or 0
            reasoning += u.get('reasoningTokens') or 0
        return out, reasoning
    for path in sorted((run / f't{q:02d}').glob('[0-9][0-9][0-9]-response.json')):
        u = json.loads(path.read_text()).get('usage') or {}
        out += u.get('completion_tokens') or 0
        reasoning += (u.get('completion_tokens_details') or {}).get('reasoning_tokens') or 0
    return out, reasoning


def anatomy(run, gold, limit=None):
    run = answers(run)
    c = Counter()
    seen = set()
    for r in json.loads((run / 'records.json').read_text()):
        q = r['turn_id']
        if limit is not None and q > limit:
            continue
        state = any(l in gold[q - 1].get('state_type', []) for l in STATE)
        c['q'] += 1
        out, reasoning = tokens_used(run, q)
        c['output'] += out
        c['reasoning'] += reasoning
        written = set()
        for kind, text, accepted in calls(run, q):
            if kind == 'read':
                c['read'] += len(text)
                continue
            c['code'] += len(text)
            c['docs'] += sum(len(m.group(0)) for m in DOCS.finditer(text))
            if not accepted:
                c['rejected'] += len(text)
                continue
            toks = TOKEN.findall(text)
            covered = set()
            for i in range(len(toks) - 7):
                run8 = tuple(toks[i:i + 8])
                if run8 in seen:
                    covered.update(range(i, i + 8))
                written.add(run8)
            if state:
                c['state_tokens'] += len(toks)
                c['state_repeated'] += len(covered)
        seen |= written
    return c


def anatomy_row(name, c):
    q = c['q'] or 1
    share = 100 * c['state_repeated'] / c['state_tokens'] if c['state_tokens'] else 0
    return (f"| {name} | {c['output'] / q:,.0f} | {c['reasoning'] / q:,.0f} | {(c['output'] - c['reasoning']) / q:,.0f} | "
            f"{c['code'] / q:,.0f} | {c['rejected'] / q:,.0f} | {c['docs'] / q:,.0f} | {c['read'] / q:,.0f} | {share:.0f}% |")


def row(name, c):
    q, sq = c['q'], c['state_q'] or 1
    return (f"| {name} | {c['correct']}/{q} | {c['output'] / q:,.0f} | {c['state_output'] / sq:,.0f} | {c['calls'] / q:.2f} | "
            f"${c['cost']:.2f} | {c['functions']} ({c['single_use']} single-use) | {c['redefinitions']} | "
            f"{c['changed_earlier_state']} | {c['ref_differs']} of {c['ref_differs'] + c['ref_same']} | {c['frozen_notes']} |")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gold', type=Path, required=True)
    parser.add_argument('--arm', nargs=2, action='append', metavar=('NAME', 'RUN'), required=True)
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    gold = json.loads(args.gold.read_text())['turns']
    print('| Arm | Correct | Output/q | Output/state-change q | Calls/q | Cost | Shared functions | Redefinitions | Questions changing earlier state | Saved inputs differing from current | Saved-input notes |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for name, run in args.arm:
        print(row(name, arm(Path(run), gold, args.limit)))
    print()
    print('| Arm | Output tokens/q | Reasoning/q | Visible/q | Code chars/q | In rejected edits | Docstrings and doc= | Read actions | State-change code repeating earlier 8-token runs |')
    print('|---|---|---|---|---|---|---|---|---|')
    for name, run in args.arm:
        print(anatomy_row(name, anatomy(Path(run), gold, args.limit)))
