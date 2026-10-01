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
"""Independently check saved simple CSV/Excel scan profiles with pandas.

Only counts, numeric ranges and published value frequencies are compared.
Partial profiles are compared with the recorded prefix length, never the full
source. Use on scans with known, simple parse settings and preserved row order.
"""
import argparse
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]


def verify(directory, sut, cases):
    sources, failures = [], []
    for case in cases:
        task, operator = case.split(":", 1)
        snapshot = json.loads((directory / "system_scratch" / sut / task / "snapshot.json").read_text())
        spec = next(op["nativeOp"] for op in snapshot["workflow"]["operators"] if op["operatorID"] == operator)
        props = spec["properties"]
        assert spec["type"] == "Scan" and not props.get("preview"), "Requires a parsed Scan"
        assert set(props) <= {"files", "sheet", "allText", "skipLines"}, "Unsupported parse setting"
        source = ROOT / props["files"]
        assert source.is_file(), "Requires one source file"
        profile = snapshot["results"][operator]["tableProfile"]
        options = {"keep_default_na": False, "na_values": [""], "skiprows": props.get("skipLines", 0)}
        if props.get("allText"):
            options["dtype"] = str
        if source.suffix == ".xlsx":
            frame = pd.read_excel(source, sheet_name=props.get("sheet", 0), **options)
        else:
            assert source.suffix == ".csv", "Only simple CSV and Excel scans are supported"
            frame = pd.read_csv(source, **options)
        assert len(frame) == profile["rowCount"], "Source row count differs"
        checks = 0
        for name, column in profile["columns"].items():
            values = frame[name].iloc[:column["rowsProcessed"]]
            nonnull = values.dropna()
            numeric = column["type"] in ["int64", "float64"]
            if numeric:
                nonnull = pd.to_numeric(nonnull)
            counts = {"nullCount": int(values.isna().sum()), "nonnullCount": len(nonnull)}
            if column["distinctCount"] is not None:
                counts["distinctCount"] = int(nonnull.nunique())
            comparisons = [(metric, actual, column[metric]) for metric, actual in counts.items()]
            for metric, function in [("min", min), ("max", max)]:
                if numeric and column[metric] is not None:
                    comparisons.append((metric, float(function(nonnull)), float(column[metric]["value"])))
            for frequency in (column["frequencies"] or {}).get("values", []):
                value = frequency["value"]["value"]
                value = float(value) if numeric else value
                comparisons.append(("frequency", int((nonnull == value).sum()), frequency["count"]))
            for metric, actual, expected in comparisons:
                checks += 1
                if actual != expected:
                    failures.append({"task": task, "operator": operator, "column": name, "metric": metric,
                                     "actual": actual, "recorded": expected})
        sources.append({"task": task, "operator": operator, "source_rows": len(frame),
                        "profile_rows": profile["coverage"]["rowsProcessed"],
                        "columns": len(profile["columns"]), "checks": checks})
    return {"sources": sources, "failures": failures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--sut", required=True)
    parser.add_argument("--case", action="append", required=True, help="TASK:OPERATOR")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Refusing to overwrite an audit")
    result = verify(args.directory, args.sut, args.case)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    if result["failures"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
