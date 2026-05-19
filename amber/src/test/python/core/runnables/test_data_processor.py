# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

import importlib
import sys
import types

import pytest

from core.architecture.managers import Context
from core.models import State
from core.models.internal_queue import InternalQueue
from core.models.internal_marker import EndChannel, StartChannel
from core.runnables.data_processor import DataProcessor
from proto.org.apache.texera.amber.engine.architecture.rpc import ConsoleMessageType


@pytest.fixture
def context():
    return Context(worker_id="test-worker", input_queue=InternalQueue())


@pytest.fixture
def data_processor(context, monkeypatch):
    """
    DataProcessor with `_switch_context` swapped for a counter so each test
    can drive the synchronous parts of the per-call boilerplate without
    blocking on the cross-thread handshake.
    """
    dp = DataProcessor(context)
    dp.switch_calls = 0

    def fake_switch():
        dp.switch_calls += 1

    monkeypatch.setattr(dp, "_switch_context", fake_switch)
    return dp


class _StubExecutor:
    """
    Records what `process_internal_marker` invokes on it so the test can
    assert the StartChannel / EndChannel branches of `data_processor`
    without standing up a real Operator.
    """

    def __init__(self):
        self.calls = []

    def produce_state_on_start(self, port_id):
        self.calls.append(("produce_state_on_start", port_id))
        return {"phase": "start"}

    def produce_state_on_finish(self, port_id):
        self.calls.append(("produce_state_on_finish", port_id))
        return {"phase": "finish"}

    def on_finish(self, port_id):
        self.calls.append(("on_finish", port_id))
        return iter([])


class TestProcessInternalMarker:
    @pytest.mark.timeout(2)
    def test_start_channel_invokes_produce_state_on_start(
        self, context, data_processor
    ):
        executor = _StubExecutor()
        context.executor_manager.executor = executor

        data_processor.process_internal_marker(StartChannel())

        # StartChannel routes to produce_state_on_start with the current
        # input port id (0 when no upstream is set), and the returned dict
        # is wrapped into a State on the output slot.
        assert executor.calls == [("produce_state_on_start", 0)]
        out = context.state_processing_manager.current_output_state
        assert isinstance(out, State)
        assert out["phase"] == "start"
        # `_executor_session` always switches once on exit.
        assert data_processor.switch_calls == 1

    @pytest.mark.timeout(2)
    def test_end_channel_flushes_state_then_drains_on_finish(
        self, context, data_processor
    ):
        executor = _StubExecutor()
        context.executor_manager.executor = executor

        data_processor.process_internal_marker(EndChannel())

        # EndChannel must call produce_state_on_finish first, switch
        # context to flush that state separately from the on_finish
        # tuple stream, then drain on_finish. The session itself adds
        # its own trailing switch on exit.
        assert executor.calls == [
            ("produce_state_on_finish", 0),
            ("on_finish", 0),
        ]
        # 1 switch from the explicit flush + 1 from `_executor_session`
        # exit. `_set_output_tuple` exits early on an empty iterator and
        # does not switch.
        assert data_processor.switch_calls == 2


class TestExecutorSession:
    @pytest.mark.timeout(2)
    def test_exception_inside_session_is_reported_before_the_switch(
        self, context, data_processor
    ):
        # Order matters: MainLoop's _check_exception flushes pending
        # console messages and then immediately enters EXCEPTION_PAUSE,
        # so the stack trace must already be in the buffer at the moment
        # _executor_session calls _switch_context. Capture the buffer
        # state from inside the fake switch to pin that ordering.
        seen_at_switch = []

        def capturing_switch():
            seen_at_switch.extend(
                context.console_message_manager.get_messages(force_flush=True)
            )
            data_processor.switch_calls += 1

        data_processor._switch_context = capturing_switch

        with data_processor._executor_session() as session:
            assert session is not None
            raise RuntimeError("boom-from-executor")

        # Exception was routed into the manager so MainLoop's
        # _check_exception can see it.
        assert context.exception_manager.has_exception()
        exc_info = context.exception_manager.get_exc_info()
        assert exc_info[0] is RuntimeError
        assert "boom-from-executor" in str(exc_info[1])
        # And the stack-trace console message was queued *before* the
        # finally-clause switch — without this, the worker would pause
        # before ever sending the error to the controller.
        assert len(seen_at_switch) == 1
        msg = seen_at_switch[0]
        assert msg.worker_id == "test-worker"
        assert msg.msg_type == ConsoleMessageType.ERROR
        assert "RuntimeError: boom-from-executor" in msg.title
        # Exit always switches back to MainLoop, even on the failure path.
        assert data_processor.switch_calls == 1

    @pytest.mark.timeout(2)
    def test_clean_session_does_not_record_an_exception(self, context, data_processor):
        with data_processor._executor_session():
            pass

        assert not context.exception_manager.has_exception()
        assert (
            list(context.console_message_manager.get_messages(force_flush=True)) == []
        )
        # Even on the success path, the finally clause yields control
        # back to MainLoop exactly once.
        assert data_processor.switch_calls == 1


