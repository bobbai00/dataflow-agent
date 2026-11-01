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
"""bench setup: what a fresh clone needs to run the paper's benchmarks, step by step and idempotent.

- every benchmark: the KramaBench submodule at the pinned commit; the runners' venv (envs/kramabench) and Script
  ReAct's locked interpreter (envs/scriptreact); the checkout's .venv (uv sync --all-extras) with the exact packages
  the paper's engine ran the model's code on (envs/engine/requirements.txt); the engine's Python protos.
- kramabench: KramaBench's data, whose one untracked input (wildfire's WeatherEvents_Jan2016-Dec2022.csv, 1.0 GB)
  comes from Kaggle (sobhanmoosavi/us-weather-events) or --copy-from. The tracked data/wildfire/input/ZHVI.csv is 0
  bytes in every paper run: leave it so.
- prepbench: TsinghuaDatabaseGroup/prepbench at 993a313 in $PREPBENCH_REPO (default ~/datasets/prepbench), staged as
  the KramaBench workload `prepbench` (data/prepbench/input/case_NNN/; the workload and format-hint files it writes
  must equal the committed ones).
- longds: zjunlp/DataMind at 4b49ef0 (only the judge prompt, sparse) in $LONGDS_DATAMIND (default
  benchmark/longds/DataMind), the 24 LongDS v1.1 Lite sessions' tasks and data from the Hugging Face dataset
  zjunlp/LongDS at bf41bb2 (~9.5 GB; nothing else), a copy of each session's data in the KramaBench data tree (the
  engine sandbox mounts only that tree), and the prepared sessions (bench longds prepare) in --prepared.

--dry-run reports what is there and what would be fetched or built, and changes nothing.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from bobbench.paths import BENCHMARK, DATAMIND, ENVS, KB, LONGDS_PREPARED, PACKAGE, PREPBENCH_REPO, REPO
from bobbench.kramabench.tasks import WORKLOADS

PREPBENCH = ("https://github.com/TsinghuaDatabaseGroup/prepbench.git", "993a3139da932e144d588f7b775d092827fc89c8")
DATAMIND_GIT = ("https://github.com/zjunlp/DataMind.git", "4b49ef052500c73b07b5a4955e1115da6cd9da16")
LONGDS_HF = ("zjunlp/LongDS", "bf41bb28474fa9540d98922a6f5e6310ed014e51")
WEATHER = "data/wildfire/input/WeatherEvents_Jan2016-Dec2022.csv"
WEATHER_BYTES = 1_085_964_816
# Tables a 2026-09-23 run left in netflix task3's data folder, there in every paper run. Its requests list them and
# LongDS does not ship them, so they are kept in the harness.
NETFLIX_TASK3_EXTRA = "business/netflix_movies_and_tv_shows/task3/data/working_tables"
WORKING_TABLES = PACKAGE / "longds" / "data" / "netflix_task3_working_tables"


def pinned(requirements):
    """The name==version lines of a requirements file."""
    return {line.strip() for line in requirements.read_text().splitlines() if line.strip() and line[0] != "#"}


def installed(python):
    """The name==version lines of what an interpreter holds, without the checkout's own editable install."""
    frozen = subprocess.check_output(["uv", "pip", "freeze", "--python", str(python)], text=True,
                                     stderr=subprocess.DEVNULL)
    return {line for line in frozen.splitlines() if line and not line.startswith("-e ")}


def short(lines):
    """A few of many packages, for a message."""
    lines = sorted(lines)
    return ", ".join(lines[:6]) + (f" and {len(lines) - 6} more" if len(lines) > 6 else "")


