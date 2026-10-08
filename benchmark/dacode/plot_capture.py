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
"""Save a real Matplotlib figure and its DA-Code grading metadata.

The campaign places the pinned upstream image inspector beside this module.
It contains no reference data. Both agents use this same adapter, because
their code runs interactively rather than through DA-Code's plot.py replay.
"""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import tempfile


def save_figure(figure, filename):
    """Capture the plotted values with the unchanged upstream inspector."""
    image = Path(filename).absolute()
    image.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(image)
    inspector = Path(__file__).with_name("plot_inspector_upstream.py")
    spec = importlib.util.spec_from_file_location("dacode_plot_inspector", inspector)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not figure.axes:
        raise ValueError("The saved figure has no axes to inspect")
    metadata = image.parent / "dabench"
    metadata.mkdir(exist_ok=True)
    original_cwd = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="plot-capture-", dir=image.parent) as temp:
        try:
            os.chdir(temp)
            with contextlib.redirect_stdout(io.StringIO()):
                module.Plotprocess.plot_process(figure.gca(), figure)
            arrays = list(Path(temp).glob("*_data_result_.npy"))
            descriptions = list(Path(temp).glob("*_result_image_parameters_.json"))
            if len(arrays) != 1 or len(descriptions) != 1:
                raise ValueError("DA-Code cannot extract this figure's plot data")
            shutil.copyfile(arrays[0], metadata / "result.npy")
            shutil.copyfile(descriptions[0], metadata / "plot.json")
        finally:
            os.chdir(original_cwd)
    return str(image)