class TestReportException:
    """
    `_report_exception` builds the ConsoleMessage that SyncExecutionResource
    surfaces to the agent as the operator's `[ERROR]` block. The two
    branches that matter for agent UX:

    1. Traceback contains a user-UDF frame (the "happy" error path: the
       exception was thrown from inside `def load()` / `def process()`).
       → title carries `(line N) `code_line` - ExceptionType: msg`
       → message carries the annotated user code with `>` on the failing
         line, prefixed with `at line N in <func>`.

    2. Traceback has NO user-UDF frame — the exception was raised after
       the operator returned (e.g. Texera schema validation rejecting a
       value type). This is the case that produced the
       `climateMeasurements` "Unmatched type for field 'Unnamed: 2'"
       failure mode where the agent's [ERROR] block was just one cryptic
       line. The fix recovers the operator's source via the
       ExecutorManager's registered module name and attaches it to the
       message under a neutral header (no line number, no claim about
       where the failure originated).

    Both branches deliberately omit a multi-frame Python traceback —
    only the top-level exception summary is included, keeping the
    [ERROR] block compact while still carrying the full operator code.
    """

    _UDF_SOURCE = (
        "from pytexera import *\n"
        "import pandas as pd\n"
        "\n"
        "class GenerateOperator:\n"
        "    pass\n"
        "\n"
        "def load() -> pd.DataFrame:\n"
        "    import pandas as pd\n"
        "    return pd.read_excel('data/archeology/input/climateMeasurements.xlsx')\n"
    )

    def _register_fake_udf_module(self, tmp_path, monkeypatch) -> str:
        """
        Write the climateMeasurements-style UDF to a tmp `udf-vN.py`
        file and stick a stub module entry into `sys.modules` pointing
        at it, so `_read_running_operator_source` can find it.
        Returns the module name.
        """
        module_name = "udf-vTEST"
        file_path = tmp_path / f"{module_name}.py"
        file_path.write_text(self._UDF_SOURCE)

        fake_mod = types.ModuleType(module_name)
        fake_mod.__file__ = str(file_path)
        monkeypatch.setitem(sys.modules, module_name, fake_mod)
        return module_name

    @pytest.mark.timeout(2)
    def test_no_udf_frame_attaches_operator_source(
        self, context, data_processor, tmp_path, monkeypatch
    ):
        # Simulate the climateMeasurements case: framework validation
        # raises AFTER the operator's def load() returned, so the
        # traceback contains no UDF frame.
        module_name = self._register_fake_udf_module(tmp_path, monkeypatch)
        context.executor_manager.operator_module_name = module_name

        with data_processor._executor_session():
            raise TypeError(
                "Unmatched type for field 'Unnamed: 2', expected "
                "AttributeType.STRING, got 1 (<class 'int'>) instead."
            )

        msgs = list(context.console_message_manager.get_messages(force_flush=True))
        assert len(msgs) == 1
        msg = msgs[0]
        assert msg.msg_type == ConsoleMessageType.ERROR

        # Title is the readable exception summary — NOT the deepest-frame
        # `raise TypeError(` line (which was the regression we're fixing).
        assert msg.title.startswith("TypeError: Unmatched type for field 'Unnamed: 2'")
        assert "`raise TypeError(`" not in msg.title

        # Message must be longer than title so SyncExecutionResource's
        # `max(title.length, message.length)` selection surfaces it.
        assert len(msg.message) > len(msg.title)

        # The operator's source — recovered via ExecutorManager — is
        # embedded in the message even though no UDF frame was on tb.
        # Neutral header: no claim about where the failure came from,
        # no fabricated line number.
        assert (
            "An execution error happened while running the operator. "
            "The operator's code was:"
        ) in msg.message
        assert "def load() -> pd.DataFrame:" in msg.message
        assert "pd.read_excel('data/archeology/input/climateMeasurements.xlsx')" in msg.message

        # No `>` marker — we don't know the failing line, so we don't
        # pretend to mark one.
        for line in msg.message.splitlines():
            assert not line.lstrip().startswith(">")

        # No multi-frame traceback chain is appended; the top-level
        # exception summary at the head of `message` is the only stack
        # info we surface.
        assert "Traceback (most recent call last):" not in msg.message
        # And no language attributing the failure to a specific
        # framework layer ("outside user code", "framework code", etc.).
        assert "outside user code" not in msg.message
        assert "framework code" not in msg.message

    @pytest.mark.timeout(2)
    def test_udf_frame_marks_failing_line(
        self, context, data_processor, tmp_path, monkeypatch
    ):
        # Write a real udf-v*.py with a raising load(); importing and
        # invoking it gives a traceback whose deepest frame matches
        # `_UDF_FILENAME_PATTERN`. This exercises the happy path.
        sys.path.insert(0, str(tmp_path))
        try:
            src = (
                "from pytexera import *\n"
                "\n"
                "class GenerateOperator:\n"
                "    pass\n"
                "\n"
                "def load():\n"
                "    x = 1\n"
                "    raise ValueError('boom-from-load')\n"
            )
            (tmp_path / "udf-v9999.py").write_text(src)
            mod = importlib.import_module("udf-v9999")
            context.executor_manager.operator_module_name = "udf-v9999"

            with data_processor._executor_session():
                mod.load()
        finally:
            sys.path.remove(str(tmp_path))
            sys.modules.pop("udf-v9999", None)

        msgs = list(context.console_message_manager.get_messages(force_flush=True))
        assert len(msgs) == 1
        msg = msgs[0]

        # User-relative line numbering: line 1 = `def load():` after slicing
        # off the boilerplate header. So the raising line `raise
        # ValueError(...)` is line 3 inside the user code, marked with `>`.
        assert "(line 3)" in msg.title
        assert "ValueError: boom-from-load" in msg.title

        assert "Operator code:" in msg.message
        # The `>` arrow should point at the raise line (line 3 of the slice).
        assert "> 3 |" in msg.message
        assert "raise ValueError('boom-from-load')" in msg.message
        # No multi-frame traceback, no neutral-header phrasing — the
        # UDF-frame branch produces the marked-code form only.
        assert "Traceback (most recent call last):" not in msg.message
        assert "An execution error happened while running the operator" not in msg.message

    @pytest.mark.timeout(2)
    def test_no_udf_frame_and_no_module_falls_back_gracefully(
        self, context, data_processor
    ):
        # No executor_manager.operator_module_name → source recovery
        # returns None and we emit just the exception summary.
        with data_processor._executor_session():
            raise RuntimeError("plain-old-bug")

        msgs = list(context.console_message_manager.get_messages(force_flush=True))
        assert len(msgs) == 1
        msg = msgs[0]
        assert msg.title == "RuntimeError: plain-old-bug"
        # No source available → message degrades to just the exception
        # line. No "Operator code:" section, no neutral-header phrasing,
        # no multi-frame traceback.
        assert msg.message == "RuntimeError: plain-old-bug"