class Setup:
    def __init__(self, dry_run):
        self.dry_run, self.notes, self.base_done = dry_run, [], False

    def say(self, message):
        print(("[dry-run] " if self.dry_run else "") + message, flush=True)

    def run(self, command, **options):
        self.say("$ " + " ".join(str(part) for part in command))
        if not self.dry_run:
            subprocess.run([str(part) for part in command], check=True, **options)

    def note(self, message):
        self.notes.append(message)
        print("NOTE: " + message, flush=True)

    # KramaBench ------------------------------------------------------------------------------------------------------

    def submodule(self):
        pinned = subprocess.check_output(["git", "-C", str(REPO), "ls-tree", "HEAD", "benchmark/Kramabench"],
                                         text=True).split()[2]
        if not (KB / ".git").exists():
            self.run(["git", "-C", REPO, "submodule", "update", "--init", "benchmark/Kramabench"])
            return
        actual = subprocess.check_output(["git", "-C", str(KB), "rev-parse", "HEAD"], text=True).strip()
        if actual == pinned:
            self.say(f"KramaBench at the pinned {pinned[:9]}")
        else:
            self.note(f"KramaBench is at {actual[:9]}, the repository pins {pinned[:9]}: "
                      "git submodule update benchmark/Kramabench")

    def venv(self, name):
        python = ENVS / name / ".venv" / "bin" / "python"
        if not python.exists():
            self.run(["bash", ENVS / name / "setup.sh"])
            return
        different = pinned(ENVS / name / "requirements.txt") ^ installed(python)
        if different:
            self.note(f"envs/{name}/.venv differs from its requirements.txt: {short(different)}")
        else:
            self.say(f"envs/{name}/.venv holds exactly its requirements.txt")

    def engine(self):
        """The checkout's .venv with the paper's engine packages, and the Python protos its workers import."""
        python = REPO / ".venv" / "bin" / "python"
        if not python.exists():
            self.run(["uv", "sync", "--all-extras"], cwd=REPO)
        if python.exists():
            have, want = installed(python), pinned(ENVS / "engine" / "requirements.txt")
            if want - have:
                self.say(f"{len(want - have)} packages of envs/engine/requirements.txt are not in .venv")
                self.run(["uv", "pip", "install", "--no-deps", "--python", python, *sorted(want - have)])
                have = installed(python) if not self.dry_run else want
            if have == want:
                self.say(".venv holds exactly the paper's engine packages")
            else:
                self.note(f"the paper's engine did not have these .venv packages: {short(have - want)}")
        else:
            self.say("then the packages of envs/engine/requirements.txt that uv's lock lacks")
        if not (REPO / "amber" / "src" / "main" / "python" / "proto").is_dir():
            self.run(["bash", REPO / "bin" / "python-proto-gen.sh"],
                     env={**os.environ, "PATH": f"{REPO / '.venv' / 'bin'}{os.pathsep}{os.environ['PATH']}"})

    def base(self):
        """What every benchmark needs; once per call."""
        if self.base_done:
            return
        self.base_done = True
        if not shutil.which("uv"):
            raise SystemExit("bench setup needs uv (https://docs.astral.sh/uv/)")
        self.submodule()
        self.venv("kramabench")
        self.venv("scriptreact")
        self.engine()

    def weather(self, copy_from):
        target = KB / WEATHER
        if target.exists():
            size = target.stat().st_size
            self.say(f"{WEATHER} present ({size // 2**20} MB)")
            if size != WEATHER_BYTES:
                self.note(f"{WEATHER} is {size} bytes; the paper's runs read {WEATHER_BYTES}")
            return
        if copy_from:
            source = Path(copy_from)
            source = source / WEATHER if source.is_dir() else source
            self.say(f"link or copy {source} -> {target}")
            if not self.dry_run:
                try:
                    os.link(source, target)
                except OSError:  # another filesystem
                    shutil.copy2(source, target)
            return
        script = ("import kagglehub, pathlib, shutil, sys; p = pathlib.Path(kagglehub.dataset_download("
                  "'sobhanmoosavi/us-weather-events')); csvs = list(p.rglob('WeatherEvents_*.csv')); "
                  "shutil.copy2(csvs[0], sys.argv[1])")
        try:
            self.run([ENVS / "kramabench" / ".venv" / "bin" / "python", "-c", script, target])
        except subprocess.CalledProcessError:
            self.note(f"could not download {WEATHER} from Kaggle (if it asks for a login: a token in "
                      "~/.kaggle/access_token, or --copy-from <a KramaBench checkout>). Only wildfire-hard-19 needs it.")

    def check_sources(self):
        """Report data sources that do not resolve by their exact name (globs allowed). Upstream's own warts: legal's
        "State MSA ... Data" folders differ from the files by a letter's case, and the prompts' fuzzy search finds them;
        wildfire-hard-19 needs WeatherEvents (above)."""
        import glob
        for workload in WORKLOADS:
            folder = KB / "data" / workload / "input"
            tasks = json.loads((KB / "workload" / f"{workload}.json").read_text())
            missing = [f"{t['id']}: {source}" for t in tasks for source in t.get("data_sources") or []
                       if not (glob.glob(str(folder / source)) or (folder / source).exists())]
            self.say(f"{workload}: {'all data sources resolve' if not missing else f'{len(missing)} not found by their exact name'}")
            for line in missing[:5]:
                print("       " + line)

    def kramabench(self, copy_from):
        self.base()
        if (KB / ".git").exists():
            self.weather(copy_from)
            self.check_sources()

    # PrepBench -------------------------------------------------------------------------------------------------------

    def checkout(self, url, revision, folder, sparse=None):
        """A clone of `url` at `revision` in `folder` (only `sparse` paths when given); an existing clone is checked."""
        if (folder / ".git").exists():
            actual = subprocess.check_output(["git", "-C", str(folder), "rev-parse", "HEAD"], text=True).strip()
            if actual == revision:
                self.say(f"{folder} at {revision[:7]}")
            else:
                self.note(f"{folder} is at {actual[:7]}, the paper's runs used {revision[:7]}")
            return
        if not self.dry_run:
            folder.parent.mkdir(parents=True, exist_ok=True)
        if sparse:
            self.run(["git", "clone", "--filter=blob:none", "--no-checkout", url, folder])
            self.run(["git", "-C", folder, "sparse-checkout", "set", "--no-cone", *sparse])
        else:
            self.run(["git", "clone", url, folder])
        self.run(["git", "-C", folder, "checkout", "--quiet", "--detach", revision])

    def prepbench(self, datasets):
        self.base()
        repo = Path(datasets) / "prepbench" if datasets else PREPBENCH_REPO
        self.checkout(*PREPBENCH, repo)
        os.environ["PREPBENCH_REPO"] = str(repo)
        self.run([sys.executable, "-m", "bobbench.prepbench.build_workload", repo],
                 env={**os.environ, "PYTHONPATH": str(BENCHMARK / "src")})
        if not self.dry_run:
            changed = subprocess.run(["git", "-C", str(KB), "diff", "--quiet", "--", "workload/prepbench.json",
                                      "format_hint/prepbench.json"]).returncode
            changed |= subprocess.run(["git", "-C", str(REPO), "diff", "--quiet", "--",
                                       "benchmark/src/bobbench/prepbench/data"]).returncode
            if changed:
                self.note("the PrepBench build differs from the committed workload or hints (see git diff)")
            else:
                self.say("PrepBench workload, hints and case index equal the committed ones")
        if not datasets and str(repo) != str(Path("~/datasets/prepbench").expanduser()):
            self.say(f"PREPBENCH_REPO={repo}")

    # LongDS ----------------------------------------------------------------------------------------------------------

    def longds(self, prepared, only=None):
        self.base()
        datamind = DATAMIND
        self.checkout(*DATAMIND_GIT, datamind, sparse=["/longds/runners/DSGym/scripts/prompt.py", "/longds/README.md"])
        dataset = datamind / "longds" / "dataset"
        python = ENVS / "kramabench" / ".venv" / "bin" / "python"  # holds huggingface_hub
        listing = dataset / "task" / "longds_v1.1" / "task_list_lite.json"
        download = ("import json, sys; from huggingface_hub import snapshot_download; "
                    "snapshot_download(sys.argv[1], repo_type='dataset', revision=sys.argv[2], local_dir=sys.argv[3], "
                    "allow_patterns=json.loads(sys.argv[4]))")
        if not listing.exists():
            self.run([python, "-c", download, *LONGDS_HF, dataset, json.dumps(["task/longds_v1.1/task_list_lite.json"])])
        if not listing.exists():
            self.say(f"would then fetch the 24 Lite sessions' task/ and data/ files from {LONGDS_HF[0]}@{LONGDS_HF[1][:7]}")
            return
        sessions = [f"{e['task_domain']}/{e['dataset_name']}/{e['task_id']}" for e in json.loads(listing.read_text())]
        if only:
            unknown = sorted(set(only) - set(sessions))
            if unknown:
                raise SystemExit(f"not LongDS Lite sessions: {', '.join(unknown)}")
            sessions = list(only)
        patterns = [p for s in sessions for p in (f"task/longds_v1.1/{s}/*", f"data/longds/{s}/data/*", f"data/longds/{s}/data/**")]
        missing = [s for s in sessions if not (dataset / "data" / "longds" / s / "data").is_dir()]
        if missing:
            self.run([python, "-c", download, *LONGDS_HF, dataset, json.dumps(patterns)])
        else:
            self.say(f"the {len(sessions)} Lite sessions' data are in {dataset}")
        extra = dataset / "data" / "longds" / NETFLIX_TASK3_EXTRA
        if NETFLIX_TASK3_EXTRA.rsplit("/data/", 1)[0] in sessions and not extra.exists():
            self.say(f"copy {WORKING_TABLES} -> {extra}")
            if not self.dry_run:
                shutil.copytree(WORKING_TABLES, extra)
        engine = KB / "data" / "longds"
        for session in sessions:
            source, target = dataset / "data" / "longds" / session / "data", engine / session / "data"
            if target.is_dir():
                continue
            self.say(f"copy {source} -> {target} (hard links where possible)")
            if not self.dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                if subprocess.run(["cp", "-al", str(source), str(target)], capture_output=True).returncode:
                    shutil.copytree(source, target)
        self.run([sys.executable, "-m", "bobbench.longds.prepare", "--out", prepared, *(only or ["lite"])],
                 env={**os.environ, "PYTHONPATH": str(BENCHMARK / "src")}, cwd=REPO)


