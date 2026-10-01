# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Offline paper-style annotation of saved Terra pilot traces.

Build isolated evidence bundles, run the original E.3 prompt with Codex,
and validate coverage without changing the frozen correctness judgments.
The paper prompt is supplied from a local pdftotext -raw extraction.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time


CATEGORIES = [
    "Statistical / Domain Reasoning Error", "Planning Error",
    "Instruction Following Error", "Coding / Implementation Error",
    "Context Memory Error", "State Management Error", "Cascade Error",
]
ROOT = Path(__file__).resolve().parents[2]
CONTROL = ROOT / "logs/longds-annotation-20260930"
PILOT = ROOT / "logs/longds-terra-20260930"


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dsgym_turn(messages, question):
    starts = [i for i, m in enumerate(messages)
              if m.get("role") == "user" and "<information>" not in m.get("content", "")
              and m.get("content", "").endswith("Question: " + question)]
    if len(starts) != 1:
        raise ValueError(f"Expected exactly one turn boundary, got {starts}")
    start = starts[0]
    return start, messages[start:]


def summarize(items, patterns):
    return {
        "total_incorrect_tasks": len(items),
        "primary_error_type_counts": {c: sum(i["primary_error_type"] == c for i in items) for c in CATEGORIES},
        "all_error_type_counts": {c: sum(c in i["all_error_types"] for i in items) for c in CATEGORIES},
        "cascade_error_count": sum("Cascade Error" in i["all_error_types"] for i in items),
        "main_failure_patterns": patterns,
    }


def validate_annotation(result, rows):
    errors = []
    items = result.get("task_error_analysis", [])
    expected = {r["turn_id"] for r in rows if r["judge"]["score"] == 0}
    actual = [i.get("task_id") for i in items]
    if set(actual) != expected or len(actual) != len(set(actual)):
        errors.append(f"Coverage: expected {sorted(expected)}, received {actual}")
    turn_ids = {r["turn_id"] for r in rows}
    for item in items:
        turn = item.get("task_id")
        types = item.get("all_error_types", [])
        if not types or len(types) != len(set(types)) or set(types) - set(CATEGORIES):
            errors.append(f"Turn {turn}: invalid categories {types}")
        if item.get("primary_error_type") not in types:
            errors.append(f"Turn {turn}: primary must occur in all_error_types")
        upstream = item.get("upstream_error_task_id")
        upstream = [] if upstream is None else upstream if isinstance(upstream, list) else [upstream]
        if any(type(t) is not int or t not in turn_ids or t >= turn for t in upstream):
            errors.append(f"Turn {turn}: invalid upstream IDs {upstream}")
        if ("Cascade Error" in types) != bool(upstream):
            errors.append(f"Turn {turn}: cascade category and upstream IDs disagree")
        if item.get("confidence") not in ["high", "medium", "low"]:
            errors.append(f"Turn {turn}: invalid confidence")
        for field in ["error_summary", "evidence"]:
            if not isinstance(item.get(field), str) or not item[field].strip():
                errors.append(f"Turn {turn}: missing {field}")
    summary = result.get("summary", {})
    if items and all("primary_error_type" in i and "all_error_types" in i for i in items) or not items:
        computed = summarize(items, summary.get("main_failure_patterns", []))
        for key, value in computed.items():
            if summary.get(key) != value:
                errors.append(f"Summary {key} does not match the per-turn labels")
    return errors


