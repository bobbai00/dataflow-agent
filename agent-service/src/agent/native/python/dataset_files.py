#
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
#
"""Texera dataset files for operators that read by path.

A dataset file (`/ownerEmail/datasetName/vN/path`, what the agent panel's
upload inserts) is not on the worker's disk. For every execution the agent
service resolves the dataset paths an operator names to short-lived download
links; these helpers copy each file into a local cache once and hand the reader
that copy. A link names the stored object, so a cached copy never goes stale.

The same source runs inside code-mode operators, whose non-source code is
screened for file I/O by pattern, so it moves bytes only through `urllib`,
`os.fdopen` and `shutil.copyfileobj`.
"""


def dataset_file_url(files, value):
    """The download link for a path the program named, with or without its leading slash."""
    if not files or not isinstance(value, str):
        return None
    return files.get(value) or files.get("/" + value.lstrip("/"))


def dataset_local_file(path, url):
    """A local copy of the dataset file `path`, downloaded from `url` on first use."""
    import hashlib
    import os
    import shutil
    import tempfile
    import urllib.parse
    import urllib.request

    location = urllib.parse.urlsplit(url)
    key = hashlib.sha256(f"{location.netloc}{location.path}".encode("utf-8")).hexdigest()[:24]
    directory = os.path.join(tempfile.gettempdir(), "texera-dataset-files", key)
    # Keep the file name: readers pick a format from its extension.
    target = os.path.join(directory, os.path.basename(path.rstrip("/")) or "file")
    if os.path.isfile(target):
        return target
    os.makedirs(directory, exist_ok=True)
    descriptor, partial = tempfile.mkstemp(dir=directory, prefix=".partial-")
    try:
        with os.fdopen(descriptor, "wb") as handle, urllib.request.urlopen(url, timeout=60) as response:
            shutil.copyfileobj(response, handle)
        os.replace(partial, target)
    except BaseException:
        if os.path.exists(partial):
            os.unlink(partial)
        raise
    return target


def localize_value(files, value):
    """`value` with every named dataset file swapped for its local copy (strings, lists, tuples)."""
    if isinstance(value, str):
        url = dataset_file_url(files, value)
        return dataset_local_file(value, url) if url else value
    if isinstance(value, (list, tuple)):
        return type(value)(localize_value(files, item) for item in value)
    return value


def localize_settings(files, settings):
    """A registered function's keyword settings, reading dataset files from their local copies."""
    if not files:
        return settings
    return {name: localize_value(files, value) for name, value in settings.items()}


def localize_module(namespace, files):
    """Point the dataset paths written in a module's code at local copies.

    Code-mode operators read files themselves (`pd.read_csv('/owner/ds/v1/a.csv')`).
    Their source stays as written, so error pointers still quote the model's own
    line; only the string constants of the module's functions and its string
    globals are swapped for the local copies.
    """
    import types

    local = {path: dataset_local_file(path, url) for path, url in files.items()}

    def swap(value):
        if isinstance(value, str):
            return local.get(value, value)
        if isinstance(value, (tuple, frozenset)):
            return type(value)(swap(item) for item in value)
        if isinstance(value, types.CodeType):
            consts = tuple(swap(item) for item in value.co_consts)
            return value if consts == value.co_consts else value.replace(co_consts=consts)
        return value

    def rebind(function):
        function.__code__ = swap(function.__code__)
        if function.__defaults__:
            function.__defaults__ = swap(function.__defaults__)
        if function.__kwdefaults__:
            function.__kwdefaults__ = {name: swap(value) for name, value in function.__kwdefaults__.items()}

    for name, value in list(namespace.items()):
        if name.startswith("__"):
            continue
        if isinstance(value, str):
            namespace[name] = swap(value)
        elif isinstance(value, list) and any(isinstance(item, str) and item in local for item in value):
            value[:] = [swap(item) for item in value]
        elif isinstance(value, types.FunctionType) and value.__globals__ is namespace:
            rebind(value)
        elif isinstance(value, type) and value.__module__ == namespace.get("__name__"):
            for member in vars(value).values():
                member = getattr(member, "__func__", member)
                if isinstance(member, types.FunctionType):
                    rebind(member)