class TestFormatCodeWithMarker:
    """
    `_format_code_with_marker` is the renderer used inside the [ERROR]
    block's "Operator code:" section. Two contracts matter:

    1. Short functions (≤ _FULL_BLOCK_THRESHOLD lines) render in full
       — same shape as before elision was introduced.
    2. Long functions are summarized to: first PREFIX lines + a window
       of ±MARKER_RADIUS around the failing line + last SUFFIX lines.
       Kept indices are collapsed to contiguous ranges and joined with
       a `…` row between non-adjacent ranges. This guarantees the
       error block stays bounded (≈ 24 code lines) even on long UDFs
       like the late-stage analysis operators in the archeology trace
       (146-148 lines each).
    """

    @staticmethod
    def _body_lines(n: int) -> "list[str]":
        # Synthetic UDF body where every line is unique so we can
        # assert exactly which ones survived the elision.
        return [f"line_{i}" for i in range(1, n + 1)]

    @staticmethod
    def _kept_indices(rendered: str) -> "list[int]":
        # Walk the rendered output and parse out the 1-based line
        # number on every non-ellipsis row. Mirrors how the agent
        # would visually scan the block.
        out: list[int] = []
        for line in rendered.splitlines():
            stripped = line.lstrip()
            # ellipsis rows start with `…`
            if stripped.startswith("…"):
                continue
            # rendered shape: `{marker} {idx} | {line}`
            parts = line.split("|", 1)
            if len(parts) != 2:
                continue
            head = parts[0]
            tokens = head.strip().split()
            try:
                idx = int(tokens[-1])
                out.append(idx)
            except (ValueError, IndexError):
                continue
        return out

    @staticmethod
    def _row_for(rendered: str, line_idx: int, source_line: str) -> str:
        # Pull the rendered row for a specific source line. Whitespace
        # padding around the line number depends on the total line
        # count's width, so we match on the unique trailing
        # `| <source_line>` instead.
        suffix = f"| {source_line}"
        for r in rendered.splitlines():
            if r.endswith(suffix) and r.rstrip().endswith(source_line):
                # Defensive: confirm the parsed line index matches.
                parts = r.split("|", 1)
                tokens = parts[0].strip().split()
                if tokens and tokens[-1] == str(line_idx):
                    return r
        raise AssertionError(f"no rendered row for line {line_idx} / {source_line!r}")

    @pytest.mark.timeout(2)
    def test_short_function_renders_in_full(self):
        # Functions at or below the threshold should render every line
        # — preserves the "no elision for small operators" promise.
        from core.runnables.data_processor import DataProcessor

        lines = self._body_lines(DataProcessor._FULL_BLOCK_THRESHOLD)
        rendered = DataProcessor._format_code_with_marker(lines, 3)
        kept = self._kept_indices(rendered)
        assert kept == list(range(1, len(lines) + 1))
        assert "…" not in rendered
        # Marker on line 3.
        assert self._row_for(rendered, 3, "line_3").startswith(">")

    @pytest.mark.timeout(2)
    def test_long_function_with_marker_mid_function(self):
        # 100-line UDF, marker at line 50. The kept set is:
        #   {1..5} ∪ {46..54} ∪ {91..100}
        # All three ranges are non-adjacent → two ellipsis rows.
        from core.runnables.data_processor import DataProcessor

        lines = self._body_lines(100)
        rendered = DataProcessor._format_code_with_marker(lines, 50)
        kept = self._kept_indices(rendered)
        expected = sorted(set(range(1, 6)) | set(range(46, 55)) | set(range(91, 101)))
        assert kept == expected
        # `>` marker on line 50.
        assert self._row_for(rendered, 50, "line_50").startswith(">")
        # Two ellipsis rows (between {1..5} and {46..54}, and between
        # {46..54} and {91..100}).
        assert rendered.count("…") == 2

    @pytest.mark.timeout(2)
    def test_long_function_marker_overlapping_prefix_collapses_ellipsis(self):
        # Marker at line 6 in a 50-line UDF. Prefix is {1..5}, marker
        # window is {2..10} — they touch, so the combined leading
        # range is {1..10} with no ellipsis before it. The trailing
        # suffix is still separated from {1..10} by a gap, so one
        # ellipsis remains.
        from core.runnables.data_processor import DataProcessor

        lines = self._body_lines(50)
        rendered = DataProcessor._format_code_with_marker(lines, 6)
        kept = self._kept_indices(rendered)
        # {1..10} ∪ {41..50}
        assert kept == sorted(set(range(1, 11)) | set(range(41, 51)))
        # Exactly one ellipsis (between the leading and trailing
        # ranges); no leading or trailing ellipsis at the edges.
        assert rendered.count("…") == 1
        assert not rendered.lstrip().startswith("…")
        assert not rendered.rstrip().endswith("…")
        # `>` on line 6.
        assert self._row_for(rendered, 6, "line_6").startswith(">")

    @pytest.mark.timeout(2)
    def test_long_function_marker_near_end_overlaps_suffix(self):
        # 50-line UDF, marker at line 48. Suffix is {41..50}, marker
        # window is {44..50} — they overlap, so the trailing range
        # is just {41..50}.
        from core.runnables.data_processor import DataProcessor

        lines = self._body_lines(50)
        rendered = DataProcessor._format_code_with_marker(lines, 48)
        kept = self._kept_indices(rendered)
        # {1..5} ∪ {41..50}
        assert kept == sorted(set(range(1, 6)) | set(range(41, 51)))
        assert rendered.count("…") == 1
        assert self._row_for(rendered, 48, "line_48").startswith(">")

    @pytest.mark.timeout(2)
    def test_long_function_no_marker(self):
        # error_line ≤ 0 disables the marker. We fall back to
        # first 10 + last 10 lines, with one ellipsis between.
        from core.runnables.data_processor import DataProcessor

        lines = self._body_lines(100)
        rendered = DataProcessor._format_code_with_marker(lines, -1)
        kept = self._kept_indices(rendered)
        assert kept == sorted(set(range(1, 11)) | set(range(91, 101)))
        # No `>` arrow anywhere.
        for line in rendered.splitlines():
            assert not line.lstrip().startswith(">")
        assert rendered.count("…") == 1

    @pytest.mark.timeout(2)
    def test_threshold_boundary_at_full_block_threshold_plus_one(self):
        # Just one line over the threshold should already elide if
        # the marker pulls the kept set apart from the suffix. A
        # 21-line function with marker at line 10 yields kept set
        # {1..5} ∪ {6..14} ∪ {12..21} (deduplicated to {1..14, 12..21}
        # = {1..21}) — fully kept because the ranges merge. So we
        # use a function whose marker leaves a real gap.
        from core.runnables.data_processor import DataProcessor

        # 30 lines, marker at 25 — gap between {1..5} and {21..30}.
        lines = self._body_lines(30)
        rendered = DataProcessor._format_code_with_marker(lines, 25)
        kept = self._kept_indices(rendered)
        # {1..5} ∪ {21..29} ∪ {21..30} = {1..5, 21..30}
        assert kept == sorted(set(range(1, 6)) | set(range(21, 31)))
        assert rendered.count("…") == 1
        assert self._row_for(rendered, 25, "line_25").startswith(">")

    @pytest.mark.timeout(2)
    def test_empty_lines_returns_empty_string(self):
        from core.runnables.data_processor import DataProcessor

        assert DataProcessor._format_code_with_marker([], 1) == ""

    @pytest.mark.timeout(2)
    def test_bound_holds_on_pathologically_long_udf(self):
        # The 146-line `computeKAtMaltaTimes` and the 148-line
        # `computeKCorrect` from react-trace-new-archaeology-1.json
        # are the worst latent cases in production. Without elision,
        # an error in those would dump ~5-6KB. Verify the rendered
        # body is bounded: ≤ 30 rendered rows even at 500 lines.
        from core.runnables.data_processor import DataProcessor

        lines = self._body_lines(500)
        rendered = DataProcessor._format_code_with_marker(lines, 250)
        row_count = len(rendered.splitlines())
        # 5 (prefix) + 9 (marker ±4) + 10 (suffix) + 2 (ellipsis rows) = 26
        assert row_count <= 30, f"elision exceeded bound: {row_count} rows"


