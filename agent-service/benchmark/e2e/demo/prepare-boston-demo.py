#!/usr/bin/env python3
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

"""Build the doctored CSV behind the Boston agent demo (docs/agent-demo-playbook-boston.md).

    python3 prepare-boston-demo.py fy2026.csv boston_single_family_fy2026_demo.csv

Input is the raw City of Boston property-assessment CSV for one fiscal year
(https://data.boston.gov/dataset/property-assessment). Output is the demo cut.

The result is NOT real assessment data: a handful of rows carry deliberately
corrupted values so the demo has a data-quality problem to find. Keep the
warning in the dataset description wherever the file is uploaded.

Two demo edits, both deliberate:

  1. Drop rows where CITY == "BOSTON". In this file CITY is really the
     neighborhood, and "BOSTON" means the downtown core — a row that reads as
     "Boston, in the Boston dataset" and derails the story every time.
  2. Corrupt ANOMALY_COUNT rows in one neighborhood by multiplying their
     LAND_VALUE and BLDG_VALUE by ANOMALY_MULTIPLIER (recomputing TOTAL_VALUE as
     the sum) — a decimal-shift data-entry error, the kind that really happens.
     0.6% of the neighborhood's rows end up in the tens or hundreds of millions.

What edit 2 buys the demo: the neighborhood's *average* is dragged to the top of
any price ranking while its *median* does not move at all. So the bar chart lies,
the lie is invisible in a table preview (20 rows out of 3 349), and it only shows
up when somebody asks to see the distribution. Deleting those rows changes the
answer to the original question — which is the point: the human's feedback is
what makes the analysis correct, not a nicety.

Sizes, rooms, year built and condition are never touched, so a corrupted row is
an ordinary house carrying an impossible price — exactly what a real entry error
looks like, and what makes it defensible to drop.
"""

import csv
import statistics
import sys
from collections import defaultdict

# Where the corrupted rows go. Roslindale is a good host: 3 349 homes (so the
# "it's a small sample" explanation is off the table when the demo checks counts)
# and an unremarkable real average of $721k, so it has no business topping a
# price chart — the anomaly is the only reason it does.
ANOMALY_CITY = "ROSLINDALE"
# 60 rows is 1.8% of the neighborhood. Tuned, not guessed: it has to drag the
# mean past the genuinely-most-expensive neighborhood (Charlestown, $1.43M) by
# enough that the bar chart reads as "Roslindale is the priciest" rather than
# "it is joint first" — 20 rows only reached third place. Still far too few to
# notice in a sample-data preview.
ANOMALY_COUNT = 60
# A misplaced decimal point, two places over. Turns a $1.4M house into a $140M
# one: impossible for a single-family home, so nobody has to argue about whether
# it is real.
ANOMALY_MULTIPLIER = 100
AMBIGUOUS_CITY = "BOSTON"
VALUE_TAIL_CAP = 3_000_000
# The 23 columns the demo keeps, out of the raw file's 66. `YR_REMODEL` is
# deliberately absent: blank for 55% of homes, and it silently halved the
# training rows the first time the demo trained a model on this data.
KEEP_COLUMNS = [
    "PID", "CITY", "ZIP_CODE",
    "LAND_SF", "GROSS_AREA", "LIVING_AREA",
    "YR_BUILT", "BED_RMS", "FULL_BTH", "HLF_BTH", "TT_RMS", "KITCHENS",
    "FIREPLACES", "NUM_PARKING",
    "OVERALL_COND", "INT_COND", "EXT_COND", "HEAT_TYPE", "AC_TYPE", "OWN_OCC",
    "LAND_VALUE", "BLDG_VALUE", "TOTAL_VALUE",
]
NUMERIC_COLUMNS = [
    "LAND_SF",
    "GROSS_AREA",
    "LIVING_AREA",
    "YR_BUILT",
    "BED_RMS",
    "FULL_BTH",
    "HLF_BTH",
    "TT_RMS",
    "KITCHENS",
    "FIREPLACES",
    "NUM_PARKING",
    "LAND_VALUE",
    "BLDG_VALUE",
    "TOTAL_VALUE",
]


