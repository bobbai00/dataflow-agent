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
"""What code, configuration and data a run used: revisions, source digests and the agent listener's source."""
import hashlib
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit


def git(repository, *command):
    return subprocess.check_output(["git", "-C", str(repository), *command], text=True).strip()


def revision(repository):
    """HEAD, marked `+dirty` when the working tree has changes the commit does not hold."""
    return git(repository, "rev-parse", "HEAD") + ("+dirty" if git(repository, "status", "--porcelain") else "")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def source_snapshot(repository, paths):
    """Every tracked or untracked (not ignored) file under `paths`: its sha256, and one digest over all of them."""
    names = sorted(set(git(repository, "ls-files", "-co", "--exclude-standard", "--", *paths).splitlines()))
    whole, files = hashlib.sha256(), []
    for name in names:
        source = Path(repository) / name
        if source.is_file():
            data = source.read_bytes()
            whole.update(name.encode() + b"\0" + data + b"\0")
            files.append({"path": name, "sha256": hashlib.sha256(data).hexdigest()})
    return whole.hexdigest(), files


def diff_sha256(repository, paths):
    """sha256 of the working tree's diff against HEAD under `paths` (the empty diff's digest when clean)."""
    return hashlib.sha256(subprocess.check_output(["git", "-C", str(repository), "diff", "--no-ext-diff", "--", *paths])
                          ).hexdigest()


def inspect_listener(endpoint, *, proc_root=Path("/proc"), run=subprocess.run):
    """The on-disk source of the agent service listening at a local `endpoint`: its checkout, HEAD and whether
    agent-service/ has uncommitted changes. This resolves the listener's entry point; it does not prove which revision
    a long-running process loaded (loaded_revision_verified stays False). No environment or command line is kept."""
    unknown = {"status": "unavailable", "reason": "unsupported_endpoint", "git_sha": None, "source_dirty": None,
               "loaded_revision_verified": False}
    try:
        url = urlsplit(endpoint)
        if (url.scheme not in {"http", "https"} or url.hostname not in {"localhost", "127.0.0.1", "::1"} or not url.port
                or url.username or url.password or url.query or url.fragment or url.path not in {"", "/"}):
            return unknown

        def command(args):
            result = run(args, capture_output=True, text=True, timeout=5)
            if result.returncode:
                raise RuntimeError("command_failed")
            return result.stdout.strip()

        pids = {int(pid) for pid in re.findall(r"\bpid=(\d+)", command(["ss", "-H", "-ltnp", "sport", "=", f":{url.port}"]))}
        if len(pids) != 1:
            return {**unknown, "reason": "no_unique_listener"}
        pid = pids.pop()
        process = Path(proc_root) / str(pid)

        def start_ticks():
            # comm may hold spaces or parentheses; the fields after its last ')' are fixed (starttime is the 20th).
            return int((process / "stat").read_text().rpartition(")")[2].split()[19])

        before = start_ticks()
        cwd = (process / "cwd").resolve(strict=True)
        entries = []
        for raw in (process / "cmdline").read_bytes().split(b"\0"):
            arg = raw.decode("utf-8", errors="replace")
            if arg == "src/server.ts" or arg.endswith("/src/server.ts"):
                path = Path(arg)
                entries.append((path if path.is_absolute() else cwd / path).resolve(strict=True))
        if len(entries) != 1:
            return {**unknown, "reason": "not_an_agent_entry_point"}
        entry = entries[0]
        root = Path(command(["git", "-C", str(entry.parent), "rev-parse", "--show-toplevel"])).resolve(strict=True)
        if entry != root / "agent-service" / "src" / "server.ts":
            return {**unknown, "reason": "entry_point_outside_agent_source"}
        sha = command(["git", "-C", str(root), "rev-parse", "HEAD"])
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            return {**unknown, "reason": "invalid_source_revision"}
        dirty = bool(command(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=normal", "--",
                              "agent-service/src", "agent-service/package.json", "agent-service/yarn.lock",
                              "agent-service/bun.lock", "agent-service/bun.lockb"]))
        digest = hashlib.sha256(entry.read_bytes()).hexdigest()
        if start_ticks() != before:
            return {**unknown, "reason": "process_changed"}
        return {"status": "resolved", "reason": None, "pid": pid, "process_start_ticks": before, "source_root": str(root),
                "entry_point": str(entry), "entry_sha256": digest, "git_sha": sha, "source_dirty": dirty,
                "loaded_revision_verified": False}
    except Exception:  # noqa: BLE001 - provenance is best effort and never fails an attempt
        return {**unknown, "reason": "resolution_failed"}