def main():
    parser = argparse.ArgumentParser(prog="bench setup", description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter,
                                     epilog=__doc__.split("\n\n", 1)[1])
    parser.add_argument("what", nargs="?", default="all", choices=["kramabench", "prepbench", "longds", "all"])
    parser.add_argument("--datasets", type=Path, help="parent folder of the PrepBench checkout (default: ~/datasets, "
                        "or $PREPBENCH_REPO)")
    parser.add_argument("--prepared", type=Path, default=LONGDS_PREPARED, help="where the prepared LongDS sessions go")
    parser.add_argument("--copy-from", type=Path, help="a KramaBench checkout (or the csv itself) to copy wildfire's "
                        "WeatherEvents csv from instead of downloading it")
    parser.add_argument("--sessions", nargs="+", metavar="DOMAIN/DATASET/TASK", help="longds: only these Lite sessions")
    parser.add_argument("--dry-run", action="store_true", help="report what would be done; change nothing")
    args = parser.parse_args()
    args.prepared = args.prepared.resolve()  # the prepare step runs from the repository root
    setup = Setup(args.dry_run)
    if args.what in ("kramabench", "all"):
        setup.kramabench(args.copy_from)
    if args.what in ("prepbench", "all"):
        setup.prepbench(args.datasets)
    if args.what in ("longds", "all"):
        setup.longds(args.prepared, args.sessions)
    print(f"setup {args.what}: done" + (f", {len(setup.notes)} note(s) above" if setup.notes else ""))


if __name__ == "__main__":
    main()
