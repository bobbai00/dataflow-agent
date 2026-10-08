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
"""Public-input isolation and frozen comparison protocol without model calls."""

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest


def module(name):
    path = Path(__file__).with_name(name + ".py")
    spec = importlib.util.spec_from_file_location("dsbench_" + name, path)
    imported = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(imported)
    return imported


runner = module("run")
smol_job = module("smol_job")


def prepared(root):
    task_id = "00000001-question1"
    inputs = root / "inputs" / task_id
    inputs.mkdir(parents=True)
    content = {"introduction.txt": "Public background", "question1.txt": "What is the sum?", "book.csv": "x\n1\n2\n"}
    for name, text in content.items():
        (inputs / name).write_text(text)
    task = {
        "task_id": task_id,
        "input_dir": f"inputs/{task_id}",
        "introduction_file": "introduction.txt",
        "question_file": "question1.txt",
        "workbook_file": "book.csv",
        "allowed_files": list(content),
        "layout": {"private_hint": "DO_NOT_INJECT_THIS"},
        "files": [
            {"name": name, "sha256": hashlib.sha256(text.encode()).hexdigest()} for name, text in content.items()
        ],
    }
    (root / "manifest.json").write_text(json.dumps({"tasks": [task]}))
    (root / "evaluation").mkdir()
    (root / "evaluation/gold.json").write_text("HIDDEN_REFERENCE")
    return task


class RunnerProtocolTests(unittest.TestCase):
    def test_statistics_switches_change_available_views(self):
        for arm, settings in runner.ARMS.items():
            self.assertEqual(
                settings["retrievalViews"], ["sample_stats", "full"] if settings["dataEvidence"] else ["sample", "full"]
            )
            self.assertEqual(settings["flowEvidence"], arm.endswith("flow1"))
        self.assertEqual(
            (
                runner.NATIVE_SETTINGS["maxOperatorResultCharLimit"],
                runner.NATIVE_SETTINGS["maxResultRows"],
                runner.NATIVE_SETTINGS["fullResultCharLimit"],
            ),
            (2000, 5, 5000),
        )
        self.assertEqual(runner.NATIVE_SETTINGS["nativeProfileScope"], "prefix")
        self.assertTrue(runner.NATIVE_SETTINGS["nativeProfileCollection"])

    def test_prompts_share_public_content_without_gold_or_layout_hints(self):
        with TemporaryDirectory() as temp:
            task = prepared(Path(temp))
            _, tasks = runner.load_tasks(Path(temp), [task["task_id"]])
            native = runner.build_prompt(tasks[0], "data1_flow1")
            smol = runner.build_prompt(tasks[0], "smol_custom")
            self.assertEqual(native.rsplit("Finish", 1)[0], smol.rsplit("Finish", 1)[0])
            self.assertIn("Public background", native)
            self.assertIn("What is the sum?", native)
            self.assertNotIn("DO_NOT_INJECT_THIS", native)
            self.assertNotIn("HIDDEN_REFERENCE", native)
            self.assertNotIn("gold", native)

    def test_changed_or_extra_inputs_are_rejected_before_agent_creation(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            task = prepared(root)
            directory = root / task["input_dir"]
            (directory / "question1.txt").write_text("Changed")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                runner.load_tasks(root, [task["task_id"]])
            (directory / "question1.txt").write_text("What is the sum?")
            (directory / "answer.txt").write_text("hidden")
            with self.assertRaisesRegex(ValueError, "Extra or missing"):
                runner.load_tasks(root, [task["task_id"]])


@unittest.skipUnless(shutil.which("bwrap"), "requires bubblewrap")
class IsolatedExecutorTests(unittest.TestCase):
    def test_stock_executor_reads_only_allowed_files_and_keeps_zero(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            task = prepared(root)
            attempt = root / "attempt"
            attempt.mkdir()
            config = {
                "task_id": task["task_id"],
                "allowed_files": task["allowed_files"],
                "input_path": str(root / task["input_dir"]),
                "settings": {"max_print_outputs_length": 5000},
            }
            executor = smol_job.isolated_executor(config, attempt, ["pandas", "os", "posixpath", "genericpath"])
            try:
                result = executor(
                    "import pandas as pd\nfinal_answer(int(pd.read_csv('data/dsbench/00000001-question1/book.csv')['x'].sum()))"
                )
                self.assertEqual((result.output, result.is_final_answer), (3, True))
                executor("import os\nassert not os.path.exists(" + repr(str(root / "evaluation/gold.json")) + ")")
                with self.assertRaisesRegex(RuntimeError, "Read-only file system"):
                    executor("open('data/dsbench/00000001-question1/book.csv', 'w')")
                self.assertEqual(executor("final_answer(0)").output, 0)
            finally:
                executor.close()
            self.assertIsNotNone(executor.proc.poll())


if __name__ == "__main__":
    unittest.main()
