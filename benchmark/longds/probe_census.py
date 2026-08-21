#!/usr/bin/env python3
"""Is the flexible probe (queryResult) worth its tokens?

For each arm: how many probes, what they ask for, what they cost, and whether
the answer was used.

COST MODEL. A probe's output lands in the step log and, under cache-aligned
packaging, every later step of that turn re-sends it. So a probe emitted at
step k of an S-step turn is billed (S-k+1) times. Raw chars understate the
cost; the re-send weighting is the real number.

USEFULNESS. Three measurable failure modes plus one success proxy:
  * ERRORED      — the call returned [ERROR] (budget, syntax, denied).
  * DUPLICATE    — same (operatorId, expr) asked again in the same turn.
  * PARTIAL      — the target table was held only in part, so any aggregate
                   describes a prefix (the wide-table trap).
  * CONSUMED     — a distinctive token (a long number or a quoted string) that
                   appears in the probe's OUTPUT later appears in this turn's
                   operator code or final answer. Evidence the read was used.
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

TOKEN = re.compile(r'"([^"]{3,40})"|(-?\d+\.\d{2,}|-?\d{4,})')
PARTIAL = re.compile(r"\[PARTIAL\]|rows held")


def classify(expr: str) -> str:
    e = expr
    if re.search(r"value_counts|\.unique\(", e):
        return "value inventory"
    if re.search(r"isna\(\)|notna\(\)|\.isnull", e):
        return "null/coverage check"
    if re.search(r"\.shape|nunique|len\(", e):
        return "size / cardinality"
    if re.search(r"nlargest|nsmallest|sort_values", e):
        return "ranked read (answer)"
    if re.search(r"groupby|\.agg\(|pivot", e):
        return "aggregate (answer)"
    if re.search(r"\.columns", e):
        return "schema navigation"
    if re.search(r"df\[df|\.loc\[|==|\.str\.contains", e):
        return "row fetch / filter"
    if re.search(r"\.iloc\[|\.head\(|\.tail\(|^df$", e.strip()):
        return "browse rows"
    return "other"


def census(sut):
    kinds = Counter()
    kind_chars = Counter()
    n = errored = dup = partial = consumed = 0
    raw_chars = weighted_chars = 0
    ctx_chars = 0
    runs = 0
    for run in sorted((SCRATCH / sut).glob("*__task*")):
        runs += 1
        for tdir in sorted(run.glob("t[0-9]*")):
            p = tdir / "react_steps.json"
            if not p.exists():
                continue
            steps = json.loads(p.read_text())["steps"]
            agent_steps = [s for s in steps if s.get("role") == "agent"]
            S = len(agent_steps)
            # the turn's own context size, for share-of-context
            for s in agent_steps:
                for m in s.get("inputMessages") or []:
                    c = m.get("content")
                    if isinstance(c, str):
                        ctx_chars += len(c)
            seen = set()
            outputs = []
            for k, s in enumerate(agent_steps, start=1):
                res = {r.get("toolCallId"): r for r in (s.get("toolResults") or [])}
                for c in s.get("toolCalls") or []:
                    if c.get("toolName") != "queryResult":
                        continue
                    n += 1
                    inp = c.get("input") or {}
                    expr = str(inp.get("expr") or "")
                    key = (str(inp.get("operatorId")), expr)
                    r = res.get(c.get("toolCallId"))
                    out = str((r or {}).get("output") or "")
                    size = len(expr) + len(out)
                    raw_chars += size
                    weighted_chars += size * max(1, S - k + 1)
                    kind = classify(expr)
                    kinds[kind] += 1
                    kind_chars[kind] += size
                    if (r or {}).get("isError"):
                        errored += 1
                    if key in seen:
                        dup += 1
                    seen.add(key)
                    if PARTIAL.search(out) and re.search(
                        r"value_counts|\.mean\(|\.sum\(|nlargest|groupby|nunique|\.count\(", expr
                    ):
                        partial += 1
                    outputs.append((k, out))
            # consumption: probe-output tokens reappearing later in the turn
            later_text = []
            for k, s in enumerate(agent_steps, start=1):
                for c in s.get("toolCalls") or []:
                    if c.get("toolName") == "createOrModifyOperator":
                        later_text.append((k, str((c.get("input") or {}).get("code") or "")))
                if s.get("isEnd") and s.get("content"):
                    later_text.append((k, str(s["content"])))
            for pk, out in outputs:
                toks = {m.group(1) or m.group(2) for m in TOKEN.finditer(out)}
                toks = {t for t in toks if t and len(t) >= 4}
                if not toks:
                    continue
                if any(k > pk and any(t in txt for t in toks) for k, txt in later_text):
                    consumed += 1
    if n == 0:
        print(f"{sut}: no probes")
        return
    print(f"== {sut}  ({runs} task-runs)")
    print(f"   probes: {n} total, {n/runs:.0f} per task-run")
    print(f"   tokens: raw {raw_chars/1000:.0f}k chars; RE-SENT-weighted {weighted_chars/1000:.0f}k chars "
          f"= {100*weighted_chars/max(1,ctx_chars):.1f}% of all context billed")
    print(f"   errored {errored} ({100*errored/n:.0f}%) | duplicate {dup} ({100*dup/n:.0f}%) | "
          f"aggregate-over-PARTIAL {partial} ({100*partial/n:.0f}%) | output reused later {consumed} ({100*consumed/n:.0f}%)")
    print("   what they asked for:")
    for kind, cnt in kinds.most_common():
        print(f"     {cnt:>5} ({100*cnt/n:>2.0f}%)  {kind:<22} {kind_chars[kind]/1000:>6.0f}k chars")


for sut in sys.argv[1:]:
    census(sut)