class TestRunInvariant:
    """
    `run()` enforces that exactly one of marker / state / tuple is queued per
    iteration. The invariant raises a RuntimeError otherwise — that branch
    is otherwise unreachable in the integration tests, so cover it directly.
    """

    @staticmethod
    def _drive_run_synchronously(context, monkeypatch) -> DataProcessor:
        # `run()` opens with a condition.wait() so MainLoop can hand off
        # control. Stub that out so the test thread can call run() directly
        # and reach the invariant check on the very first iteration without
        # any cross-thread coordination.
        cond = context.tuple_processing_manager.context_switch_condition
        monkeypatch.setattr(cond, "wait", lambda *a, **kw: None)
        return DataProcessor(context)

    @pytest.mark.timeout(2)
    def test_zero_queued_inputs_raises_invariant_error(self, context, monkeypatch):
        dp = self._drive_run_synchronously(context, monkeypatch)
        # Nothing is set on tpm/spm — has_marker + has_state + has_tuple == 0.
        with pytest.raises(RuntimeError) as excinfo:
            dp.run()
        assert "expected exactly one queued input" in str(excinfo.value)
        assert "marker=False, state=False, tuple=False" in str(excinfo.value)

    @pytest.mark.timeout(2)
    def test_two_queued_inputs_raises_invariant_error(self, context, monkeypatch):
        dp = self._drive_run_synchronously(context, monkeypatch)
        # Populate two slots — has_marker + has_tuple == 2.
        context.tuple_processing_manager.current_internal_marker = StartChannel()
        context.tuple_processing_manager.current_input_tuple = ("payload",)
        with pytest.raises(RuntimeError) as excinfo:
            dp.run()
        assert "expected exactly one queued input" in str(excinfo.value)
        assert "marker=True" in str(excinfo.value)
        assert "tuple=True" in str(excinfo.value)


# ----------------------------------------------------------------------
# Runtime schema inference (DataFrame -> Texera Schema)
# ----------------------------------------------------------------------

import pandas as _pd  # noqa: E402  -- placed below the existing tests so the
# inference suite below does not perturb the import-order assumptions of the
# earlier classes (which deliberately import `from core...` without pandas).
import numpy as _np  # noqa: E402

from core.models.schema import Schema  # noqa: E402
from core.models.schema.attribute_type import AttributeType  # noqa: E402
from core.models.table import Table  # noqa: E402
from proto.org.apache.texera.amber.core import PortIdentity  # noqa: E402