def output_schema():
    def obj(properties):
        return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}
    counts = obj({c: {"type": "integer"} for c in CATEGORIES})
    item = obj({
        "task_id": {"type": "integer"},
        "primary_error_type": {"type": "string", "enum": CATEGORIES},
        "all_error_types": {"type": "array", "items": {"type": "string", "enum": CATEGORIES}},
        "upstream_error_task_id": {"anyOf": [{"type": "null"}, {"type": "integer"}, {"type": "array", "items": {"type": "integer"}}]},
        "error_summary": {"type": "string"}, "evidence": {"type": "string"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    })
    return obj({"summary": obj({
        "total_incorrect_tasks": {"type": "integer"},
        "primary_error_type_counts": counts, "all_error_type_counts": counts,
        "cascade_error_count": {"type": "integer"},
        "main_failure_patterns": {"type": "array", "items": {"type": "string"}},
    }), "task_error_analysis": {"type": "array", "items": item}})


def build_bundle(task, arm, workspace, paper_prompt):
    key = task["task"]
    sut = f"LongDS_PythonState_20260930_{arm}_terra_t1"
    source = ROOT / "benchmark/longds/system_scratch" / sut / key
    reference = ROOT / "benchmark/longds/DataMind/longds/dataset/task/longds_v1.1" / task["path"]
    directory = workspace / arm / key
    directory.mkdir(parents=True)
    (directory / "traces").mkdir()
    hashes = {}

    def track(path):
        hashes[str(path.absolute())] = sha(path)

    def copy(source_path, target):
        track(source_path)
        shutil.copyfile(source_path, directory / target)

    refs = read(reference / "task.json")
    for name, digest in task["source_sha256"].items():
        if sha(reference / name) != digest:
            raise ValueError(f"Reference revision mismatch: {key}/{name}")
    copy(reference / "task.json", "reference_turns.json")
    copy(reference / "metadata.json", "reference_metadata.json")
    copy(reference / "task.ipynb", "task.ipynb")
    copy(reference / "task.py", "ground_code.py")
    copy(source / "results_eval.json", "results_eval.original.json")
    copy(source / "protocol.json", "protocol.json")
    rows = read(source / "results_eval.json")
    if [r["turn_id"] for r in rows] != [r["turn_id"] for r in refs]:
        raise ValueError("Reference and run turn IDs differ")
    code = ["# Extracted agent code; consult each raw trajectory for execution status.\n"]
    code_index = []
    if arm == "dsgym":
        copy(source / "agent/traj.json", "traces/full_session.json")
    for row, ref in zip(rows, refs):
        turn = row["turn_id"]
        if row["question"] != ref["question"] or row["context"] != ref["context"] or row["ground_truth"] != ref["answer"]:
            raise ValueError(f"Mismatched reference for turn {turn}")
        if row["judge"]["score"] not in [0, 1]:
            raise ValueError(f"Unjudged turn {turn}")
        if arm == "dsgym":
            path = source / f"agent/bak/turn_{turn}_result.json"
            track(path)
            start, trajectory = dsgym_turn(read(path), row["question"])
            entries = []
            for index, message in enumerate(trajectory):
                if message.get("role") != "assistant":
                    continue
                for block in re.findall(r"<python>(.*?)</python>", message.get("content", ""), re.DOTALL):
                    next_message = trajectory[index + 1] if index + 1 < len(trajectory) else {}
                    evidence = next_message.get("content", "") if next_message.get("role") == "user" else ""
                    entries.append((index, block, "following observation recorded" if "<information>" in evidence else "no following execution observation"))
            row["trajectory_source_start_index"] = start
        else:
            path = source / f"t{turn:02}/react_steps.json"
            track(path)
            trajectory = read(path)
            entries = [(i, step["code_action"], "code_action recorded; inspect observations/error")
                       for i, step in enumerate(trajectory) if step.get("code_action")]
        write(directory / f"traces/t{turn:02}.json", trajectory)
        row["task_id"] = turn
        row["trajectory"] = trajectory
        row["trajectory_file"] = f"traces/t{turn:02}.json"
        for step, block, status in entries:
            code.append(f"\n# ===== TURN {turn}, trajectory index {step}: {status} =====\n{block.strip()}\n")
            code_index.append({"turn_id": turn, "trajectory_index": step, "execution_note": status})
    write(directory / "results_eval.json", rows)
    (directory / "code.py").write_text("\n".join(code))
    write(directory / "code_index.json", code_index)
    manifest_path = PILOT / "prepared" / key / "manifest.json"
    track(manifest_path)
    manifest = read(manifest_path)
    data_dir = (ROOT / manifest["data_dir"]).resolve()
    readme = f"""# Annotation evidence bundle

This is one full {arm} session. The benchmark's task_id is turn_id here.
The original scored rows are in results_eval.original.json. results_eval.json
adds task_id and the complete recorded per-turn trajectory, without changing
any original field or correctness judgment. traces/ provides the same steps
separately. No trace text is truncated by this adapter. Recorded observations
may already have been limited by the original solver's tool output budget.

code.py concatenates generated Python blocks with turn and trace indices.
It is an inspection aid, not a replayable script. Code with no execution
observation must not be treated as executed. Malformed output remains in the
raw traces. For smolagents, code_action is the submitted code and errors are
recorded in each ActionStep. For DSGym, information messages hold tool output.

ground_code.py and task.ipynb are unmodified benchmark reference files from
the same dataset directory whose task.json matches the frozen source hash.
reference_turns.json gives the exact turn-wise reference code and answers.
Reference code may use original relative dataset paths. For optional data
inspection use this existing read-only dataset directory:
{data_dir}

Available Python with pandas:
/home/bob/Desktop/dataflow-agent/benchmark/Kramabench/.venv/bin/python

Read this bundle and the input dataset only. Prior manual diagnoses and other
agent runs are outside this evidence bundle. Do not read them. Do not change
input files or rerun solver agents or correctness judges. Write error_ana.json
here. Scratch analysis files can be created in this directory.
"""
    (directory / "BUNDLE.md").write_text(readme)
    (directory / "annotation_prompt.txt").write_text(paper_prompt)
    write(directory / "output_schema.json", output_schema())
    inputs = {str(p.relative_to(directory)): sha(p) for p in directory.rglob("*") if p.is_file()}
    provenance = {"task": key, "arm": arm, "source_sha256": hashes, "bundle_sha256": inputs,
                  "failed_turns": [r["turn_id"] for r in rows if r["judge"]["score"] == 0]}
    write(directory / "provenance.json", provenance)
    return {"arm": arm, "task": key, "directory": str(directory), "failed_turns": provenance["failed_turns"]}


def build_native_bundle(job, workspace, paper_prompt):
    """Adapt complete action traces without changing E.3 or correctness scores."""
    source, reference = Path(job["run_dir"]), Path(job["reference_dir"])
    directory = workspace / job["arm"] / job["task"]
    directory.mkdir(parents=True)
    hashes = {}

    def copy(path, target):
        hashes[str(path.absolute())] = sha(path)
        destination = directory / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)

    for name, digest in job["reference_sha256"].items():
        if sha(reference / name) != digest:
            raise ValueError(f"Reference revision mismatch: {name}")
    for name, target in [("task.json", "reference_turns.json"), ("metadata.json", "reference_metadata.json"),
                         ("task.py", "ground_code.py"), ("task.ipynb", "task.ipynb")]:
        copy(reference / name, target)
    copy(source / "results_eval.json", "results_eval.original.json")
    copy(source / "protocol.json", "protocol.json")
    for name in ["task-dataflows.json", "anomalies.json", "wire-usage.json", "system-info.json", "settings.json"]:
        if (source / name).exists():
            copy(source / name, name)
    rows, refs = read(source / "results_eval.json"), read(reference / "task.json")
    if [row["turn_id"] for row in rows] != [row["turn_id"] for row in refs]:
        raise ValueError("Annotation requires a complete scored session with matching reference turn IDs")
    code = ["# Submitted Dataflow edits, commented for inspection; not an executable script."]
    for row, ref in zip(rows, refs):
        if any(row[field] != ref[other] for field, other in [("question", "question"), ("context", "context"), ("ground_truth", "answer")]):
            raise ValueError(f"Reference mismatch at turn {row['turn_id']}")
        if row["judge"].get("score") not in [0, 1]:
            raise ValueError(f"Unjudged turn {row['turn_id']}")
        turn = f"t{row['turn_id']:02}"
        for path in sorted((source / turn).glob("*")):
            if path.is_file():
                copy(path, f"traces/{turn}/{path.name}")
        trajectory = read(source / turn / "react_steps.json")
        row.update(task_id=row["turn_id"], trajectory=trajectory,
                   trajectory_file=f"traces/{turn}/react_steps.json",
                   runtime_errors=read(source / turn / "answer.json").get("errors", []))
        for step in trajectory:
            for result in step.get("toolResults", []):
                outcome = result.get("output")
                if not isinstance(outcome, dict) or outcome.get("kind") != "dataflow-actions":
                    continue
                for action in outcome.get("actions", []):
                    if action["action"].get("type") == "edit":
                        code.append(f"\n# Turn {row['turn_id']}, step {step.get('id')}, action {action['index']}: {action['status']}")
                        code.extend("# " + line for line in action["action"].get("changes", "").splitlines())
    write(directory / "results_eval.json", rows)
    (directory / "code.py").write_text("\n".join(code) + "\n")
    (directory / "annotation_prompt.txt").write_text(paper_prompt)
    write(directory / "output_schema.json", output_schema())
    (directory / "BUNDLE.md").write_text(f"""# Native Dataflow annotation bundle

This is one complete {job['arm']} session. Paper task_id means turn_id here.
Apply annotation_prompt.txt unchanged. results_eval.original.json preserves
the original judge. results_eval.json adds full per-turn traces and runtime
errors from answer.json, including failures that produced no tool trace.

code.py lists submitted graph edits for inspection. An accepted edit is only a
definition change: inspect Execute receipts to determine what actually ran.
Execution can fail partially; cached results retain their producing execution.
traces/ includes raw actions, ordered receipts, snapshots, results, user prompts
and final answers. task-dataflows.json, when present, records saved exports,
producing graphs and exact imported output versions. Inspection alone is not
a computational task dependency. These records do not establish correctness.

Operational alerts are screening signals, not confirmed infinite loops or
cache bugs. wire-usage.json distinguishes task boundaries and missing usage.
Byte/message overlap does not measure cached tokens. Use the original seven
error categories. Ground truth or judge disagreements should be explained
with evidence and confidence, while preserving original scores.

ground_code.py, task.ipynb and reference_turns.json are unmodified benchmark
references whose hashes and turn contents were verified. Raw input directory:
{job['data_dir']}

Read this bundle and those inputs only. Do not consult other runs or prior
diagnoses, change inputs, rerun solvers or judges, or call external agents.
Write error_ana.json here. Scratch analysis is permitted in this directory.
""")
    inputs = {str(path.relative_to(directory)): sha(path) for path in directory.rglob("*") if path.is_file()}
    failed = [row["turn_id"] for row in rows if row["judge"]["score"] == 0]
    write(directory / "provenance.json", {"task": job["task"], "arm": job["arm"],
          "source_sha256": hashes, "bundle_sha256": inputs, "failed_turns": failed})
    return {"arm": job["arm"], "task": job["task"], "directory": str(directory), "failed_turns": failed}


