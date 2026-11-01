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
"""bench setup: clones at a pinned revision (no network: local repositories) and dry runs that change nothing."""
import subprocess

import pytest

import bobbench.setup
from bobbench.setup import Setup, WEATHER


def git(*args, cwd=None):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True,
                                   env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                                        "GIT_COMMITTER_EMAIL": "t@t", "PATH": "/usr/bin:/bin:/usr/local/bin"}).strip()


@pytest.fixture
def upstream(tmp_path):
    repo = tmp_path / "upstream"
    (repo / "keep" / "deep").mkdir(parents=True)
    (repo / "skip").mkdir()
    git("init", "-q", str(repo))
    (repo / "keep" / "deep" / "prompt.py").write_text("PROMPT = 1\n")
    (repo / "skip" / "big.bin").write_text("x" * 100)
    git("add", ".", cwd=repo)
    git("commit", "-q", "-m", "one", cwd=repo)
    first = git("rev-parse", "HEAD", cwd=repo)
    (repo / "keep" / "deep" / "prompt.py").write_text("PROMPT = 2\n")
    git("commit", "-q", "-am", "two", cwd=repo)
    return repo, first


def test_a_clone_lands_on_the_pinned_revision_and_a_second_run_only_checks_it(upstream, tmp_path, capsys):
    repo, first = upstream
    target = tmp_path / "nested" / "clone"
    Setup(dry_run=False).checkout(f"file://{repo}", first, target)
    assert git("rev-parse", "HEAD", cwd=target) == first
    assert (target / "keep" / "deep" / "prompt.py").read_text() == "PROMPT = 1\n"
    setup = Setup(dry_run=False)
    setup.checkout(f"file://{repo}", first, target)
    assert setup.notes == [] and "at " + first[:7] in capsys.readouterr().out


def test_a_clone_at_another_revision_is_reported_not_changed(upstream, tmp_path):
    repo, first = upstream
    target = tmp_path / "clone"
    git("clone", "-q", f"file://{repo}", str(target))
    setup = Setup(dry_run=False)
    setup.checkout(f"file://{repo}", first, target)
    assert len(setup.notes) == 1 and git("rev-parse", "HEAD", cwd=target) != first


def test_a_sparse_clone_holds_only_what_it_names(upstream, tmp_path):
    repo, first = upstream
    target = tmp_path / "sparse"
    Setup(dry_run=False).checkout(f"file://{repo}", first, target, sparse=["/keep/deep/prompt.py"])
    assert (target / "keep" / "deep" / "prompt.py").exists() and not (target / "skip").exists()


def test_a_dry_run_runs_and_clones_nothing(upstream, tmp_path, capsys):
    repo, first = upstream
    target = tmp_path / "missing" / "clone"
    setup = Setup(dry_run=True)
    setup.checkout(f"file://{repo}", first, target)
    setup.run(["false"])  # would raise if it ran
    assert not target.parent.exists() and "[dry-run] $ git clone" in capsys.readouterr().out


@pytest.fixture
def kramabench(tmp_path, monkeypatch):
    root = tmp_path / "Kramabench"
    (root / WEATHER).parent.mkdir(parents=True)
    monkeypatch.setattr(bobbench.setup, "KB", root)
    return root


def test_the_weather_csv_links_from_another_checkout_and_copies_across_filesystems(kramabench, tmp_path, monkeypatch):
    other = tmp_path / "other"
    (other / WEATHER).parent.mkdir(parents=True)
    (other / WEATHER).write_text("rows\n")
    Setup(dry_run=False).weather(other)
    assert (kramabench / WEATHER).samefile(other / WEATHER)

    (kramabench / WEATHER).unlink()

    def another_filesystem(source, target):
        raise OSError("cross-device link")

    monkeypatch.setattr(bobbench.setup.os, "link", another_filesystem)
    Setup(dry_run=False).weather(other)
    assert (kramabench / WEATHER).read_text() == "rows\n" and not (kramabench / WEATHER).samefile(other / WEATHER)


def test_a_weather_csv_of_another_size_is_reported(kramabench):
    (kramabench / WEATHER).write_text("truncated")
    setup = Setup(dry_run=False)
    setup.weather(None)
    assert len(setup.notes) == 1 and "9 bytes" in setup.notes[0]


def test_a_failed_weather_download_is_a_note_and_setup_goes_on(kramabench, tmp_path, monkeypatch):
    monkeypatch.setattr(bobbench.setup, "ENVS", tmp_path / "envs")
    (tmp_path / "envs" / "kramabench" / ".venv" / "bin").mkdir(parents=True)
    python = tmp_path / "envs" / "kramabench" / ".venv" / "bin" / "python"
    python.write_text("#!/bin/sh\nexit 1\n")
    python.chmod(0o755)
    setup = Setup(dry_run=False)
    setup.weather(None)
    assert len(setup.notes) == 1 and "wildfire-hard-19" in setup.notes[0]