class TestMapPandasDtypeToAttributeType:
    """
    `_map_pandas_dtype_to_attribute_type` is the dtype-keyed half of schema
    inference: it handles every column that is *not* `object` dtype. Coverage
    target: every branch listed in the function docstring.
    """

    @pytest.mark.parametrize(
        "series_input, expected",
        [
            # numpy primitives (lookup-table hits)
            (_pd.Series([1, 2, 3], dtype="int8"), AttributeType.LONG),
            (_pd.Series([1, 2, 3], dtype="int16"), AttributeType.LONG),
            (_pd.Series([1, 2, 3], dtype="int32"), AttributeType.LONG),
            (_pd.Series([1, 2, 3], dtype="int64"), AttributeType.LONG),
            (_pd.Series([1, 2, 3], dtype="uint32"), AttributeType.LONG),
            (_pd.Series([1.0, 2.0], dtype="float32"), AttributeType.DOUBLE),
            (_pd.Series([1.0, 2.0], dtype="float64"), AttributeType.DOUBLE),
            (_pd.Series([True, False], dtype="bool"), AttributeType.BOOL),
            # numpy datetime64 (handled by the prefix-match fallback)
            (
                _pd.Series(_pd.to_datetime(["2024-01-01", "2024-01-02"])),
                AttributeType.TIMESTAMP,
            ),
            # pandas nullable extension dtypes
            (_pd.Series([1, _pd.NA], dtype="Int64"), AttributeType.LONG),
            (_pd.Series([1, _pd.NA], dtype="Int32"), AttributeType.LONG),
            (_pd.Series([1, _pd.NA], dtype="UInt16"), AttributeType.LONG),
            (_pd.Series([1.5, _pd.NA], dtype="Float64"), AttributeType.DOUBLE),
            (_pd.Series([True, _pd.NA], dtype="boolean"), AttributeType.BOOL),
            (_pd.Series(["a", "b"], dtype="string"), AttributeType.STRING),
            # Categorical maps to STRING regardless of underlying category dtype.
            (_pd.Series(["x", "y"], dtype="category"), AttributeType.STRING),
            (
                _pd.Series([1, 2], dtype=_pd.CategoricalDtype([1, 2])),
                AttributeType.STRING,
            ),
            # timedelta64 -> LONG (nanoseconds).
            (
                _pd.Series(_pd.to_timedelta(["1 days", "2 days"])),
                AttributeType.LONG,
            ),
        ],
    )
    def test_known_dtype_maps_to_expected_type(self, series_input, expected):
        from core.runnables.data_processor import DataProcessor

        assert (
            DataProcessor._map_pandas_dtype_to_attribute_type(series_input.dtype)
            == expected
        )

    def test_datetime_with_timezone_maps_to_timestamp(self):
        from core.runnables.data_processor import DataProcessor

        # datetime64[ns, UTC] — the `tz` attribute path + the
        # "datetime64" prefix both cover this; assert it lands on TIMESTAMP.
        ser = _pd.Series(_pd.to_datetime(["2024-01-01"], utc=True))
        assert (
            DataProcessor._map_pandas_dtype_to_attribute_type(ser.dtype)
            == AttributeType.TIMESTAMP
        )


class TestInferTypeFromObjectColumn:
    """
    Object-dtype columns can mean almost anything: nullable basic types, real
    strings, mixed types, or homogeneous list/dict cells. The function leans
    on `pandas.api.types.infer_dtype` for the "pandas can tell" cases and
    falls back to type-sampling for the rest.
    """

    @pytest.mark.parametrize(
        "series_values, expected",
        [
            # nulls preserved → still types as LONG via infer_dtype="integer"
            ([1, 2, None, 3], AttributeType.LONG),
            ([1, None, 2], AttributeType.LONG),
            # nulls + floats → "floating"
            ([1.5, None, 2.5], AttributeType.DOUBLE),
            # mixed int+float → "mixed-integer-float" → DOUBLE
            ([1, 2.5, 3], AttributeType.DOUBLE),
            # booleans with nulls
            ([True, False, None], AttributeType.BOOL),
            # genuine strings
            (["a", "b", None, "c"], AttributeType.STRING),
            # all None / all-NaN object column → STRING (safest default)
            ([None, None, None], AttributeType.STRING),
            # empty object series → STRING
            ([], AttributeType.STRING),
        ],
    )
    def test_pandas_infer_dtype_paths(self, series_values, expected):
        from core.runnables.data_processor import DataProcessor

        ser = _pd.Series(series_values, dtype="object")
        assert DataProcessor._infer_type_from_object_column(ser) == expected

    def test_homogeneous_list_column_is_LIST(self):
        from core.runnables.data_processor import DataProcessor

        ser = _pd.Series([[1, 2], [3, 4], [5]], dtype="object")
        assert (
            DataProcessor._infer_type_from_object_column(ser)
            == AttributeType.LIST
        )

    def test_homogeneous_dict_column_is_STRUCT(self):
        from core.runnables.data_processor import DataProcessor

        ser = _pd.Series([{"a": 1}, {"b": 2}], dtype="object")
        assert (
            DataProcessor._infer_type_from_object_column(ser)
            == AttributeType.STRUCT
        )

    def test_mixed_list_and_dict_falls_back_to_STRING(self):
        from core.runnables.data_processor import DataProcessor

        # types_seen == {list, dict} — neither pure-list nor pure-dict, and
        # pandas reports `mixed`, so the safe fallback (STRING) wins.
        ser = _pd.Series([[1], {"a": 1}], dtype="object")
        assert (
            DataProcessor._infer_type_from_object_column(ser)
            == AttributeType.STRING
        )

    def test_mixed_int_and_str_falls_back_to_STRING(self):
        from core.runnables.data_processor import DataProcessor

        ser = _pd.Series([1, "two", 3], dtype="object")
        assert (
            DataProcessor._infer_type_from_object_column(ser)
            == AttributeType.STRING
        )

    def test_homogeneous_bytes_column_is_BINARY(self):
        from core.runnables.data_processor import DataProcessor

        # pandas.api.types.infer_dtype reports "bytes" for pure-bytes object
        # columns, which is covered directly by the infer_dtype branch.
        ser = _pd.Series([b"\x00\x01", b"\x02"], dtype="object")
        assert (
            DataProcessor._infer_type_from_object_column(ser)
            == AttributeType.BINARY
        )


