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

"""Copy only a prepared manifest's input files into a private dataset directory."""
from pathlib import Path
import shutil


def snapshot_inputs(manifest, repository_root, destination):
    """Preserve source files and questions; exclude unlisted derived artifacts.

    Callers should validate the file list and content against their pinned
    dataset before taking the snapshot. The returned manifest uses the new
    directory in both its inventory and data path.
    """
    repository_root, destination = Path(repository_root), Path(destination)
    source_root = repository_root / manifest['data_dir']
    new_root = destination.relative_to(repository_root).as_posix()
    files = []
    for name in manifest['files']:
        source = repository_root / name
        relative = source.relative_to(source_root)
        if '..' in relative.parts or not source.is_file():
            raise ValueError(f'Invalid input file: {name}')
        files.append((source, relative))
    destination.mkdir(parents=True, exist_ok=False)
    for source, relative in files:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    return {**manifest, 'data_dir': new_root,
            'files': [f'{new_root}/{relative.as_posix()}' for _, relative in files]}
