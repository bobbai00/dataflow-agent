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
"""Infrastructure errors must stop startup before database initialization."""
from pathlib import Path
import re
import subprocess
import unittest
import tempfile


def check_compose_failure_is_not_reported_as_success():
    source = (Path(__file__).parents[1] / "main.sh").read_text()
    function = re.search(r"^infra_up\(\) \{.*?^\}", source, re.M | re.S).group()
    script = r'''
_require_host_lan_ip() { :; }
_ensure_local_warehouse_dir() { :; }
infra_state() { echo stopped; }
docker_compose_files() { :; }
_compose_s3_endpoint() { echo http://localhost:9000; }
tui_step() { :; }
tui_ok() { echo SUCCESS; }
docker() { return 7; }
DOCKER_INFRA_SERVICES=(postgres)
DOCKER_INFRA_LONGLIVED=(postgres)
''' + function + '\nif infra_up; then echo BOOTSTRAP; else echo FAILED; fi\n'
    result = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    assert result.returncode == 0
    assert result.stdout.strip() == "FAILED"


class InfrastructureStartupTests(unittest.TestCase):
    def test_compose_failure_is_not_reported_as_success(self):
        check_compose_failure_is_not_reported_as_success()

    def test_unverified_existing_jar_does_not_seed_a_clean_stamp(self):
        source = (Path(__file__).parents[1] / "main.sh").read_text()
        function = re.search(r"^svc_src_changed\(\) \{.*?^\}", source, re.M | re.S).group()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            jar = directory / "amber/target/amber-test/lib/org.apache.texera.amber-test.jar"
            jar.parent.mkdir(parents=True)
            jar.write_bytes(b"unverified prebuilt jar")
            (directory / "stamps").mkdir()
            script = '''
BUILD_STAMP_DIR=stamps
TEXERA_VERSION=test
amap_get() { echo jvm; }
svc_source_hash() { echo current-source-hash; }
''' + function + '\nif svc_src_changed texera-web; then echo REBUILD; else echo CLEAN; fi\n'
            result = subprocess.run(["bash", "-c", script], cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), "REBUILD")
            self.assertFalse((directory / "stamps/texera-web").exists())


if __name__ == "__main__":
    unittest.main()