class TestInferSchemaFromDataframe:
    """
    The DataFrame -> Schema seam exercises the wiring of the two helpers
    above into a realistic DataFrame. Verifies (a) column order is preserved,
    (b) non-string column labels are stringified, (c) object columns are
    routed through the infer_dtype helper.
    """

    def test_mixed_dtype_dataframe(self):
        from core.runnables.data_processor import DataProcessor

        dp = DataProcessor.__new__(DataProcessor)
        # Every Series must be the same length: pandas aligns DataFrame-from-
        # dict by padding shorter Series with NaN, and "int64" can't hold NaN,
        # which silently promotes int columns to float64. Three rows
        # everywhere keeps every dtype intact while still letting the object
        # columns carry a None.
        df = _pd.DataFrame(
            {
                "i64": _pd.Series([1, 2, 3], dtype="int64"),
                "f64": _pd.Series([1.5, 2.5, 3.5], dtype="float64"),
                "b": _pd.Series([True, False, True], dtype="bool"),
                # pandas nullable Int64 (extension)
                "i64_ext": _pd.Series([1, _pd.NA, 3], dtype="Int64"),
                # object with nulls — pandas infer_dtype sees "integer"
                "obj_int": _pd.Series([10, None, 20], dtype="object"),
                # object with strings
                "obj_str": _pd.Series(["x", None, "y"], dtype="object"),
                # categorical → STRING
                "cat": _pd.Series(["a", "b", "a"], dtype="category"),
            }
        )
        schema = dp._infer_schema_from_dataframe(df)
        assert schema.as_key_value_pairs() == [
            ("i64", AttributeType.LONG),
            ("f64", AttributeType.DOUBLE),
            ("b", AttributeType.BOOL),
            ("i64_ext", AttributeType.LONG),
            ("obj_int", AttributeType.LONG),
            ("obj_str", AttributeType.STRING),
            ("cat", AttributeType.STRING),
        ]

    def test_non_string_column_labels_are_stringified(self):
        # A DataFrame from `pd.read_excel(..., header=None)` has RangeIndex
        # int labels (0, 1, 2…). The inferred schema must carry them as
        # strings so the engine's Schema (str-keyed) stays consistent with
        # downstream Tuple key handling.
        from core.runnables.data_processor import DataProcessor

        dp = DataProcessor.__new__(DataProcessor)
        df = _pd.DataFrame([[1, "a"], [2, "b"]])  # columns: RangeIndex 0,1
        schema = dp._infer_schema_from_dataframe(df)
        names = schema.get_attr_names()
        assert names == ["0", "1"]
        assert all(isinstance(n, str) for n in names)

    def test_duplicate_column_names_dedup_during_inference(self):
        # Caught by the runtime-schema e2e: a DataFrame with two columns
        # both labelled "x" used to crash inference because `df["x"]`
        # returns a DataFrame (not a Series) and DataFrame has no .dtype.
        # Inferred schema must use dedup-aware names ("x", "x.1") so it
        # lines up with the deduped Tuples that Table.as_tuples emits.
        from core.runnables.data_processor import DataProcessor

        dp = DataProcessor.__new__(DataProcessor)
        df = _pd.DataFrame(
            data=_np.array([[1, 100], [2, 200]]),
            columns=["x", "x"],
        )
        schema = dp._infer_schema_from_dataframe(df)
        assert schema.get_attr_names() == ["x", "x.1"]
        # Both columns are int64 — both should be LONG.
        assert schema.as_key_value_pairs() == [
            ("x", AttributeType.LONG),
            ("x.1", AttributeType.LONG),
        ]


# Convenience helpers for the apply-runtime-schema tests below.
def _make_dp_with_empty_port(context):
    """
    Register a single output port with an empty Schema (the "no declared
    columns" case the agent-driven UDF flow uses), so the first DataFrame
    yield will trigger silent port-schema rewrite.
    """
    from core.runnables.data_processor import DataProcessor

    port_id = PortIdentity(id=0, internal=False)
    context.output_manager.add_output_port(port_id, Schema())
    return DataProcessor(context), port_id


def _make_dp_with_declared_port(context, declared: Schema):
    from core.runnables.data_processor import DataProcessor

    port_id = PortIdentity(id=0, internal=False)
    context.output_manager.add_output_port(port_id, declared)
    return DataProcessor(context), port_id


