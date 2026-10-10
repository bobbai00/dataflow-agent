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
"""Attach before exec, so owned service/worker allocations enter their scope."""
import argparse
import json
import os
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from benchmark.runtime.resources import CgroupScope, provision_cgroup
    from benchmark.runtime.metrics import write_json_exclusive
else:
    from .resources import CgroupScope, provision_cgroup
    from .metrics import write_json_exclusive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope-file", type=Path)
    parser.add_argument("--scope-json", help=argparse.SUPPRESS)
    parser.add_argument("--provision", metavar="NAME", help="Create and delegate a new named v1 CPU+memory scope")
    parser.add_argument("--sudo", action="store_true", help="Use sudo -n only to provision controller paths")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.provision:
        if not args.scope_file or args.scope_json:
            parser.error("--provision requires --scope-file")
        scope = provision_cgroup(args.provision, sudo=args.sudo)
        write_json_exclusive(args.scope_file, scope.as_dict())
    elif args.scope_json:
        scope = CgroupScope.from_dict(json.loads(args.scope_json))
    elif args.scope_file:
        scope = CgroupScope.from_dict(json.loads(args.scope_file.read_text()))
    else:
        parser.error("Provide --scope-file or --provision")
    command = args.command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        if args.provision:
            print(json.dumps(scope.as_dict()))
            return
        parser.error("Provide a command after --")
    scope.attach_self()
    os.execvp(command[0], command)


if __name__ == "__main__":
    main()
