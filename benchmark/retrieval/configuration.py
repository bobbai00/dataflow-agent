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
"""Campaign settings validated before credentials, services, or artifacts."""
import argparse


def campaign_arms():
    """Retain historical arms and add a matched 2x2 evidence-exposure matrix."""
    arms = {
        f"{view}_flow{flow}": {
            "retrievalViews": ["full", "sample", "sample_stats"] if view == "adaptive" else [view],
            "flowEvidence": bool(flow),
            "dataEvidence": view in ["sample_stats", "adaptive"],
        }
        for view in ["full", "sample", "sample_stats", "adaptive"] for flow in [0, 1]
    }
    # Historical twins profile every row exactly instead of a bounded prefix.
    arms.update({f"{name}_fullstats": {**arm, "nativeProfileScope": "full"}
                 for name, arm in list(arms.items())})
    # Full retrieval, collection, and profiling scope stay fixed; only what the
    # model may see changes. Keep these names separate from historical arms.
    arms.update({
        f"evidence_data{data}_flow{flow}": {
            "retrievalViews": ["sample_stats" if data else "sample", "full"],
            "dataEvidence": bool(data),
            "flowEvidence": bool(flow),
            "nativeProfileScope": "full",
        }
        for data in [0, 1] for flow in [0, 1]
    })
    # A full-only baseline for the same matrix: results are read only in full,
    # so evidence_data1_flow{0,1} add exactly the statistics view, and the flow
    # arm adds exactly flow evidence. Collection and profiling stay matched.
    arms.update({
        f"evidence_full_flow{flow}": {
            "retrievalViews": ["full"],
            "dataEvidence": False,
            "flowEvidence": bool(flow),
            "nativeProfileScope": "full",
        }
        for flow in [0, 1]
    })
    # Leaner tool results on the default views (2026-10-21 cache-write study):
    # tab-separated records and column names once per table up to 40 columns;
    # then also only the first 5 rows of a full view of a table larger than its
    # budget, and no empty python field in calls.
    arms["evidence_data1_flow0_tsv"] = {**arms["evidence_data1_flow0"], "tableFormat": "tsv", "keyValueColumns": 40}
    arms["evidence_data1_flow0_lean"] = {**arms["evidence_data1_flow0_tsv"], "fullPreviewRows": 5,
                                         "optionalPython": True}
    # The lean arm with the 2026-10-21 trace-study fixes: notes for keys written in several
    # ways and for null join keys, null counts with full views, the normalize-keys prompt
    # rule, pandas rounding in user code, and no `columns:` line beside complete statistics.
    arms["evidence_data1_flow0_hygiene"] = {**arms["evidence_data1_flow0_lean"], "dataHygiene": True,
                                            "pandasRound": True, "compactRecords": True}
    # The same for models whose strict tool mode requires every field (OpenAI): python stays required.
    arms["evidence_data1_flow0_hygiene_strict"] = {**arms["evidence_data1_flow0_hygiene"], "optionalPython": False}
    # The hygiene arm whose final reply holds only the requested answer (2026-10-24 cost study: Opus wrote
    # 750-1,200 characters of report around the answer); evaluate_task.py also rewrites the task's answer line to
    # ask for that line alone. The strict variant is for non-Claude models.
    arms["evidence_data1_flow0_opt"] = {**arms["evidence_data1_flow0_hygiene"], "answerOnlyReply": True}
    arms["evidence_data1_flow0_opt_strict"] = {**arms["evidence_data1_flow0_opt"], "optionalPython": False}
    return arms


def full_result_char_limit(value):
    """Match the agent API's display-cap bounds; transport retention is separate."""
    message = "full result character limit must be an integer between 128 and 100000"
    try:
        limit = int(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(message) from exc
    if not 128 <= limit <= 100000:
        raise argparse.ArgumentTypeError(message)
    return limit