class TestMaybeApplyRuntimeSchema:
    """
    First-yield contract:
      - declared schema empty → silently rewrite port to inferred schema
      - declared schema non-empty & matches → no rewrite
      - declared schema non-empty & mismatches → RuntimeError
    Subsequent yields:
      - never re-infer (no drift error even if dtypes change)
      - stats are still recomputed every yield
    Non-Table yields are no-ops (tuple-yielding operators are not in scope).
    """

    def test_first_yield_with_empty_declared_rewrites_port_schema(self, context):
        dp, _ = _make_dp_with_empty_port(context)
        df = _pd.DataFrame(
            {
                "n": _pd.Series([1, 2], dtype="int64"),
                "s": _pd.Series(["a", "b"], dtype="object"),
            }
        )

        dp._maybe_apply_runtime_schema(df)

        port_schema = context.output_manager.get_port().get_schema()
        assert port_schema.as_key_value_pairs() == [
            ("n", AttributeType.LONG),
            ("s", AttributeType.STRING),
        ]
        assert dp._schema_inferred is True
        # Stats published as part of the same call. Reading the private
        # `_result_statistics` rather than constructing a full WorkerStatistics
        # proto keeps the test focused on the apply-runtime-schema contract.
        assert context.statistics_manager._result_statistics != {}

    def test_first_yield_with_matching_declared_does_not_change_port(self, context):
        declared = Schema()
        declared.add("n", AttributeType.LONG)
        declared.add("s", AttributeType.STRING)
        dp, _ = _make_dp_with_declared_port(context, declared)
        df = _pd.DataFrame(
            {"n": _pd.Series([1, 2], dtype="int64"), "s": ["a", "b"]}
        )

        dp._maybe_apply_runtime_schema(df)

        port_schema = context.output_manager.get_port().get_schema()
        # Same instance — no rewrite happened.
        assert port_schema is declared
        assert dp._schema_inferred is True

    def test_first_yield_with_mismatched_declared_raises(self, context):
        declared = Schema()
        declared.add("n", AttributeType.STRING)  # wrong type vs. inferred LONG
        dp, _ = _make_dp_with_declared_port(context, declared)
        df = _pd.DataFrame({"n": _pd.Series([1, 2], dtype="int64")})

        with pytest.raises(RuntimeError) as excinfo:
            dp._maybe_apply_runtime_schema(df)
        # Both the declared and inferred schemas should appear in the message
        # so the UDF author can see the diff without re-running.
        msg = str(excinfo.value)
        assert "Output schema mismatch" in msg
        assert "declared" in msg
        assert "got" in msg

    def test_second_yield_does_not_reinfer_or_raise_on_drift(self, context):
        # Per the per-yield-but-sticky contract: once schema_inferred is set,
        # later yields with *different* dtypes must NOT raise — they just
        # reuse the cached port schema (which is what the agent renderer
        # rendered from the first yield) and publish fresh column stats.
        dp, _ = _make_dp_with_empty_port(context)
        first = _pd.DataFrame({"x": _pd.Series([1, 2], dtype="int64")})
        dp._maybe_apply_runtime_schema(first)
        port_after_first = context.output_manager.get_port().get_schema()

        # Second yield: same column name but a DIFFERENT dtype (string).
        # Old (sticky-fixed) code would have raised RuntimeError on drift;
        # new (prototype) code must accept it silently.
        second = _pd.DataFrame({"x": ["a", "b"]})
        dp._maybe_apply_runtime_schema(second)

        # Port schema unchanged from after the first yield.
        port_after_second = context.output_manager.get_port().get_schema()
        assert (
            port_after_first.as_key_value_pairs()
            == port_after_second.as_key_value_pairs()
        )

    def test_stats_published_on_every_yield(self, context):
        # Confirms `_publish_column_stats` runs on each yield, not just the
        # first. The agent renderer expects the *most recent* table's stats.
        dp, _ = _make_dp_with_empty_port(context)
        dp._maybe_apply_runtime_schema(
            _pd.DataFrame({"x": _pd.Series([1, 2], dtype="int64")})
        )
        first_stats = dict(context.statistics_manager._result_statistics)
        assert "x" in first_stats

        # Second yield with two non-null + one null. Stats must reflect the
        # new shape (null=1) — overwriting, not appending.
        dp._maybe_apply_runtime_schema(
            _pd.DataFrame(
                {"x": _pd.Series([10, 20, None], dtype="object")}
            )
        )
        second_stats = dict(context.statistics_manager._result_statistics)
        assert second_stats["x"] != first_stats["x"]
        assert "null=1" in second_stats["x"]

    def test_non_dataframe_yield_is_noop(self, context):
        # Tuple-yielding UDFs hit this path (output is e.g. a Tuple, dict, or
        # None). The runtime schema hook must be a complete no-op for them
        # so they continue to flow through `finalize(port.get_schema())`
        # unchanged.
        dp, _ = _make_dp_with_empty_port(context)
        port_schema_before = context.output_manager.get_port().get_schema()

        dp._maybe_apply_runtime_schema(None)
        dp._maybe_apply_runtime_schema({"a": 1, "b": 2})
        dp._maybe_apply_runtime_schema([1, 2, 3])

        assert dp._schema_inferred is False
        assert (
            context.output_manager.get_port().get_schema() is port_schema_before
        )

    def test_duplicate_columns_route_stats_positionally(self, context):
        # Mirror of the runtime-schema e2e duplicate-column case at the
        # stats-publishing seam: `df[name]` returns a DataFrame for a
        # duplicate label, and _compute_column_stats can't take a DataFrame
        # — it would crash with "cannot convert the series to <class 'int'>"
        # at `int(non_null.nunique())`. Iterating positionally + deduping
        # the names keeps every column's stats line valid AND surfaced.
        dp, _ = _make_dp_with_empty_port(context)
        df = _pd.DataFrame(
            data=_np.array([[1, 100], [2, 200], [3, 300]]),
            columns=["x", "x"],
        )
        dp._maybe_apply_runtime_schema(df)

        stats = context.statistics_manager._result_statistics
        # Both columns must surface — under deduped names.
        assert set(stats.keys()) == {"x", "x.1"}
        # Both are int64 → both stats lines start with the numeric prefix.
        assert stats["x"].startswith("(numeric):")
        assert stats["x.1"].startswith("(numeric):")
        # Values differ (1/2/3 vs 100/200/300), so the stats strings differ.
        assert stats["x"] != stats["x.1"]

    def test_pa_table_yield_is_handled_via_to_pandas(self, context):
        # `_to_dataframe` accepts pa.Table; the inference path must still run
        # for the Texera Table model (which proxies to_pandas). Use pyarrow
        # directly here to exercise the second branch of _to_dataframe.
        import pyarrow as pa

        dp, _ = _make_dp_with_empty_port(context)
        tbl = pa.table({"n": pa.array([1, 2, 3], type=pa.int64())})

        dp._maybe_apply_runtime_schema(tbl)

        port_schema = context.output_manager.get_port().get_schema()
        assert port_schema.as_key_value_pairs() == [("n", AttributeType.LONG)]
        assert dp._schema_inferred is True


