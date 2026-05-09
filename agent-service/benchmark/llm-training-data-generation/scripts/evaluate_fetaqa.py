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
"""
Native FeTaQA-style evaluation over generated traces.

Reads each `traces/<task_id>/{task.json, meta.json}`, computes the metrics
the FeTaQA paper reports — corpus BLEU (sacrebleu) and ROUGE-1/2/L
(rouge-score) — and writes:

  * per-trace `native_score.json` next to each task's other files
  * an aggregated `native-summary.json` at the source root

We deliberately use the published reference libraries instead of
hand-rolled implementations so the numbers are comparable to the FeTaQA
paper and other downstream benchmarks.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from statistics import mean, median
from typing import Any, Dict, List

import sacrebleu
from rouge_score import rouge_scorer


def load_predictions(traces_dir: Path) -> List[Dict[str, Any]]:
    """Walk traces/<id>/ and collect (id, gold, predicted, dir) records."""
    rows: List[Dict[str, Any]] = []
    for trace_dir in sorted(traces_dir.iterdir()):
        if not trace_dir.is_dir():
            continue
        task_path = trace_dir / "task.json"
        meta_path = trace_dir / "meta.json"
        if not (task_path.exists() and meta_path.exists()):
            continue
        task = json.loads(task_path.read_text())
        meta = json.loads(meta_path.read_text())
        # Score on the parsed `Final Answer:` value when present, else the raw
        # tail of the trace. parsedAnswer is what the agent actually committed
        # to as its answer; finalAnswer often carries surrounding prose.
        predicted = (meta.get("parsedAnswer") or meta.get("finalAnswer") or "").strip()
        rows.append(
            {
                "task_id": task["id"],
                "trace_dir": trace_dir,
                "gold": task["goldAnswer"],
                "predicted": predicted,
            }
        )
    return rows


def per_task_rouge(scorer: rouge_scorer.RougeScorer, gold: str, predicted: str) -> Dict[str, float]:
    out = scorer.score(gold or "", predicted or "")
    return {
        "rouge1_f": out["rouge1"].fmeasure,
        "rouge2_f": out["rouge2"].fmeasure,
        "rougeL_f": out["rougeL"].fmeasure,
    }


def per_task_sentence_bleu(gold: str, predicted: str) -> float:
    """Sentence-level BLEU. Useful for per-task inspection.

    For aggregate reporting we use corpus_bleu separately, which is what the
    FeTaQA paper publishes — sentence_bleu is reported here only as context.
    """
    if not predicted.strip():
        return 0.0
    return sacrebleu.sentence_bleu(predicted, [gold]).score


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True, help="Path to output/<source>/")
    parser.add_argument(
        "--pass-threshold",
        type=float,
        default=0.4,
        help="ROUGE-L F threshold above which a trace is counted as passed (default 0.4).",
    )
    args = parser.parse_args()

    output_root = Path(args.output_dir).resolve()
    traces_dir = output_root / "traces"
    if not traces_dir.is_dir():
        print(f"No traces directory at {traces_dir}", file=sys.stderr)
        return 1

    rows = load_predictions(traces_dir)
    if not rows:
        print(f"No traces under {traces_dir}", file=sys.stderr)
        return 1

    scorer = rouge_scorer.RougeScorer(["rouge1", "rouge2", "rougeL"], use_stemmer=True)

    refs: List[str] = []
    hyps: List[str] = []
    per_task: List[Dict[str, Any]] = []

    for r in rows:
        rouge = per_task_rouge(scorer, r["gold"], r["predicted"])
        sent_bleu = per_task_sentence_bleu(r["gold"], r["predicted"])
        passed = rouge["rougeL_f"] >= args.pass_threshold

        per_task.append(
            {
                "task_id": r["task_id"],
                "gold": r["gold"],
                "predicted": r["predicted"],
                "sentence_bleu": sent_bleu,
                **rouge,
                "passed": passed,
            }
        )

        # Persist the native score alongside the trace so evaluators can
        # re-aggregate without re-scoring.
        (r["trace_dir"] / "native_score.json").write_text(
            json.dumps(
                {
                    "metric_lib": {"bleu": "sacrebleu", "rouge": "rouge-score"},
                    "rouge1_f": rouge["rouge1_f"],
                    "rouge2_f": rouge["rouge2_f"],
                    "rougeL_f": rouge["rougeL_f"],
                    "sentence_bleu": sent_bleu,
                    "passed": passed,
                    "pass_threshold": args.pass_threshold,
                },
                indent=2,
            )
        )

        refs.append(r["gold"] or "")
        hyps.append(r["predicted"] or "")

    # Corpus BLEU is what the FeTaQA paper publishes (BLEU-4 with default
    # tokenization). sacrebleu handles tokenization deterministically.
    corpus_bleu = sacrebleu.corpus_bleu(hyps, [refs])

    n = len(per_task)
    rouge1s = [r["rouge1_f"] for r in per_task]
    rouge2s = [r["rouge2_f"] for r in per_task]
    rougeLs = [r["rougeL_f"] for r in per_task]
    passed = sum(1 for r in per_task if r["passed"])

    summary: Dict[str, Any] = {
        "source": output_root.name,
        "tasks": n,
        "metric_lib": {"bleu": "sacrebleu", "rouge": "rouge-score"},
        "corpus_bleu": corpus_bleu.score,
        "corpus_bleu_signature": str(corpus_bleu.signature) if hasattr(corpus_bleu, "signature") else None,
        "rouge1_f_mean": mean(rouge1s),
        "rouge1_f_median": median(rouge1s),
        "rouge2_f_mean": mean(rouge2s),
        "rouge2_f_median": median(rouge2s),
        "rougeL_f_mean": mean(rougeLs),
        "rougeL_f_median": median(rougeLs),
        "passed": passed,
        "pass_rate": passed / n if n else 0.0,
        "pass_threshold": args.pass_threshold,
        "per_task": per_task,
    }

    out_path = output_root / "native-summary.json"
    out_path.write_text(json.dumps(summary, indent=2))

    # Compact human-readable report — picked up by the TS wrapper.
    print(f"native eval: source={output_root.name} tasks={n}")
    print(f"  corpus BLEU : {corpus_bleu.score:.2f}")
    print(f"  ROUGE-1     : mean={mean(rouge1s):.4f}  median={median(rouge1s):.4f}")
    print(f"  ROUGE-2     : mean={mean(rouge2s):.4f}  median={median(rouge2s):.4f}")
    print(f"  ROUGE-L     : mean={mean(rougeLs):.4f}  median={median(rougeLs):.4f}")
    print(
        f"  passed (ROUGE-L>={args.pass_threshold}): {passed}/{n}"
        f"  ({(passed / n * 100 if n else 0):.1f}%)"
    )
    print(f"summary written: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
