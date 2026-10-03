#!/usr/bin/env python3
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

"""Filesystem isolation for local LongDS execution, using an empty mount root.

Only interpreter/runtime files, read-only source data and explicitly selected
scratch paths are mounted. Benchmark questions, reference code, gold answers,
previous runs, credentials and the repository are not mounted. The judge and
runner remain outside. Native workers additionally require the engine's result
warehouse and local network services; this is not a general hostile-code sandbox.
"""
from functools import lru_cache
import json
from pathlib import Path
import shutil
import subprocess


@lru_cache(maxsize=8)
def _python_roots(python):
    result = subprocess.run(
        [str(python), "-c", "import json,sys; print(json.dumps([sys.prefix,sys.base_prefix]))"],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def isolated_command(command, *, python, data_roots, workspace,
                     read_only=(), read_write=(), cwd="/workspace", network=False, environment=None):
    """Build argv, never a shell string. Explicit mounts are trusted harness input.

    A Jupyter `{connection_file}` placeholder may be used in explicit mounts;
    KernelManager expands it before launch. No unrestricted fallback is allowed.
    """
    bwrap = shutil.which("bwrap")
    if not bwrap:
        raise RuntimeError("LongDS execution requires bubblewrap (bwrap); refusing unrestricted execution")
    # env -i also works with older bubblewrap releases lacking --clearenv.
    argv = ["/usr/bin/env", "-i", bwrap, "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc",
            "--unshare-uts", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    if not network:
        argv += ["--unshare-net"]
    mounted = set()

    def mount(source, destination, writable=False):
        pair = (str(source), str(destination))
        if pair in mounted:
            return
        argv.extend(["--bind" if writable else "--ro-bind", *pair])
        mounted.add(pair)

    for path in ["/usr", "/bin", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/localtime",
                 "/etc/ssl", "/etc/fonts", "/etc/nsswitch.conf", "/etc/resolv.conf",
                 "/etc/hosts", "/etc/passwd", "/etc/group", "/sys/devices/system/cpu"]:
        if Path(path).exists():
            mount(path, path)
    for path in _python_roots(str(python)):
        if path not in ("/usr", "/usr/local"):
            mount(Path(path).resolve(), path)
    for root in data_roots:
        mount(Path(root).resolve(), str(Path(root).absolute()))
    mount(Path(workspace).resolve(), "/workspace", writable=True)
    for source, destination in read_only:
        mount(source, destination)
    for source, destination in read_write:
        mount(source, destination, writable=True)
    values = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
              "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1",
              "IPYTHONDIR": "/workspace/.ipython", "MPLCONFIGDIR": "/workspace/.matplotlib",
              "XDG_CACHE_HOME": "/workspace/.cache", "OPENBLAS_NUM_THREADS": "1",
              "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
    values.update(environment or {})
    for key, value in values.items():
        argv += ["--setenv", key, str(value)]
    argv += ["--dir", str(cwd), "--chdir", str(cwd), "--", *map(str, command)]
    return argv
