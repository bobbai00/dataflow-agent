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
"""DSBench's official analysis judge, with private traces and a request cache.

The prompt, model, sampling parameters, True-substring rule and exception-to-
False rule come from the pinned upstream evaluator. The wrapper freezes zero
SDK retries and a 90-second request timeout. Completed failures are cached too.
Do not put the input rows, cache or outputs in an agent's input directory.

    python benchmark/dsbench/judge.py --input rows.jsonl --output grades.jsonl \
        --cache-dir /var/tmp/dsbench/evaluation/judge-cache

Input JSONL: {task_id, arm, question, answer, prediction}. Output retains task_id
and arm, adds the official verdict and diagnostics, and writes a companion
<output>.summary.json. Identical requests across waves or arms are judged once.

The official prompt is adapted from DSBench, MIT License, Copyright (c) 2024
Liqiang Jing. Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom
the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
SOURCE_REVISION = "ba786096137a5108af11c016ad3f09cdb97beefd"
SOURCE_URL = f"https://github.com/LiqiangJing/DSBench/blob/{SOURCE_REVISION}/data_analysis/compute_answer.py"
JUDGE_MODEL = "gpt-4o-2024-05-13"
MAX_RETRIES = 0
REQUEST_TIMEOUT = 90.0
PRICING = {
    "kind": "token_estimate",
    "model": JUDGE_MODEL,
    "currency": "USD",
    "unit": "per_token",
    "rates": {"input": 5e-6, "output": 15e-6, "cache_read": None},
    "source": "https://developers.openai.com/api/docs/pricing.md",
    "table": "Standard text tokens",
    "verified_on": "2026-10-08",
    "input_includes_cached": True,
    "output_includes_reasoning": True,
    "cached_discount_applied": False,
}


def official_request(question, answer, prediction):
    """Exact request from evaluate_prediction, including its spelling and spaces."""
    prompt = (
        f"Please judge whether the generated answer is right or wrong. We require that the correct answer "
        f"to the prediction gives a clear answer, not just a calculation process or a disassembly of ideas. "
        f"The question is {question}. The true answer is \n {answer}. \n The predicted answer is \n {prediction}.\n "
        f"If the predicted answer is right, please output True. Otherwise output Flase. "
        f"Don't output any other text content. You only can output True or False."
    )
    return {
        "model": JUDGE_MODEL,
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        "temperature": 0,
        "max_tokens": 256,
        "top_p": 1,
        "frequency_penalty": 0,
        "presence_penalty": 0,
    }


def cache_key(request):
    identity = {
        "source_revision": SOURCE_REVISION,
        "max_retries": MAX_RETRIES,
        "request_timeout_seconds": REQUEST_TIMEOUT,
        "request": request,
    }
    return hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def _save(path, data):
    """Atomic private JSON: judge records contain the reference answer."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(data, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    temporary.replace(path)


def _append_trace(directory, event):
    with os.fdopen(os.open(directory / "trace.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(
            json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(), **event}, ensure_ascii=False) + "\n"
        )


def _public_endpoint(endpoint):
    url = urlsplit(str(endpoint))
    if not url.hostname:
        return "provided-client"
    host = f"[{url.hostname}]" if ":" in url.hostname else url.hostname
    return urlunsplit((url.scheme, host + (f":{url.port}" if url.port else ""), url.path.rstrip("/"), "", ""))


def load_environment():
    """Existing environment wins; never execute shell syntax from the env file."""
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.removeprefix("export ").strip()
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def create_judge_client(endpoint=None):
    """Read-only inventory check; never replace the official model with an alias."""
    from openai import OpenAI

    load_environment()
    candidates = (
        [endpoint]
        if endpoint
        else [
            os.environ.get("JUDGE_BASE_URL"),
            os.environ.get("LITELLM_BASE_URL"),
            "http://localhost:18000/v1",
            "http://localhost:4000/v1",
        ]
    )
    checked = []
    for base in dict.fromkeys(candidates):
        if not base:
            continue
        base = base.rstrip("/")
        if urlsplit(base).hostname == "api.openai.com":
            break
        key = (
            os.environ.get("JUDGE_API_KEY")
            if base == os.environ.get("JUDGE_BASE_URL") or endpoint
            else os.environ.get("CODE_AGENT_API_KEY") or os.environ.get("LITELLM_MASTER_KEY")
        )
        if not key:
            continue
        request = Request(base + "/models", headers={"Authorization": "Bearer " + key})
        try:
            with urlopen(request, timeout=5) as response:
                inventory = json.load(response)
            available = JUDGE_MODEL in {row.get("id") for row in inventory.get("data", [])}
            checked.append({"endpoint": _public_endpoint(base), "exact_snapshot_listed": available})
            if available:
                return OpenAI(api_key=key, base_url=base, max_retries=MAX_RETRIES, timeout=REQUEST_TIMEOUT), {
                    "endpoint": _public_endpoint(base),
                    "verified_model": JUDGE_MODEL,
                    "verification": "GET /models",
                    "inventory_checks": checked,
                }
        except Exception as error:
            checked.append({"endpoint": _public_endpoint(base), "inventory_error": type(error).__name__})
    if endpoint and urlsplit(endpoint).hostname != "api.openai.com":
        raise RuntimeError("The requested endpoint does not advertise the exact official judge snapshot")
    key = os.environ.get("OPENAI_API_KEY")
    if not key or key == "dummy":
        raise RuntimeError("No gateway offers the official snapshot and OPENAI_API_KEY is missing")
    client = OpenAI(api_key=key, base_url="https://api.openai.com/v1", max_retries=MAX_RETRIES, timeout=REQUEST_TIMEOUT)
    try:
        model = client.models.retrieve(JUDGE_MODEL)
        if model.id != JUDGE_MODEL:
            raise RuntimeError("Model inventory returned a different snapshot")
    except Exception:
        client.close()
        raise RuntimeError("Direct OpenAI read-only verification of the official snapshot failed") from None
    return client, {
        "endpoint": "https://api.openai.com/v1",
        "verified_model": model.id,
        "verification": f"GET /models/{JUDGE_MODEL}",
        "inventory_checks": checked,
    }


