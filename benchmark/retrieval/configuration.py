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
