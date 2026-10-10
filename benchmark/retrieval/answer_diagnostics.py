# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Conservative answer diagnostics; matches establish support, not correctness."""
from decimal import Decimal, DecimalException, InvalidOperation, ROUND_HALF_EVEN, ROUND_HALF_UP, localcontext
import json
import re
try:
    from .metrics import retrieval_results
except ImportError:
    from metrics import retrieval_results

NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")

def number(text):
    text = str(text).strip()
    if not NUMBER.fullmatch(text):
        return None
    try:
        value = Decimal(text)
        return value if value.is_finite() else None
    except InvalidOperation:
        return None

def rounded_equal(candidate, target):
    if candidate == target:
        return True
    exponent = target.as_tuple().exponent
    # Integer/scientific notation must not turn a different integer into a
    # match by rounding to tens or larger powers. Only fractional precision
    # permits rounding; extreme exponents remain inconclusive with bounded work.
    if exponent >= 0 or abs(exponent) > 4096 or abs(candidate.adjusted()) > 4096:
        return False
    precision = max(50, len(candidate.as_tuple().digits), candidate.adjusted() - exponent + 2)
    if precision > 4096:
        return False
    try:
        with localcontext() as ctx:
            ctx.prec = precision
            quantum = Decimal((0, (1,), exponent))
            return any(candidate.quantize(quantum, rounding=mode) == target for mode in (ROUND_HALF_EVEN, ROUND_HALF_UP))
    except DecimalException:
        return False


def record_number(cell):
    value = number(cell)
    if value is not None:
        return value
    # The renderer JSON-quotes string cells. Accept a whole numeric string,
    # never a numeric substring of labels such as "Age 60".
    try:
        decoded = json.loads(cell)
        return number(decoded) if isinstance(decoded, str) else None
    except (TypeError, ValueError):
        return None


def visible_numbers(text):
    # Restrict to record cells. Shape counts, schema labels and flow facts are
    # not answer cells; matching one of their numbers would be a false positive.
    values = set()
    header_seen = False
    for line in text.splitlines():
        if line.startswith(("statistics:", "- flow", "- note:")):
            break
        if line.startswith("|") and line.endswith("|"):
            cells = line[1:-1].split("|")
        elif "\t" in line:
            cells = line.split("\t")
        else:
            continue
        if not header_seen:
            header_seen = True
            continue
        values.update(value for cell in cells if (value := record_number(cell)) is not None)
    return values


def diagnose_answer(prompt, response, steps, snapshot):
    """Check the explicit KramaBench final-line contract and numeric cell support.

    Only successful, nonsuperseded reads of the same current result version
    qualify. Absence from bounded records is inconclusive, never an incorrect
    answer verdict. A matching value is not proof that the formula/population
    was correct. This does not alter official scores or rewrite responses.
    """
    final = response.strip().splitlines()[-1] if response.strip() else ""
    bold = re.fullmatch(r"\*\*Final Answer: (.+)\*\*", final)
    labelled = re.fullmatch(r"(?:\*\*)?Final Answer:\s*(.+?)(?:\*\*)?", final)
    value = bold.group(1) if bold else labelled.group(1) if labelled else final
    target = number(value)
    format_required = "**Final Answer:" in prompt
    observed = {}
    for step in steps:
        for result in step.get("toolResults", []):
            for item in (result.get("output") or {}).get("actions", []) if isinstance(result.get("output"), dict) else []:
                for read in retrieval_results(item):
                    if read.get("status") == "ok" and not read.get("superseded_in_call") and read.get("result_version"):
                        observed.setdefault((read.get("operator_id"), read["result_version"]), set()).update(visible_numbers(read.get("text", "")))
    matches = []
    if target is not None:
        for operator, info in snapshot.get("results", {}).items():
            version = (info.get("resultVersion") or {}).get("id")
            visible = observed.get((operator, version))
            if visible is None or info.get("error") or info.get("state") not in {"Completed", "CompletedFromCache"}:
                continue
            for row_index, row in enumerate(info.get("sampleRecords", info.get("result")) or []):
                for column, cell in row.items():
                    if isinstance(cell, bool) or cell is None:
                        continue
                    candidate = number(cell)
                    if candidate is None:
                        continue
                    # Require the cell itself to have been visible in the read,
                    # rather than merely present in a retained but hidden sample.
                    if not any(shown.as_tuple().exponent <= target.as_tuple().exponent and rounded_equal(candidate, shown) for shown in visible):
                        continue
                    if rounded_equal(candidate, target):
                        matches.append({"operator_id": operator, "result_version": version, "row": row_index, "column": column})
    return {"format_contract": "bold_final_answer_last_line" if format_required else None,
            "format_compliant": bool(bold) if format_required else None,
            "numeric_support": {"status": "not_numeric_scalar" if target is None else "observed_result_match" if matches else "not_found_in_observed_results",
                "matches": matches,
                "limitation": "Cell presence is support, not proof of the requested computation; absence from bounded records is inconclusive."}}
