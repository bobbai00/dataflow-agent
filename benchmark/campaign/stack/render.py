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
"""Write an isolated benchmark stack into a state directory.

The templates next to this file are the stack of the paper's runs with its paths and ports replaced:
@TEXERA_HOME@ (the checkout every service, the agent and the runners use), @STACK_DIR@ (state: profile, logs, wire
traces, workspaces, runs), @KB_DATA@ (the KramaBench data the sandbox mounts), @PROJECT@ (docker compose project and
container prefix), @P<base>@ (a local-dev base port plus --offset), @OFFSET@ and @AGENT_PORT@. Give each stack on a
host its own offset and agent port. infra.env is written from infra.env.example only when missing, with mode 600; every
call copies the provider keys from the checkout's .env into it.

Usage: render.py [--stack-dir /var/tmp/bobflow-bench] [--texera-home <this checkout>] [--kb-data <home>/benchmark/Kramabench/data]
                 [--project <basename of the stack dir>] [--offset 30000] [--agent-port 3100] [--force]"""
import argparse
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = {"profile.sh": 0o644, "run-env.sh": 0o755, "compose.json": 0o644, "empty-overlay.yml": 0o644}
DIRS = ["logs", "wire", "native-workspaces", "native-workspaces-agent", "runs"]
PROVIDER_KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY")


def render(text, values, offset):
    """Fill the path placeholders, then shift every @P<base>@ port by the offset."""
    for key, value in values.items():
        text = text.replace(key, value)

    def port(match):
        number = int(match.group(1)) + offset
        if not 0 < number <= 65535:
            raise SystemExit(f"--offset {offset} puts port {match.group(1)} out of range")
        return str(number)
    return re.sub(r"@P(\d+)@", port, text)


def copy_provider_keys(env_file, infra):
    """Give infra.env the keys that .env sets, so a key lives in one place. Values are never printed."""
    if not env_file.exists():
        return
    keys = {}
    for line in env_file.read_text().splitlines():
        name, _, value = re.sub(r"^export\s+", "", line).partition("=")
        if name.strip() in PROVIDER_KEYS and value.strip():
            keys[name.strip()] = value.strip().strip("\"'")
    lines = [f"{line.split('=')[0]}={keys[line.split('=')[0]]}" if line.split("=")[0] in keys else line
             for line in infra.read_text().splitlines()]
    infra.write_text("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stack-dir", type=Path, default=Path(os.environ.get("STACK_DIR", "/var/tmp/bobflow-bench")))
    parser.add_argument("--texera-home", type=Path, default=HERE.parents[2])
    parser.add_argument("--kb-data", type=Path)
    parser.add_argument("--project")
    parser.add_argument("--offset", type=int, default=30000, help="added to every local-dev base port")
    parser.add_argument("--agent-port", type=int, default=3100)
    parser.add_argument("--force", action="store_true", help="overwrite rendered files that already exist")
    args = parser.parse_args()
    home = args.texera_home.resolve()
    values = {"@TEXERA_HOME@": str(home), "@STACK_DIR@": str(args.stack_dir.resolve()),
              "@KB_DATA@": str((args.kb_data or home / "benchmark/Kramabench/data").resolve()),
              "@PROJECT@": args.project or args.stack_dir.resolve().name,
              "@OFFSET@": str(args.offset), "@AGENT_PORT@": str(args.agent_port)}
    args.stack_dir.mkdir(parents=True, exist_ok=True)
    for name, mode in FILES.items():
        target = args.stack_dir / name
        if target.exists() and not args.force:
            print(f"kept {target} (exists; --force to overwrite)")
            continue
        target.write_text(render((HERE / name).read_text(), values, args.offset))
        target.chmod(mode)
        print(f"wrote {target}")
    infra = args.stack_dir / "infra.env"
    if not infra.exists():
        text = render((HERE / "infra.env.example").read_text(), values, args.offset)
        infra.write_text(text)
        infra.chmod(0o600)
        print(f"wrote {infra}")
    copy_provider_keys(home / ".env", infra)
    empty = [line.split("=")[0] for line in infra.read_text().splitlines() if line.endswith("=") and not line.startswith("#")]
    if empty:
        print(f"not in {home / '.env'}: {', '.join(empty)}")
    for name in DIRS:
        (args.stack_dir / name).mkdir(exist_ok=True)
    print(f"stack {values['@PROJECT@']} at {args.stack_dir} for {home}")


if __name__ == "__main__":
    main()
