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
import hashlib
import random
import subprocess

SOURCE_PATHS = ["agent-service/src", "amber/src", "access-control-service/src", "benchmark/retrieval",
                "bin/strict_tools.py", "bin/litellm-config.yaml", "bin/single-node/litellm-config.yaml"]


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
    arms.update({f"layout_{layout}": {
        "messageLayout": layout, "retrievalViews": ["sample_stats", "full"],
        "dataEvidence": True, "flowEvidence": True, "nativeProfileScope": "full",
    } for layout in ["native", "markdown"]})
    return arms


def campaign_jobs(models, arms, tasks, repetitions, tag):
    """Deterministic matched worklist shared by dry-run validation and launch."""
    jobs = []
    for rep in range(1, repetitions + 1):
        batch = [{"model": model, "arm": arm, "task": task, "rep": rep,
                  "sut": f"DataflowSystem{model}_{tag}_{arm}_Rep{rep}"}
                 for model in models for arm in arms for task in tasks]
        random.Random(101 + rep).shuffle(batch)
        jobs.extend(batch)
    return jobs


def source_snapshot(root):
    """Hash working-tree runtime, gateway and harness sources without exposing contents."""
    paths = subprocess.check_output(["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "--",
                                     *SOURCE_PATHS], text=True).splitlines()
    digest, files = hashlib.sha256(), []
    for name in sorted(set(paths)):
        source = root / name
        if source.is_file():
            contents = source.read_bytes()
            digest.update(name.encode() + b"\0" + contents + b"\0")
            files.append({"path": name, "sha256": hashlib.sha256(contents).hexdigest()})
    return {"sha256": digest.hexdigest(), "files": files}


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
