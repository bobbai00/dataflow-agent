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

"""Split the Boston demo cut into a training file and an inference file.

    python3 split-boston-ml.py boston_single_family_fy2026_demo.csv out_dir/

Produces, in `out_dir`:
  boston_train.csv      80% of homes, every column including TOTAL_VALUE (the label)
  boston_inference.csv  20% of homes, feature columns only — no TOTAL_VALUE
  boston_holdout_truth.csv  PID -> TOTAL_VALUE for the inference rows

The inference file deliberately has no label: that is what makes the demo a real
prediction task rather than a lookup, and it means an agent cannot accidentally
score itself by reading the answer. The truth file is kept out of the uploaded
dataset so a human can check the predictions afterwards.

The 60 rows `prepare-boston-demo.py` corrupted (values over $10M) are dropped
here — a price model trained on $100M houses is not a demo, it is a bug.

Split is deterministic (every fifth home by PID), not random: reruns produce
byte-identical files, and no PID appears in both halves.
"""

import csv
import os
import sys

LABEL = "TOTAL_VALUE"
# Assessed value is defined as LAND_VALUE + BLDG_VALUE, so leaving those two in
# the feature set would hand the model the answer.
LEAKING_COLUMNS = ["LAND_VALUE", "BLDG_VALUE"]
VALUE_SANITY_CAP = 10_000_000
INFERENCE_EVERY = 5


def main(src_path, out_dir):
    with open(src_path, newline="") as f:
        rows = list(csv.DictReader(f))
    fields = list(rows[0].keys())

    clean = [r for r in rows if float(r[LABEL]) <= VALUE_SANITY_CAP]
    print(f"read {len(rows)} rows, dropped {len(rows) - len(clean)} over ${VALUE_SANITY_CAP:,}")

    clean.sort(key=lambda r: r["PID"])
    train, inference = [], []
    for i, row in enumerate(clean):
        (inference if i % INFERENCE_EVERY == 0 else train).append(row)

    feature_fields = [c for c in fields if c not in LEAKING_COLUMNS and c != LABEL]
    os.makedirs(out_dir, exist_ok=True)
    paths = {
        "boston_train.csv": ([c for c in fields if c not in LEAKING_COLUMNS], train),
        "boston_inference.csv": (feature_fields, inference),
        "boston_holdout_truth.csv": (["PID", LABEL], inference),
    }
    for name, (cols, data) in paths.items():
        with open(os.path.join(out_dir, name), "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(data)
        print(f"wrote {name}: {len(data)} rows x {len(cols)} columns")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
