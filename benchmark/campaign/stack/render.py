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
"""Write an isolated benchmark stack (the texera-stable layout) into a state directory.

The templates next to this file are the texera-stable stack of the 2026-10-16/17 runs with its paths replaced:
@TEXERA_HOME@ (the checkout every service, the agent and the runners use), @STACK_DIR@ (state: profile, logs, wire
traces, workspaces, runs), @KB_DATA@ (the KramaBench data the sandbox mounts) and @PROJECT@ (docker compose project and
container prefix). Ports stay the texera-stable set (local-dev offset 56000, agent 3130); run one such stack per host.
infra.env is written from infra.env.example only when missing, with mode 600; fill its provider keys.

Usage: render.py [--stack-dir /var/tmp/texera-stable] [--texera-home <this checkout>] [--kb-data <home>/benchmark/Kramabench/data]
                 [--project <basename of the stack dir>] [--force]"""
import argparse
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = {"profile.sh": 0o644, "run-env.sh": 0o755, "compose.json": 0o644, "isolation.json": 0o644, "empty-overlay.yml": 0o644}
DIRS = ["logs", "wire", "native-workspaces", "native-workspaces-agent", "runs"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stack-dir", type=Path, default=Path(os.environ.get("STACK_DIR", "/var/tmp/texera-stable")))
    parser.add_argument("--texera-home", type=Path, default=HERE.parents[2])
    parser.add_argument("--kb-data", type=Path)
    parser.add_argument("--project")
    parser.add_argument("--force", action="store_true", help="overwrite rendered files that already exist")
    args = parser.parse_args()
    home = args.texera_home.resolve()
    values = {"@TEXERA_HOME@": str(home), "@STACK_DIR@": str(args.stack_dir.resolve()),
              "@KB_DATA@": str((args.kb_data or home / "benchmark/Kramabench/data").resolve()),
              "@PROJECT@": args.project or args.stack_dir.resolve().name}
    args.stack_dir.mkdir(parents=True, exist_ok=True)
    for name, mode in FILES.items():
        target = args.stack_dir / name
        if target.exists() and not args.force:
            print(f"kept {target} (exists; --force to overwrite)")
            continue
        text = (HERE / name).read_text()
        for key, value in values.items():
            text = text.replace(key, value)
        target.write_text(text)
        target.chmod(mode)
        print(f"wrote {target}")
    infra = args.stack_dir / "infra.env"
    if not infra.exists():
        text = (HERE / "infra.env.example").read_text()
        for key, value in values.items():
            text = text.replace(key, value)
        infra.write_text(text)
        infra.chmod(0o600)
        empty = [line.split("=")[0] for line in text.splitlines() if line.endswith("=") and not line.startswith("#")]
        print(f"wrote {infra}; fill: {', '.join(empty)}")
    for name in DIRS:
        (args.stack_dir / name).mkdir(exist_ok=True)
    print(f"stack {values['@PROJECT@']} at {args.stack_dir} for {home}")


if __name__ == "__main__":
    main()
