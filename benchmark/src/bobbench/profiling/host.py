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
"""The host's load during a run, every 15 s, into <run>/host-resources.jsonl (no process arguments or credentials)."""
from datetime import datetime, timezone
import json
import os
import shutil
import subprocess
import sys
import threading


class HostMonitor:
    def __init__(self, run_dir, active, interval=15):
        """`active()` returns the number of attempts in flight."""
        self.run_dir, self.active, self.interval = run_dir, active, interval
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.stopped.set()
        self.thread.join(timeout=5)

    def sample(self):
        sample = {"at": datetime.now(timezone.utc).isoformat(), "active_attempts": self.active(),
                  "load_average": list(os.getloadavg()), "logical_cpus": os.cpu_count(),
                  "artifact_disk_free_bytes": shutil.disk_usage(self.run_dir).free}
        try:
            import psutil
        except ImportError:
            psutil = None
        if psutil:
            try:
                memory = psutil.virtual_memory()
                sample.update(memory_total_bytes=memory.total, memory_available_bytes=memory.available,
                              memory_percent_used=memory.percent)
                sample["swap_used_bytes"] = psutil.swap_memory().used
            except (OSError, PermissionError):
                sample["memory_metrics_restricted"] = True
        if sys.platform == "darwin":
            try:
                pressure = subprocess.check_output(["/usr/bin/memory_pressure", "-Q"], text=True, timeout=3)
                line = next(line for line in pressure.splitlines() if "System-wide memory free percentage:" in line)
                sample["mac_memory_free_percent"] = int(line.split(":")[-1].strip().rstrip("%"))
            except (OSError, ValueError, StopIteration, subprocess.SubprocessError):
                sample["mac_memory_free_percent"] = None
        return sample

    def _loop(self):
        while True:
            with (self.run_dir / "host-resources.jsonl").open("a") as stream:
                stream.write(json.dumps(self.sample()) + "\n")
            if self.stopped.wait(self.interval):
                return