class TestTableAsTuplesDedup:
    """
    Regression test for the silent-data-loss case the prototype guards
    against and current keeps: `dict(zip(columns, row))` with duplicate
    column names drops every duplicate's value. `Table.as_tuples` must
    dedup column labels (pandas convention: `col`, `col.1`, ...) before
    building each Tuple.
    """

    def test_duplicate_columns_get_deduped_no_silent_drop(self):
        # Build a DataFrame with two physical columns both labelled "x".
        df = _pd.DataFrame(
            data=_np.array([[1, 100], [2, 200], [3, 300]]),
            columns=["x", "x"],
        )
        # Sanity check: both columns are really present.
        assert list(df.columns) == ["x", "x"]
        assert df.shape == (3, 2)

        tuples = list(Table(df).as_tuples())
        assert len(tuples) == 3
        # Each Tuple must carry BOTH values, under distinct names —
        # exactly what `dict(zip(["x", "x"], row))` would silently
        # collapse to one entry without the dedup step.
        first = tuples[0]
        field_names = first.get_field_names()
        assert len(field_names) == 2, f"silent drop: got {field_names!r}"
        assert "x" in field_names
        # pandas rename convention: second occurrence becomes "x.1".
        assert "x.1" in field_names
        # Values preserved in order.
        assert first["x"] == 1
        assert first["x.1"] == 100
        assert tuples[1]["x"] == 2
        assert tuples[1]["x.1"] == 200


class TestComputeColumnStatsTopN:
    """
    Type-conditional top-N rendering in `_compute_column_stats`:

      - numeric/bool low-cardinality columns get `top_10={…}` (numeric)
        or the existing `true=N, false=N` (bool — already covers the
        two-value top).
      - string low-cardinality columns get `top_5={…}` (down from
        `top_10` so longer raw values don't blow the per-cell budget).
      - high-cardinality columns (above the type's cutoff) get no top
        map at all — the long tail isn't informative.
    """

    @staticmethod
    def _stats(col):
        from core.runnables.data_processor import DataProcessor
        return DataProcessor._compute_column_stats(col)

    # ── numeric ──────────────────────────────────────────────────────

    def test_numeric_low_cardinality_emits_top_10(self):
        # Year-like column: 4 distinct values, repeated. Should render the
        # full per-value frequency map alongside mean/min/max.
        col = _pd.Series([2020, 2021, 2021, 2022, 2022, 2022, 2023], dtype="int64")
        line = self._stats(col)
        assert line.startswith("(numeric):")
        assert "mean=" in line and "min=2020" in line and "max=2023" in line
        assert "top_10={" in line
        # All four distinct values present.
        for v in ("2020=1", "2021=2", "2022=3", "2023=1"):
            assert v in line, f"expected {v!r} in: {line}"

    def test_numeric_distinct_exactly_10_still_emits_top_10(self):
        # Boundary case: distinct count == 10 should fire.
        col = _pd.Series(list(range(10)) + [0], dtype="int64")
        line = self._stats(col)
        assert "top_10={" in line

    def test_numeric_distinct_above_10_drops_top_10(self):
        # 11 distinct values — long-tail. Top map is dropped; only
        # mean/min/max remain.
        col = _pd.Series(list(range(11)), dtype="int64")
        line = self._stats(col)
        assert "top_10={" not in line
        assert "mean=" in line and "min=0" in line and "max=10" in line

    def test_numeric_int_values_render_without_decimal(self):
        # Integer-valued floats drop the `.0`. With value_counts the keys
        # are still pandas scalars; the formatter must coerce cleanly.
        col = _pd.Series([1.0, 1.0, 2.0, 3.0], dtype="float64")
        line = self._stats(col)
        assert "top_10={" in line
        # Keys should render as "1", "2", "3" (not "1.0").
        assert "1=2" in line and "2=1" in line and "3=1" in line

    # ── bool ─────────────────────────────────────────────────────────

    def test_bool_renders_true_false_counts_no_top_map(self):
        # Bool already has implicit "top 2" via `true=N, false=N`. Skip
        # adding a top_10 — it would be pure redundancy.
        col = _pd.Series([True, True, False, True], dtype="bool")
        line = self._stats(col)
        assert line.startswith("(bool):")
        assert "true=3" in line and "false=1" in line
        assert "top_10={" not in line
        assert "top_5={" not in line

    # ── string ───────────────────────────────────────────────────────

    def test_string_low_cardinality_emits_top_5_not_top_10(self):
        # ≤5 distinct values: render top_5 (not top_10).
        col = _pd.Series(
            ["gold", "gold", "silver", "silver", "silver", "bronze"],
            dtype="object",
        )
        line = self._stats(col)
        assert line.startswith("(str):")
        assert "distinct=3" in line
        assert "top_5={" in line
        assert "top_10={" not in line
        # The map carries the 3 distinct entries.
        for v in ('"gold"=2', '"silver"=3', '"bronze"=1'):
            assert v in line

    def test_string_distinct_exactly_5_still_emits_top_5(self):
        col = _pd.Series(["a", "b", "c", "d", "e", "a"], dtype="object")
        line = self._stats(col)
        assert "top_5={" in line

    def test_string_distinct_above_5_drops_top_map(self):
        # 6 distinct values — exceeds the str cutoff (5). No top map.
        col = _pd.Series(["a", "b", "c", "d", "e", "f"], dtype="object")
        line = self._stats(col)
        assert "distinct=6" in line
        assert "top_5={" not in line
        assert "top_10={" not in line
