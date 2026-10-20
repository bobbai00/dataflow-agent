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
"""Loaded at startup by every sandboxed engine Python worker (native_isolated_python.py).

Model-written code, the frames compiled as ``<definitions:N>``, may list only the task data
directories, may not read the shared result warehouse, and may not start processes. The
warehouse holds every attempt's results, so reading it would let one attempt see another's
work. Engine code is unaffected: the hook acts only while a model frame is on the stack.
"""
import os
import sys

# The import system lists the interpreter's own directories, so those stay listable too.
_LIST = tuple(
    dict.fromkeys(
        os.path.realpath(p)
        for p in [
            *os.environ.get("NATIVE_GUARD_LIST_ROOTS", "").split(os.pathsep),
            sys.prefix,
            sys.base_prefix,
            sys.exec_prefix,
            *[entry for entry in sys.path if os.path.isabs(entry)],
        ]
        if p
    )
)
_DENY = tuple(p for p in os.environ.get("NATIVE_GUARD_DENY_ROOTS", "").split(os.pathsep) if p)
_SPAWN = ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty", "pty.spawn")


def _model_frame_on_stack():
    # The hook also runs at interpreter startup, when the stack is shallow.
    try:
        frame = sys._getframe(1)
    except ValueError:
        return False
    while frame is not None:
        if frame.f_code.co_filename.startswith("<definitions:"):
            return True
        frame = frame.f_back
    return False


def _real(path):
    try:
        return os.path.realpath(os.fsdecode(path))
    except (TypeError, ValueError):
        return ""


def _under(path, roots):
    return any(path == root or path.startswith(root.rstrip("/") + "/") for root in roots)


def _guard(event, args):
    if event not in ("os.listdir", "os.scandir", "open") and event not in _SPAWN:
        return
    if not _model_frame_on_stack():
        return
    if event in _SPAWN:
        raise PermissionError("Dataflow functions cannot start processes.")
    if event in ("os.listdir", "os.scandir"):
        path = args[0] if args and args[0] is not None else "."
        if isinstance(path, int):
            return
        target = _real(path)
        if not _under(target, _LIST):
            raise PermissionError(f"Listing {target} is not available; the task's files are under the data directory.")
        return
    path = args[0] if args else None
    if isinstance(path, (str, bytes, os.PathLike)) and _under(_real(path), _DENY):
        raise PermissionError(f"{os.fsdecode(path)} is not available to dataflow functions.")


if os.environ.get("NATIVE_GUARD_LIST_ROOTS") or _DENY:
    sys.addaudithook(_guard)