def prepare(paper_raw, control, native_campaign=None):
    if (control / "campaign.json").exists():
        raise ValueError("Campaign already prepared; use its saved bundles")
    control.mkdir(parents=True, exist_ok=True)
    raw = Path(paper_raw).read_text()
    prompt = raw.split("E.3 Error Annotation Prompt\nError Annotation Prompt\n", 1)[1].replace("\f", "")
    (control / "original-prompt.txt").write_text(prompt)
    selection = read(native_campaign) if native_campaign else read(ROOT / "benchmark/longds/terra-state-selection-20260930.json")
    workspace = Path(tempfile.mkdtemp(prefix="longds-annotation-20260930-"))
    jobs = ([build_native_bundle(job, workspace, prompt) for job in selection["jobs"]] if native_campaign else
            [build_bundle(task, arm, workspace, prompt) for task in selection["tasks"] for arm in selection["arms"]])
    campaign = {"created_at": datetime.now(timezone.utc).isoformat(), "workspace": str(workspace),
                "model": "gpt-5.5", "reasoning_effort": "xhigh", "judge_model": "deepseek/deepseek-v4-pro",
                "paper": "https://arxiv.org/pdf/2605.30434v3", "prompt_source_sha256": sha(paper_raw),
                "prompt_sha256": sha(control / "original-prompt.txt"),
                "prompt_normalization": "Remove E.3 heading, duplicate title, and PDF form feeds only; preserve wording and line wraps.",
                "dataset_revision": selection["dataset_revision"], "jobs": jobs}
    write(control / "campaign.json", campaign)
    print(json.dumps({"workspace": str(workspace), "jobs": len(jobs), "failed_turns": sum(len(j["failed_turns"]) for j in jobs)}), flush=True)


