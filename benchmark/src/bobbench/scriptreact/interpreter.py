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
"""Script ReAct runs on one locked interpreter: envs/scriptreact (Python and packages pinned; setup.sh builds it).

Its Python, numpy and pyarrow must also be those of Texera's operator sandbox (NATIVE_ISOLATED_PYTHON) when the stack
has one, so that both systems compute on one stack."""
import json
import os
from pathlib import Path
import re
import subprocess

from bobbench.paths import ENVS

LOCK = ENVS / "scriptreact"
# Packages that must match Texera's operator sandbox, besides the Python version.
SANDBOX_PACKAGES = ("numpy", "pyarrow")


def pinned(lines):
    """`name==version` lines as {normalized name: version}; comments and blanks are skipped."""
    found = {}
    for line in lines:
        line = line.split("#", 1)[0].strip()
        if line:
            name, _, version = line.partition("==")
            found[re.sub(r"[-_.]+", "-", name).lower()] = version.strip()
    return found


def interpreter(python):
    """An interpreter's Python version and installed packages, read by that interpreter."""
    probe = ("import importlib.metadata as m, json, platform; print(json.dumps({'python': platform.python_version(), "
             "'packages': sorted(f\"{d.metadata['Name']}=={d.version}\" for d in m.distributions())}))")
    found = json.loads(subprocess.check_output([str(python), "-c", probe], text=True))
    return found["python"], pinned(found["packages"])


def locked(python):
    """Check `python` against the lock (and Texera's sandbox); its record for the manifest. Raises ValueError."""
    python = Path(python)
    rebuild = f"rebuild it with {LOCK / 'setup.sh'}"
    if not python.is_file():
        raise ValueError(f"No Script ReAct interpreter at {python}; {rebuild}")
    version, packages = interpreter(python)
    wanted = (LOCK / ".python-version").read_text().strip()
    lock = pinned((LOCK / "requirements.txt").read_text().splitlines())
    if version != wanted or packages != lock:
        drift = sorted(f"{name} {packages.get(name)} != {lock.get(name)}" for name in set(packages) | set(lock)
                       if packages.get(name) != lock.get(name))
        raise ValueError(f"{python} runs Python {version} (locked {wanted}), packages {drift[:8]}; {rebuild}")
    sandbox = os.environ.get("NATIVE_ISOLATED_PYTHON")
    if sandbox:
        texera_version, texera_packages = interpreter(sandbox)
        mine = (version, *(packages.get(name) for name in SANDBOX_PACKAGES))
        theirs = (texera_version, *(texera_packages.get(name) for name in SANDBOX_PACKAGES))
        if mine != theirs:
            raise ValueError(f"Script ReAct would run on Python/{'/'.join(SANDBOX_PACKAGES)} {mine}, Texera's operator "
                             f"sandbox ({sandbox}) on {theirs}; update {LOCK} to match")
    return {"path": str(python.absolute()), "python": version, "texera_sandbox": sandbox,
            "packages": [f"{name}=={packages[name]}" for name in sorted(packages)]}
