# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Compare what two versions of the agent restored on the same jumps (replay-dataflow.ts --verify-jumps).

Both files come from replays of the same conversations, so each line is the same jump. Only what two runs cannot share
is normalized: the agent's id and the timestamps in step and message ids, the engine's workflow and execution ids,
timings (with the size of the engine profiler's report, which holds its own), random diagnostic ids, and content hashes (a hash of operator code differs once the code holds the runtime
token, so hashes are renamed in order of first appearance: equal up to renaming means the same versions). Everything
else, from the dataflow and its results to the conversation and the model's next context, must be equal.

    python3 -I compare_restores.py A/restores.jsonl B/restores.jsonl [--examples 3]
"""
import argparse
import json
import re
from collections import Counter

# payloadBytes: the size of the engine profiler's report, which holds its own timings.
DROPPED = re.compile(r"^(timestamp|timing|clientTiming|executionId|workflowId|diagnosticId|payloadBytes)$|(Ms|At)$")
HASH = re.compile(r"\b(?:[0-9a-f]{64}|[0-9a-f]{32})\b")


class Normalizer:
    def __init__(self):
        self.agent = None
        self.hashes = {}

    def text(self, s):
        if self.agent is None:
            found = re.search(r"agent-[a-z0-9]+-\d+", s)
            self.agent = found.group(0) if found else None
        if self.agent:
            s = s.replace(self.agent, "AGENT")
        s = re.sub(r"(step|msg|act)-AGENT-(\d+(?:-init)?)-\d{13}", r"\1-\2", s)
        s = re.sub(r"WF\d+", "WF", s)
        s = re.sub(r"\b1[78]\d{11}\b", "T", s)  # epoch milliseconds inside text
        return HASH.sub(lambda m: self.hashes.setdefault(m.group(0), f"H{len(self.hashes)}"), s)

    def value(self, v):
        if isinstance(v, str) and v[:1] in "{[":
            try:
                v = json.loads(v)
            except ValueError:
                pass
        elif isinstance(v, str) and v.endswith("}") and ": {" in v:
            # A receipt: text, then a JSON object ("Action 2 (execute) failed: {...}").
            at = v.index(": {") + 2
            try:
                return [self.text(v[:at]), self.value(json.loads(v[at:]))]
            except ValueError:
                pass
        if isinstance(v, dict):
            return {self.text(k): self.value(x) for k, x in v.items() if not DROPPED.search(k)}
        if isinstance(v, list):
            return [self.value(x) for x in v]
        return self.text(v) if isinstance(v, str) else v


def differences(x, y, at=""):
    if isinstance(x, dict) and isinstance(y, dict):
        for k in sorted(set(x) | set(y)):
            yield from differences(x.get(k), y.get(k), f"{at}.{k}")
    elif isinstance(x, list) and isinstance(y, list) and len(x) == len(y):
        for i, (u, v) in enumerate(zip(x, y)):
            yield from differences(u, v, f"{at}[{i}]")
    elif x != y:
        yield at, x, y


def excerpt(x, y):
    if isinstance(x, str) and isinstance(y, str):
        i = next((i for i, (u, v) in enumerate(zip(x, y)) if u != v), min(len(x), len(y)))
        return f"...{x[max(0, i - 100):i + 100]!r}", f"...{y[max(0, i - 100):i + 100]!r}"
    return repr(x)[:200], repr(y)[:200]


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("a")
    parser.add_argument("b")
    parser.add_argument("--examples", type=int, default=3)
    args = parser.parse_args()
    na, nb = Normalizer(), Normalizer()
    records, equal = Counter(), Counter()
    kinds, examples = Counter(), {}
    with open(args.a) as fa, open(args.b) as fb:
        for la, lb in zip(fa, fb, strict=True):
            a, b = na.value(json.loads(la)), nb.value(json.loads(lb))
            if a["target"] != b["target"]:
                raise SystemExit(f"line {a['index']}: the files jumped to different targets")
            kind = a["target"]["kind"]
            records[kind] += 1
            found = list(differences(a, b))
            if not found:
                equal[kind] += 1
            for at, x, y in found:
                key = re.sub(r"\[\d+\]", "[]", at)
                kinds[key] += 1
                examples.setdefault(key, []).append((a["target"], at, x, y))
    for kind in records:
        print(f"{kind} jumps: {equal[kind]} of {records[kind]} restored the same")
    for key, n in kinds.most_common():
        print(f"{n:6d} differ at {key}")
        for target, at, x, y in examples[key][: args.examples]:
            ex, ey = excerpt(x, y)
            print(f"         {target['kind']} {target['id']} {at}\n           A: {ex}\n           B: {ey}")
    print(f"same restores: {sum(equal.values())} of {sum(records.values())}")


if __name__ == "__main__":
    main()