def verify_inputs(directory):
    provenance = read(directory / "provenance.json")
    errors = []
    for path, expected in provenance["source_sha256"].items():
        if sha(path) != expected:
            errors.append(f"Changed source: {path}")
    for path, expected in provenance["bundle_sha256"].items():
        if sha(directory / path) != expected:
            errors.append(f"Changed bundle input: {path}")
    return errors


def run_job(job, control, timeout):
    directory = Path(job["directory"])
    saved = control / "runs" / job["arm"] / job["task"]
    saved.mkdir(parents=True, exist_ok=True)
    status_path = saved / "status.json"
    try:
        with status_path.open("x") as handle:
            json.dump({"arm": job["arm"], "task": job["task"], "status": "running",
                       "failed_turns": len(job["failed_turns"]),
                       "started_at": datetime.now(timezone.utc).isoformat()}, handle)
    except FileExistsError:
        return read(status_path)
    rows = read(directory / "results_eval.original.json")
    started = time.monotonic()
    if not job["failed_turns"]:
        result = {"summary": summarize([], []), "task_error_analysis": []}
        write(saved / "error_ana.raw.json", result)
        exit_code = 0
        command = None
    else:
        command = ["codex", "--ask-for-approval", "never", "exec", "--ignore-user-config", "--ephemeral",
                   "--skip-git-repo-check", "--sandbox", "workspace-write", "--model", "gpt-5.5",
                   "-c", 'model_reasoning_effort="xhigh"', "-C", str(directory), "--json",
                   "--output-schema", str(directory / "output_schema.json"),
                   "--output-last-message", str(saved / "final-response.json"), "-"]
        prompt = ("Execution note: Read BUNDLE.md for the file layout and turn-ID mapping. "
                  "Apply the original paper instructions below. Do not use external agents or prior analyses.\n\n"
                  + (directory / "annotation_prompt.txt").read_text())
        (saved / "input-prompt.txt").write_text(prompt)
        write(saved / "command.json", command)
        print(f"START {job['arm']} {job['task']} failures={len(job['failed_turns'])}", flush=True)
        with (saved / "codex.jsonl").open("w") as stdout, (saved / "codex.stderr.log").open("w") as stderr:
            try:
                proc = subprocess.run(command, input=prompt, text=True, stdout=stdout, stderr=stderr, timeout=timeout)
                exit_code = proc.returncode
            except subprocess.TimeoutExpired:
                exit_code = 124
        generated = directory / "error_ana.json"
        if not generated.exists():
            generated = saved / "final-response.json"
        if generated.exists():
            shutil.copyfile(generated, saved / "error_ana.raw.json")
    errors = verify_inputs(directory)
    try:
        result = read(saved / "error_ana.raw.json")
        errors.extend(validate_annotation(result, rows))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append(f"Output parsing/validation failed: {exc}")
    if exit_code != 0:
        errors.append(f"Codex exit code {exit_code}")
    if not errors:
        write(saved / "error_ana.json", result)
    status = {"arm": job["arm"], "task": job["task"], "failed_turns": len(job["failed_turns"]),
              "status": "valid" if not errors else "needs_review", "errors": errors,
              "elapsed_seconds": round(time.monotonic() - started, 2), "exit_code": exit_code,
              "model_called": command is not None}
    write(saved / "status.json", status)
    print("DONE " + json.dumps(status), flush=True)
    return status


