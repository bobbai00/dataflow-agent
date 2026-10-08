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
"""Check figure metadata capture and working-directory recovery offline."""
from pathlib import Path

import matplotlib
import numpy as np
import pytest

import plot_capture

matplotlib.use("Agg")
from matplotlib import pyplot as plt  # noqa: E402


def install_inspector(tmp_path, monkeypatch, body):
    """Supply a reference-free inspector with the upstream entry-point shape."""
    monkeypatch.setattr(plot_capture, "__file__", str(tmp_path / "plot_capture.py"))
    source = (
        "import json\nimport numpy as np\n"
        "class Plotprocess:\n"
        "    @staticmethod\n"
        "    def plot_process(ax, fig):\n" + "\n".join("        " + line for line in body.splitlines()) + "\n"
    )
    (tmp_path / "plot_inspector_upstream.py").write_text(source)


def test_capture_uses_the_actual_figure_and_restores_working_directory(tmp_path, monkeypatch):
    install_inspector(
        tmp_path,
        monkeypatch,
        'np.save("bar_data_result_.npy", [bar.get_height() for bar in ax.patches])\n'
        'with open("bar_result_image_parameters_.json", "w") as stream:\n'
        '    json.dump({"graph_title": ax.get_title()}, stream)',
    )
    original_cwd = Path.cwd()
    fig, ax = plt.subplots()
    try:
        ax.bar(["A", "B"], [7, 13])
        ax.set_title("Computed values")
        output = tmp_path / "outputs" / "result.png"
        assert plot_capture.save_figure(fig, output) == str(output)
        assert output.stat().st_size > 0
        np.testing.assert_array_equal(np.load(output.parent / "dabench/result.npy"), [7, 13])
        assert '"graph_title": "Computed values"' in (output.parent / "dabench/plot.json").read_text()
        assert Path.cwd() == original_cwd
        assert not list(output.parent.glob("plot-capture-*"))
    finally:
        plt.close(fig)


def test_failed_inspection_restores_working_directory(tmp_path, monkeypatch):
    install_inspector(tmp_path, monkeypatch, 'raise RuntimeError("inspection failed")')
    original_cwd = Path.cwd()
    fig, ax = plt.subplots()
    try:
        ax.bar(["A"], [5])
        with pytest.raises(RuntimeError, match="inspection failed"):
            plot_capture.save_figure(fig, tmp_path / "outputs/result.png")
        assert Path.cwd() == original_cwd
        assert not list((tmp_path / "outputs").glob("plot-capture-*"))
        assert not (tmp_path / "outputs/dabench/plot.json").exists()
    finally:
        plt.close(fig)


def test_ambiguous_inspector_outputs_are_rejected(tmp_path, monkeypatch):
    install_inspector(
        tmp_path,
        monkeypatch,
        'np.save("bar_data_result_.npy", [1])\n'
        'np.save("line_data_result_.npy", [2])\n'
        'with open("bar_result_image_parameters_.json", "w") as stream:\n'
        "    json.dump({}, stream)",
    )
    original_cwd = Path.cwd()
    fig, ax = plt.subplots()
    try:
        ax.bar(["A"], [5])
        with pytest.raises(ValueError, match="cannot extract"):
            plot_capture.save_figure(fig, tmp_path / "outputs/result.png")
        assert Path.cwd() == original_cwd
        assert not (tmp_path / "outputs/dabench/result.npy").exists()
    finally:
        plt.close(fig)