def format_number(value):
    """Plain decimal text, never scientific notation.

    `f"{v:g}"` looks right and is not: it switches to exponent form past six
    significant digits, so a $1 428 300 assessment lands in the CSV as
    "1.4283e+06". The engine's CSV scan then mis-types the column and silently
    drops rows — a bug that survives any check comparing parsed floats, because
    float("1.4283e+06") == 1428300.0.
    """
    number = float(value)
    return str(int(number)) if number.is_integer() else f"{number:.10f}".rstrip("0").rstrip(".")


def as_number(raw):
    """City CSVs carry thousands separators and stray currency symbols."""
    cleaned = (raw or "").replace(",", "").replace("$", "").strip()
    if cleaned in ("", "NA", "N/A"):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def main(src_path, out_path):
    with open(src_path, newline="", encoding="utf-8-sig") as f:
        raw_rows = list(csv.DictReader(f))
    print(f"raw rows: {len(raw_rows)}")

    missing = [c for c in KEEP_COLUMNS if c not in raw_rows[0]]
    if missing:
        sys.exit(f"input is missing expected columns: {missing}")
    fields = KEEP_COLUMNS
    rows = []
    for row in raw_rows:
        if (row.get("LU") or "").strip() != "R1":  # single-family dwellings only
            continue
        if (row.get("CITY") or "").strip().upper() == AMBIGUOUS_CITY:
            continue
        numbers = {c: as_number(row.get(c)) for c in NUMERIC_COLUMNS if c in row}
        if any(v is None for v in numbers.values()):
            continue
        if numbers["TOTAL_VALUE"] > VALUE_TAIL_CAP:
            continue
        kept = {c: row.get(c, "") for c in fields}
        for c, v in numbers.items():
            if c in kept:
                kept[c] = format_number(v)
        rows.append(kept)
    print(f"after R1 / {AMBIGUOUS_CITY} / cap / missing filters: {len(rows)}")

    # Spread the corrupted rows evenly through the neighborhood (by PID) instead
    # of picking the top values or a random sample: deterministic across runs, and
    # it keeps them from clustering into something that looks like a real luxury
    # pocket rather than an error.
    targets = sorted(
        (i for i, row in enumerate(rows) if row["CITY"].strip().upper() == ANOMALY_CITY),
        key=lambda i: rows[i]["PID"],
    )
    stride = max(1, len(targets) // ANOMALY_COUNT)
    corrupted = []
    for i in targets[:: stride][:ANOMALY_COUNT]:
        row = rows[i]
        land = int(float(row["LAND_VALUE"]) * ANOMALY_MULTIPLIER)
        bldg = int(float(row["BLDG_VALUE"]) * ANOMALY_MULTIPLIER)
        row["LAND_VALUE"] = format_number(land)
        row["BLDG_VALUE"] = format_number(bldg)
        row["TOTAL_VALUE"] = format_number(land + bldg)
        corrupted.append(land + bldg)
    print(
        f"corrupted {len(corrupted)} of {len(targets)} {ANOMALY_CITY} rows "
        f"(x{ANOMALY_MULTIPLIER}): ${min(corrupted):,} .. ${max(corrupted):,}"
    )

    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    by_city = defaultdict(list)
    for row in rows:
        by_city[row["CITY"]].append(float(row["TOTAL_VALUE"]))
    # Print the median beside the mean: the gap between the two columns for the
    # anomaly city is the whole demo.
    print(f"\n{'CITY':20}{'homes':>7}{'mean':>13}{'median':>13}")
    for city, values in sorted(by_city.items(), key=lambda kv: -statistics.mean(kv[1])):
        print(f"{city:20}{len(values):7d}{statistics.mean(values):13,.0f}{statistics.median(values):13,.0f}")
    print(f"\nwrote {out_path}: {len(rows)} rows x {len(fields)} columns")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