def collect(campaign, control):
    annotations, sessions, usage = [], [], []
    for job in campaign["jobs"]:
        saved = control / "runs" / job["arm"] / job["task"]
        status = read(saved / "status.json") if (saved / "status.json").exists() else {"status": "pending"}
        session = {"arm": job["arm"], "task": job["task"], **status}
        if status["status"] == "valid":
            result = read(saved / "error_ana.json")
            rows = read(Path(job["directory"]) / "results_eval.original.json")
            by_turn = {r["turn_id"]: r for r in rows}
            errors = validate_annotation(result, rows)
            if errors:
                raise ValueError(errors)
            session["summary"] = result["summary"]
            session["annotation_sha256"] = sha(saved / "error_ana.json")
            for item in result["task_error_analysis"]:
                upstream = item["upstream_error_task_id"]
                upstream = [] if upstream is None else upstream if isinstance(upstream, list) else [upstream]
                annotations.append({"arm": job["arm"], "session": job["task"], **item,
                                    "upstream_answer_scores": {str(t): by_turn[t]["judge"]["score"] for t in upstream}})
        sessions.append(session)
        if (saved / "codex.jsonl").exists():
            for line in (saved / "codex.jsonl").read_text().splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get("type") == "turn.completed":
                    usage.append({"arm": job["arm"], "session": job["task"], **event.get("usage", {})})
    aggregate = {
        "model": campaign["model"], "reasoning_effort": campaign["reasoning_effort"],
        "correctness_judge": campaign["judge_model"],
        "expected_failed_turns": sum(len(j["failed_turns"]) for j in campaign["jobs"]),
        "valid_sessions": sum(s["status"] == "valid" for s in sessions),
        "summary": summarize(annotations, []),
        "by_arm": {arm: summarize([a for a in annotations if a["arm"] == arm], [])
                   for arm in sorted({j["arm"] for j in campaign["jobs"]})},
        "sessions": sessions, "annotations": annotations, "annotator_usage": usage,
    }
    write(control / "aggregate.json", aggregate)
    print(json.dumps({"valid_sessions": aggregate["valid_sessions"], "annotated": len(annotations),
                      "expected": aggregate["expected_failed_turns"], "summary": aggregate["summary"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "run", "verify", "collect"])
    parser.add_argument("--control", type=Path, default=CONTROL)
    parser.add_argument("--paper-raw", type=Path, default=ROOT / "logs/longds-classification-review-20260930/paper-raw.txt")
    parser.add_argument("--native-campaign", type=Path, help="Frozen action campaign manifest, with run/reference/input paths per job")
    parser.add_argument("--task", action="append", help="Substring filter, repeatable")
    parser.add_argument("--arm")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()
    args.control = args.control.resolve()
    if args.command == "prepare":
        prepare(args.paper_raw, args.control, args.native_campaign)
        return
    campaign = read(args.control / "campaign.json")
    if args.command == "collect":
        collect(campaign, args.control)
        return
    jobs = [j for j in campaign["jobs"] if (not args.arm or j["arm"] == args.arm)
            and (not args.task or any(t.lower() in j["task"].lower() for t in args.task))]
    if args.command == "verify":
        errors = [e for j in jobs for e in verify_inputs(Path(j["directory"]))]
        write(args.control / "integrity.json", {"checked_jobs": len(jobs), "errors": errors})
        print(json.dumps({"checked_jobs": len(jobs), "errors": errors}))
    else:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(run_job, j, args.control, args.timeout) for j in jobs]
            for future in as_completed(futures):
                future.result()


if __name__ == "__main__":
    main()
