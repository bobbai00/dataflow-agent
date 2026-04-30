#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with this
# work for additional information regarding copyright ownership. Licensed
# under the Apache License, Version 2.0 (the "License").

"""
Python-side runtime test for UDFMultiTableOperator.

Exercises the buffer-then-dispatch flow that the Scala DataProcessingOpDesc
generates. For each of the 5 test workflows that has DataProcessing
operators, we:

  1. Construct a UDFMultiTableOperator subclass with the same INPUT_PORTS
     declaration the Scala wrapper would emit.
  2. Feed synthetic pandas DataFrames in via `process_table(df, port)` for
     each declared port.
  3. Confirm that no output is yielded until ALL ports have been delivered.
  4. Once all ports complete, confirm `process_tables(self)` runs once with
     each input bound to the matching `self.<port_name>` attribute.

This is the actual contract that Slice C's Scala wrapper relies on; if it
breaks, every workflow that uses DataProcessing breaks.

Datasets are read from `bin/single-node/examples/datasets/` to keep this
test consistent with what the workflow JSONs declare.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Iterator, List, Optional

# Ensure the amber python source tree is importable.
REPO_ROOT = Path(__file__).resolve().parent.parent
AMBER_PY = REPO_ROOT / "amber" / "src" / "main" / "python"
sys.path.insert(0, str(AMBER_PY))

import pandas as pd
import pyarrow as pa
from pytexera import UDFMultiTableOperator, Table, TableLike


def _load_iris() -> pd.DataFrame:
    csv = REPO_ROOT / "bin/single-node/examples/datasets/iris-species/Iris.csv"
    return pd.read_csv(csv)


def _load_movies(n: int = 200) -> pd.DataFrame:
    csv = REPO_ROOT / "bin/single-node/examples/datasets/popular-movies-of-imdb/TMDb_updated.csv"
    return pd.read_csv(csv, nrows=n)[["id", "title", "vote_average"]]


def _df_to_table(df: pd.DataFrame) -> Table:
    """Wrap a pandas DataFrame in a Texera Table for runtime injection."""
    return Table(df)


def _drive(op: UDFMultiTableOperator, port_tables: List[pd.DataFrame]) -> List[pd.DataFrame]:
    """
    Push each port's table through `process_table` in declaration order.
    Mirrors the engine's buffer-then-dispatch contract: only the final port
    triggers `process_tables`. Returns the yielded outputs as DataFrames.
    """
    outputs: List[pd.DataFrame] = []
    for port_idx, df in enumerate(port_tables):
        emitted_so_far = list(op.process_table(_df_to_table(df), port_idx))
        # All ports except the last must yield nothing.
        if port_idx < len(port_tables) - 1:
            assert emitted_so_far == [], (
                f"port {port_idx}/{len(port_tables) - 1} emitted "
                f"{len(emitted_so_far)} items — expected 0 (still buffering)"
            )
        else:
            outputs.extend(emitted_so_far)
    return [_to_df(out) for out in outputs]


def _to_df(out) -> pd.DataFrame:
    """Coerce whatever process_tables yielded into a DataFrame for assertions."""
    if isinstance(out, pd.DataFrame):
        return out
    if isinstance(out, Table):
        return out.to_pandas()
    if isinstance(out, pa.Table):
        return out.to_pandas()
    raise TypeError(f"unexpected yield type: {type(out)}")


# ---------------------------------------------------------------------------
# Per-test cases — mirror the workflow JSON's process(...) signatures
# ---------------------------------------------------------------------------


class T01_FilterSetosaOp(UDFMultiTableOperator):
    """Mirrors tests/01-single-chain: def process(iris_data)."""
    INPUT_PORTS = ["iris_data"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        df = pd.DataFrame(self.iris_data)
        yield df[df["Species"] == "Iris-setosa"][["Id", "SepalLengthCm", "PetalLengthCm"]]


class T02_JoinedIrisOp(UDFMultiTableOperator):
    """Mirrors tests/02-two-input-join: def process(iris_features, iris_labels)."""
    INPUT_PORTS = ["iris_features", "iris_labels"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        f = pd.DataFrame(self.iris_features)
        l = pd.DataFrame(self.iris_labels)
        yield f.merge(l, on="Id")


class T03_MergedIrisOp(UDFMultiTableOperator):
    """Mirrors tests/03-three-input-merge: def process(iris_ids, iris_sepal, iris_petal)."""
    INPUT_PORTS = ["iris_ids", "iris_sepal", "iris_petal"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        ids = pd.DataFrame(self.iris_ids)
        s = pd.DataFrame(self.iris_sepal)
        p = pd.DataFrame(self.iris_petal)
        yield ids.merge(s, on="Id").merge(p, on="Id")


class T04a_IrisSummaryOp(UDFMultiTableOperator):
    INPUT_PORTS = ["iris_raw"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        df = pd.DataFrame(self.iris_raw)
        yield df.groupby("Species").agg(
            avg_sepal=("SepalLengthCm", "mean"),
            count=("Id", "count"),
        ).reset_index()


class T04b_MoviesTopOp(UDFMultiTableOperator):
    INPUT_PORTS = ["movies_raw"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        df = pd.DataFrame(self.movies_raw)
        yield df.nlargest(10, "vote_average")


class T05_SepalBranchOp(UDFMultiTableOperator):
    INPUT_PORTS = ["iris_source"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        df = pd.DataFrame(self.iris_source)
        out = df[["Id", "SepalLengthCm", "SepalWidthCm"]].copy()
        out["sepal_area"] = out["SepalLengthCm"] * out["SepalWidthCm"]
        yield out


class T05_PetalBranchOp(UDFMultiTableOperator):
    INPUT_PORTS = ["iris_source"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        df = pd.DataFrame(self.iris_source)
        out = df[["Id", "PetalLengthCm", "PetalWidthCm"]].copy()
        out["petal_area"] = out["PetalLengthCm"] * out["PetalWidthCm"]
        yield out


class T05_JoinedAreasOp(UDFMultiTableOperator):
    INPUT_PORTS = ["sepal_branch", "petal_branch"]

    def process_tables(self) -> Iterator[Optional[TableLike]]:
        s = pd.DataFrame(self.sepal_branch)
        p = pd.DataFrame(self.petal_branch)
        yield s[["Id", "sepal_area"]].merge(p[["Id", "petal_area"]], on="Id")


# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------


def _record(results: list, name: str, ok: bool, detail: dict) -> None:
    results.append({"name": name, "passed": ok, **detail})
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] {name}: {detail}")


def run() -> int:
    iris = _load_iris()
    movies = _load_movies()

    results: list = []
    failures = 0

    # --- Test 01: single chain ---
    print("\n[01-single-chain] DataProcessing op: filter_setosa(iris_data)")
    op = T01_FilterSetosaOp()
    out = _drive(op, [iris])
    df = out[0]
    ok = (
        len(out) == 1
        and len(df) == 50
        and list(df.columns) == ["Id", "SepalLengthCm", "PetalLengthCm"]
    )
    _record(
        results, "01-single-chain", ok,
        {"rows": len(df), "cols": list(df.columns)}
    )
    if not ok: failures += 1

    # --- Test 02: two-input join ---
    print("\n[02-two-input-join] DataProcessing op: joined_iris(features, labels)")
    op = T02_JoinedIrisOp()
    features = iris[["Id", "SepalLengthCm", "SepalWidthCm"]]
    labels = iris[["Id", "Species"]]
    out = _drive(op, [features, labels])
    df = out[0]
    ok = (
        len(out) == 1
        and len(df) == 150
        and set(df.columns) == {"Id", "SepalLengthCm", "SepalWidthCm", "Species"}
    )
    _record(
        results, "02-two-input-join", ok,
        {"rows": len(df), "cols": sorted(df.columns)}
    )
    if not ok: failures += 1

    # --- Test 03: three-input merge ---
    print("\n[03-three-input-merge] DataProcessing op: merged_iris(ids, sepal, petal)")
    op = T03_MergedIrisOp()
    ids = iris[["Id"]]
    sepal = iris[["Id", "SepalLengthCm", "SepalWidthCm"]]
    petal = iris[["Id", "PetalLengthCm", "PetalWidthCm"]]
    out = _drive(op, [ids, sepal, petal])
    df = out[0]
    ok = (
        len(out) == 1
        and len(df) == 150
        and set(df.columns) == {
            "Id", "SepalLengthCm", "SepalWidthCm", "PetalLengthCm", "PetalWidthCm"
        }
    )
    _record(
        results, "03-three-input-merge", ok,
        {"rows": len(df), "cols": sorted(df.columns)}
    )
    if not ok: failures += 1

    # --- Test 04: multiple parallel chains (two independent DataProcessing ops) ---
    print("\n[04-multiple-parallel-chains] iris_summary AND movies_top")
    op_a = T04a_IrisSummaryOp()
    out_a = _drive(op_a, [iris])
    df_a = out_a[0]
    ok_a = len(df_a) == 3 and set(df_a.columns) == {"Species", "avg_sepal", "count"}

    op_b = T04b_MoviesTopOp()
    out_b = _drive(op_b, [movies])
    df_b = out_b[0]
    ok_b = len(df_b) == 10 and set(df_b.columns) == {"id", "title", "vote_average"}

    ok = ok_a and ok_b
    _record(
        results, "04-multiple-parallel-chains", ok,
        {
            "iris_summary_rows": len(df_a), "iris_summary_cols": sorted(df_a.columns),
            "movies_top_rows": len(df_b), "movies_top_cols": sorted(df_b.columns),
        }
    )
    if not ok: failures += 1

    # --- Test 05: diamond ---
    print("\n[05-diamond-topology] sepal_branch + petal_branch -> joined_areas")
    sepal_op = T05_SepalBranchOp()
    sepal_out = _drive(sepal_op, [iris])[0]

    petal_op = T05_PetalBranchOp()
    petal_out = _drive(petal_op, [iris])[0]

    joined_op = T05_JoinedAreasOp()
    joined_out = _drive(joined_op, [sepal_out, petal_out])[0]

    ok = (
        len(joined_out) == 150
        and set(joined_out.columns) == {"Id", "sepal_area", "petal_area"}
    )
    _record(
        results, "05-diamond-topology", ok,
        {
            "sepal_branch_rows": len(sepal_out),
            "petal_branch_rows": len(petal_out),
            "joined_rows": len(joined_out),
            "joined_cols": sorted(joined_out.columns),
        }
    )
    if not ok: failures += 1

    # ---------------------------------------------------------------------
    # Persist a result.json sidecar per test (extends the Scala spec's file)
    # and a single python-runtime-results.json under tests/.
    # ---------------------------------------------------------------------
    folder_map = {
        "01-single-chain": "01-single-chain",
        "02-two-input-join": "02-two-input-join",
        "03-three-input-merge": "03-three-input-merge",
        "04-multiple-parallel-chains": "04-multiple-parallel-chains",
        "05-diamond-topology": "05-diamond-topology",
    }
    for r in results:
        result_path = REPO_ROOT / "tests" / folder_map[r["name"]] / "python-runtime-result.json"
        result_path.write_text(json.dumps(r, indent=2, default=str))

    summary_path = REPO_ROOT / "tests" / "python-runtime-summary.json"
    summary_path.write_text(json.dumps({
        "totalTests": len(results),
        "passed": sum(1 for r in results if r["passed"]),
        "failed": failures,
        "results": results,
    }, indent=2, default=str))

    print(f"\n{'='*60}")
    print(f"Python runtime tests: {len(results) - failures}/{len(results)} passed")
    print(f"Per-test sidecars written to tests/<test>/python-runtime-result.json")
    print(f"Summary written to {summary_path}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(run())
