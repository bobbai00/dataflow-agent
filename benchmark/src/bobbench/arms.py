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
"""BobFlow's arms (the agent settings each configuration adds to the run's base) and Script ReAct's settings.

The paper's arms: `evidence_full_flow0` (plain BobFlow: whole results only), `evidence_data1_flow0` (opt1: the sample
with column statistics, whole results on request) and `evidence_data1_flow0_opt` (with opts, Claude) /
`evidence_data1_flow0_opt_strict` (with opts, models whose strict tool mode needs every field). The two Flow Evidence
arms add runtime statistics of the dataflow (`evidence_*_flow1`). Every arm keeps full retrieval and full-table profile
collection; only what the model may see changes.
"""
import argparse


def base_settings(sample_char_limit=2000, full_result_char_limit=5000):
    """Every BobFlow attempt's settings before its arm: 25 steps, 10-minute workflow executions, 3 sample rows, samples
    and statistics of `sample_char_limit` characters, whole results of `full_result_char_limit`, table profiles on."""
    return {"nativeProfileCollection": True, "maxSteps": 25, "maxOperatorResultCharLimit": sample_char_limit,
            "maxResultRows": 3, "fullResultCharLimit": full_result_char_limit, "executionTimeoutMinutes": 10}


def arms():
    arms = {f"evidence_data1_flow{flow}": {"retrievalViews": ["sample_stats", "full"], "dataEvidence": True,
                                           "flowEvidence": bool(flow)} for flow in [0, 1]}
    # Whole results only: evidence_data1_flow{0,1} add exactly the statistics view, flow1 exactly Flow Evidence.
    arms.update({f"evidence_full_flow{flow}": {"retrievalViews": ["full"], "dataEvidence": False,
                                               "flowEvidence": bool(flow)} for flow in [0, 1]})
    # Leaner tool results (2026-10-21 cache-write study): tab-separated records and column names once per table up to
    # 40 columns; then also only the first 5 rows of a whole result larger than its budget, and no empty python field.
    arms["evidence_data1_flow0_tsv"] = {**arms["evidence_data1_flow0"], "tableFormat": "tsv", "keyValueColumns": 40}
    arms["evidence_data1_flow0_lean"] = {**arms["evidence_data1_flow0_tsv"], "fullPreviewRows": 5, "optionalPython": True}
    # The 2026-10-21 trace-study fixes: notes for keys written in several ways and for null join keys, null counts with
    # whole results, the normalize-keys prompt rule, pandas rounding in user code, and no `columns:` line beside
    # complete statistics.
    arms["evidence_data1_flow0_hygiene"] = {**arms["evidence_data1_flow0_lean"], "dataHygiene": True,
                                            "pandasRound": True, "compactRecords": True}
    # The same for models whose strict tool mode requires every field (OpenAI): python stays required.
    arms["evidence_data1_flow0_hygiene_strict"] = {**arms["evidence_data1_flow0_hygiene"], "optionalPython": False}
    # The optimized setting: a final reply holding only the requested answer (2026-10-24 cost study: Opus wrote
    # 750-1,200 characters of report around the answer); the task's answer line asks for that line alone too.
    arms["evidence_data1_flow0_opt"] = {**arms["evidence_data1_flow0_hygiene"], "answerOnlyReply": True}
    arms["evidence_data1_flow0_opt_strict"] = {**arms["evidence_data1_flow0_opt"], "optionalPython": False}
    return arms


ARMS = arms()

# Script ReAct (smolagents' CodeAgent): 25 steps, 5,000 characters of execution output per step, the custom
# instructions (step decomposition and data pitfalls, the counterpart of BobFlow's analysis principles), and the answer
# through the final_answer tool.
SCRIPT_REACT = {"max_steps": 25, "max_print_outputs_length": 5000, "use_custom_prompt": True,
                "final_answer_tool_prompt": True}


def full_result_char_limit(value):
    """argparse type: the agent API's bounds for the whole-result display cap."""
    message = "full result character limit must be an integer between 128 and 100000"
    try:
        limit = int(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(message) from exc
    if not 128 <= limit <= 100000:
        raise argparse.ArgumentTypeError(message)
    return limit