def _usage(response):
    raw = getattr(response, "usage", None)
    usage = raw.model_dump() if raw is not None and hasattr(raw, "model_dump") else raw
    usage = usage if isinstance(usage, dict) else None
    return {
        "provider_usage": usage,
        "input_tokens": usage.get("prompt_tokens") if usage else None,
        "output_tokens": usage.get("completion_tokens") if usage else None,
        "cached_tokens": ((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0) if usage else None,
        "reasoning_tokens": (
            ((usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0) if usage else None
        ),
    }


def judge_prediction(question, answer, prediction, *, cache_dir, client=None, endpoint=None):
    """Return the recorded official verdict, including False after judge errors.

    ``original_estimated_cost_usd`` preserves the original provider estimate;
    ``incremental_cost_usd`` is zero on a cache hit, and unknown when usage is
    unavailable. Cross-process locking also deduplicates concurrent requests.
    """
    request = official_request(question, answer, prediction)
    key = cache_key(request)
    directory = Path(cache_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    saved, pending = directory / f"{key}.json", directory / f"{key}.pending.json"
    with os.fdopen(os.open(directory / f"{key}.lock", os.O_CREAT | os.O_RDWR, 0o600), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if saved.exists():
            record = json.loads(saved.read_text())
            if record["cache_key"] != key or record["request"] != request:
                raise ValueError("Judge cache request does not match its key")
            _append_trace(directory, {"phase": "cache_hit", "cache_key": key})
            return {**record, "cache_hit": True, "incremental_cost_usd": 0.0, "incremental_model_calls": 0}
        if pending.exists():
            # A killed process may already have spent tokens. Never resend an
            # interrupted request automatically or turn it into a free call.
            record = json.loads(pending.read_text())
            record.update(
                {
                    "judgment": "False",
                    "official_correct": False,
                    "error": {"type": "InterruptedJudgeRequest"},
                    "seconds": None,
                    "provider_usage": None,
                    "input_tokens": None,
                    "output_tokens": None,
                    "cached_tokens": None,
                    "reasoning_tokens": None,
                    "original_estimated_cost_usd": None,
                    "incremental_cost_usd": 0.0,
                    "incremental_model_calls": 0,
                    "cache_hit": True,
                    "response": None,
                }
            )
            _save(saved, record)
            pending.unlink()
            _append_trace(directory, {"phase": "interrupted", "cache_key": key, "error": record["error"]})
            return record
        owned_client = client is None
        if owned_client:
            client, routing = create_judge_client(endpoint)
            endpoint = routing["endpoint"]
        record = {
            "cache_key": key,
            "cache_hit": False,
            "request": request,
            "model": JUDGE_MODEL,
            "source_revision": SOURCE_REVISION,
            "source_url": SOURCE_URL,
            "endpoint": _public_endpoint(endpoint or getattr(client, "base_url", "provided-client")),
            "max_retries": MAX_RETRIES,
            "request_timeout_seconds": REQUEST_TIMEOUT,
            "pricing": PRICING,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "incremental_model_calls": 1,
        }
        try:
            record["sdk_version"] = importlib.metadata.version("openai")
        except importlib.metadata.PackageNotFoundError:
            record["sdk_version"] = None
        _save(pending, record)
        _append_trace(
            directory,
            {
                "phase": "request",
                "cache_key": key,
                "request": request,
                "endpoint": record["endpoint"],
                "max_retries": MAX_RETRIES,
            },
        )
        started, response = time.monotonic(), None
        try:
            response = client.with_options(max_retries=MAX_RETRIES, timeout=REQUEST_TIMEOUT).chat.completions.create(
                **request
            )
            judgment = response.choices[0].message.content
            official_correct = "true" in judgment.lower()
            error = None
        except Exception as exception:
            judgment, official_correct = "False", False
            # Provider errors can echo credential fragments; retain safe fields
            # rather than the raw exception message or authentication headers.
            error = {"type": type(exception).__name__, "status_code": getattr(exception, "status_code", None)}
        finally:
            if owned_client:
                client.close()
        record.update(
            {
                "judgment": judgment,
                "official_correct": official_correct,
                "error": error,
                "seconds": time.monotonic() - started,
                **_usage(response),
                "response": response.model_dump() if response is not None else None,
                "request_id": getattr(response, "_request_id", None),
                "response_model": getattr(response, "model", None),
                "model_mismatch": response is not None and getattr(response, "model", None) != JUDGE_MODEL,
            }
        )
        cost = (
            None
            if record["input_tokens"] is None or record["output_tokens"] is None
            else (
                record["input_tokens"] * PRICING["rates"]["input"]
                + record["output_tokens"] * PRICING["rates"]["output"]
            )
        )
        record.update({"original_estimated_cost_usd": cost, "incremental_cost_usd": cost})
        _save(saved, record)
        pending.unlink()
        _append_trace(
            directory,
            {
                "phase": "error" if error else "response",
                "cache_key": key,
                "seconds": record["seconds"],
                "judgment": judgment,
                "error": error,
                "provider_usage": record["provider_usage"],
                "estimated_cost_usd": cost,
                "response_model": record["response_model"],
                "model_mismatch": record["model_mismatch"],
            },
        )
        return record


def summarize(rows):
    return {
        "predictions": len(rows),
        "official_correct": sum(row["official_correct"] for row in rows),
        "judge_failures": sum(row["error"] is not None for row in rows),
        "model_mismatches": sum(bool(row.get("model_mismatch")) for row in rows),
        "cache_hits": sum(row["cache_hit"] for row in rows),
        "incremental_model_calls": sum(row["incremental_model_calls"] for row in rows),
        "unique_judge_requests": len({row["cache_key"] for row in rows}),
        "known_incremental_cost_usd": sum(row["incremental_cost_usd"] or 0.0 for row in rows),
        "unpriced_incremental_calls": sum(
            row["incremental_model_calls"] and row["incremental_cost_usd"] is None for row in rows
        ),
        "model": JUDGE_MODEL,
        "source_revision": SOURCE_REVISION,
        "pricing": PRICING,
        "max_retries": MAX_RETRIES,
        "request_timeout_seconds": REQUEST_TIMEOUT,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--input", type=Path, required=True, help="Private JSONL rows with question, answer and prediction"
    )
    parser.add_argument(
        "--output", type=Path, required=True, help="Private grades JSONL; safely rebuildable from cache"
    )
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--endpoint", help="OpenAI-compatible endpoint offering the exact official snapshot")
    args = parser.parse_args()
    inputs = [json.loads(line) for line in args.input.read_text().splitlines() if line.strip()]
    for row in inputs:
        if not {"task_id", "arm", "question", "answer", "prediction"} <= row.keys():
            parser.error("Every input row needs task_id, arm, question, answer and prediction")
    rows, client, routing = [], None, None
    try:
        for row in inputs:
            key = cache_key(official_request(row["question"], row["answer"], row["prediction"]))
            if client is None and not any(
                (args.cache_dir / f"{key}{suffix}").exists() for suffix in (".json", ".pending.json")
            ):
                client, routing = create_judge_client(args.endpoint)
            result = judge_prediction(
                row["question"],
                row["answer"],
                row["prediction"],
                cache_dir=args.cache_dir,
                client=client,
                endpoint=routing["endpoint"] if routing else args.endpoint,
            )
            rows.append({"task_id": row["task_id"], "arm": row["arm"], **result})
            # Save after each row, so an interrupted wave retains completed grades.
            args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=args.output.parent, delete=False
            ) as stream:
                temporary = Path(stream.name)
                stream.write("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in rows))
            temporary.replace(args.output)
            summary = {**summarize(rows), "routing": routing}
            _save(Path(str(args.output) + ".summary.json"), summary)
            print(
                json.dumps(
                    {
                        "task_id": row["task_id"],
                        "arm": row["arm"],
                        "official_correct": result["official_correct"],
                        "judge_error": result["error"],
                        "cache_hit": result["cache_hit"],
                        "incremental_cost_usd": result["incremental_cost_usd"],
                    }
                ),
                flush=True,
            )
    finally:
        if client is not None:
            client.close()


if __name__ == "__main__":
    main()
