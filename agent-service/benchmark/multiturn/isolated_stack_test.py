# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("isolated_stack", Path(__file__).with_name("isolated_stack.py"))
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)
ROOT = Path(__file__).resolve().parents[3]

class IsolationTests(unittest.TestCase):
    def test_private_ports_containers_and_volumes(self):
        with tempfile.TemporaryDirectory() as d:
            result = stack.prepare(ROOT, Path(d), "texera-multiturn-test", 10000, 3031)
            config = json.loads((Path(d) / "compose.json").read_text())
            self.assertEqual(result["ports"]["computing-unit-master"], 18085)
            self.assertEqual(result["ports"]["agent-service"], 3031)
            self.assertEqual(result["ports"]["postgres"], 15432)
            self.assertEqual(result["ports"]["pekko"], 12552)
            self.assertNotIn("name", config["networks"]["default"])
            self.assertEqual(config["services"]["postgres"]["container_name"], "texera-multiturn-test-postgres")
            self.assertTrue(all("name" not in v for v in config["volumes"].values()))
            profile = (Path(d) / "profile.sh").read_text()
            self.assertIn("http://localhost:18085", profile)
            self.assertIn("http://localhost:19096", profile)
            self.assertIn("localhost:15432/texera_iceberg_catalog", profile)
            self.assertNotIn("OPENAI_API_KEY", profile)
            self.assertEqual((Path(d) / "infra.env").stat().st_mode & 0o777, 0o600)

    def test_every_bun_launch_uses_configured_port(self):
        launches = [line for line in (ROOT / "bin/local-dev/main.sh").read_text().splitlines() if "nohup bun run dev" in line]
        self.assertGreaterEqual(len(launches), 2)
        self.assertTrue(all('PORT="$(amap_get SVC_PORT "$svc")"' in line for line in launches))

    def test_rejects_shared_project_and_invalid_ports(self):
        with tempfile.TemporaryDirectory() as d:
            for project, offset, port in [("texera-local-dev", 10000, 3031), ("research", 0, 3031), ("research", 60000, 3031)]:
                with self.assertRaises(ValueError):
                    stack.prepare(ROOT, Path(d), project, offset, port)

if __name__ == "__main__":
    unittest.main()
