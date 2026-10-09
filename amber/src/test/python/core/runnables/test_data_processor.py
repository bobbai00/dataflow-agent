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
from pytexera.udf.udf_operator import UDFSourceOperator, UDFOperatorV2
from pytexera.udf.udf_multi_table_operator import UDFMultiTableOperator  # noqa: F401


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


class _SourceStub(UDFSourceOperator):
    """Concrete UDFSourceOperator so `_operator_uses_line_locating` treats the
    running operator as a generated DataLoading wrapper → line-locating path."""

    def produce(self):
        yield None


class _RegularUDFStub(UDFOperatorV2):
    """Concrete UDFOperatorV2 standing in for a hand-written PythonUDFV2
    operator → full-traceback path (no user-line locating)."""

    def process_tuple(self, tuple_, port):
        yield None


class TestProcessInternalMarker:
    def test_end_channel_passes_runtime_input_schema_to_table_operator(self, context, data_processor):
        from core.models import Schema
        from core.models.operator import TableOperator
        from proto.org.apache.texera.amber.core import PortIdentity

        class Capture(TableOperator):
            received = None

            def process_table(self, table, port):
                self.received = table
                yield None

        executor = Capture()
        context.executor_manager.executor = executor
        port_id = PortIdentity(id=1, internal=False)
        context.input_manager.add_input_port(port_id, Schema(raw_schema={}), [], [])
        # Dynamic schemas arrive after initialization, including for zero rows.
        context.input_manager.get_port(port_id).set_schema(Schema(raw_schema={"x": "LONG"}))
        context.tuple_processing_manager.current_input_port_id = port_id
        data_processor.process_internal_marker(EndChannel())
        assert executor.received is not None
        assert list(executor.received.columns) == ["x"]
        assert str(executor.received["x"].dtype) == "Int64"

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
        # before ever sending the error to the coordinator.
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
    Line-locating path — exercised when the running operator is a generated
    single-function wrapper (DataProcessing/UDFMultiTableOperator or
    DataLoading/UDFSourceOperator); these tests use a `_SourceStub` executor.
    Hand-written operators (PythonUDFV2) take the full-traceback path instead
    (see TestReportExceptionFullTraceback).

    `_report_exception` builds the ConsoleMessage that SyncExecutionResource
    surfaces to the agent as the operator's `[ERROR]` block. The two
    branches that matter for agent UX:

    1. Traceback contains a user-UDF frame (the "happy" error path: the
       exception was thrown from inside `def load()` / `def process()`).
       → title carries `(line N) `code_line` - ExceptionType: msg`
       → message carries the exception summary plus an
         `at line N in <func>` pointer.

    2. Traceback has NO user-UDF frame — the exception was raised after
       the operator returned (e.g. Texera schema validation rejecting a
       value type). Title + message degrade to the readable exception
       summary (never the deepest-frame `raise TypeError(` line).

    Both branches deliberately omit a multi-frame Python traceback AND
    the operator's source code — the agent-service renders the errored
    operator's code in the assembled context from operatorProperties, so
    echoing it here would double the token cost of every error.
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
    def test_no_udf_frame_reports_exception_summary_only(
        self, context, data_processor, tmp_path, monkeypatch
    ):
        # Simulate the climateMeasurements case: framework validation
        # raises AFTER the operator's def load() returned, so the
        # traceback contains no UDF frame.
        module_name = self._register_fake_udf_module(tmp_path, monkeypatch)
        context.executor_manager.operator_module_name = module_name
        # DataLoading-style operator → line-locating path.
        context.executor_manager.executor = _SourceStub()

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

        # The message is the exception summary alone — the operator's
        # source is NOT echoed (it renders in the agent context instead).
        assert msg.message.startswith("TypeError: Unmatched type for field 'Unnamed: 2'")
        assert "Operator code:" not in msg.message
        assert "The operator's code was:" not in msg.message
        assert "def load() -> pd.DataFrame:" not in msg.message

        # No `>` marker — we don't know the failing line, so we don't
        # pretend to mark one.
        for line in msg.message.splitlines():
            assert not line.lstrip().startswith(">")

        # No multi-frame traceback chain is appended.
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
            # DataLoading-style operator → line-locating path.
            context.executor_manager.executor = _SourceStub()

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
        # ValueError(...)` is line 3 inside the user code.
        assert "(line 3)" in msg.title
        assert "ValueError: boom-from-load" in msg.title
        # The failing line's TEXT rides in the title.
        assert "raise ValueError('boom-from-load')" in msg.title

        # Message = exception summary + user-code line pointer. The
        # operator's source is NOT echoed (agent context renders it).
        assert "ValueError: boom-from-load" in msg.message
        assert "at line 3 in `load`" in msg.message
        assert "Operator code:" not in msg.message
        assert "> 3 |" not in msg.message
        # No multi-frame traceback, no neutral-header phrasing.
        assert "Traceback (most recent call last):" not in msg.message
        assert "An execution error happened while running the operator" not in msg.message

    @pytest.mark.timeout(2)
    def test_no_udf_frame_and_no_module_falls_back_gracefully(
        self, context, data_processor
    ):
        # No executor_manager.operator_module_name → source recovery
        # returns None and we emit just the exception summary.
        # DataLoading-style operator → line-locating path.
        context.executor_manager.executor = _SourceStub()
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


class TestReportExceptionFullTraceback:
    """
    Full-traceback path — exercised for hand-written operators (PythonUDFV2 /
    UDFOperatorV2), which are NOT generated single-function wrappers. Here
    `_report_exception` skips user-line locating and hands back the complete
    multi-frame Python traceback. The operator's source is NOT echoed (the
    agent-service renders it in the assembled context).
    """

    _UDF_SOURCE = (
        "from pytexera import *\n"
        "\n"
        "class MyOperator(UDFOperatorV2):\n"
        "    def process_tuple(self, tuple_, port):\n"
        "        raise ValueError('boom-from-process')\n"
    )

    @pytest.mark.timeout(2)
    def test_regular_operator_gets_full_traceback(
        self, context, data_processor, tmp_path, monkeypatch
    ):
        module_name = "udf-vREGULAR"
        file_path = tmp_path / f"{module_name}.py"
        file_path.write_text(self._UDF_SOURCE)
        fake_mod = types.ModuleType(module_name)
        fake_mod.__file__ = str(file_path)
        monkeypatch.setitem(sys.modules, module_name, fake_mod)
        context.executor_manager.operator_module_name = module_name
        # Hand-written PythonUDFV2 operator → full-traceback path.
        context.executor_manager.executor = _RegularUDFStub()

        with data_processor._executor_session():
            raise ValueError("boom-from-process")

        msgs = list(context.console_message_manager.get_messages(force_flush=True))
        assert len(msgs) == 1
        msg = msgs[0]
        assert msg.msg_type == ConsoleMessageType.ERROR

        # Title is the plain exception summary — no fabricated `(line N)`.
        assert msg.title == "ValueError: boom-from-process"
        assert "(line" not in msg.title

        # The full multi-frame traceback IS included — the defining contrast
        # with the line-locating path, which omits it.
        assert "Traceback (most recent call last):" in msg.message
        # The operator's source is NOT echoed (agent context renders it).
        assert "Operator code:" not in msg.message
        assert "class MyOperator(UDFOperatorV2):" not in msg.message

        # No user-relative `>` line marker — we don't pin a single user line.
        for line in msg.message.splitlines():
            assert not line.lstrip().startswith(">")


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

    def test_bridges_nullable_int_arriving_as_float(self, context):
        # The reported failure mode: an integer column carrying nulls
        # round-trips through pandas as float64 (DOUBLE), because pandas int64
        # cannot hold NaN. Declared LONG must NOT raise — cast_to_schema
        # bridges DOUBLE→LONG (NaN→None) downstream, so the declared schema
        # stands unchanged.
        declared = Schema()
        declared.add("releaseYear", AttributeType.LONG)
        dp, _ = _make_dp_with_declared_port(context, declared)
        df = _pd.DataFrame(
            {"releaseYear": _pd.Series([1995.0, _np.nan, 2001.0], dtype="float64")}
        )

        dp._maybe_apply_runtime_schema(df)  # must not raise

        port_schema = context.output_manager.get_port().get_schema()
        assert port_schema is declared  # authoritative; not rewritten
        assert dp._schema_inferred is True

    def test_does_not_bridge_fractional_float_declared_as_int(self, context):
        # Genuinely fractional data declared as an integer is a real UDF
        # contract violation — must still raise.
        declared = Schema()
        declared.add("score", AttributeType.LONG)
        dp, _ = _make_dp_with_declared_port(context, declared)
        df = _pd.DataFrame({"score": _pd.Series([1.5, 2.25], dtype="float64")})

        with pytest.raises(RuntimeError) as excinfo:
            dp._maybe_apply_runtime_schema(df)
        assert "Output schema mismatch" in str(excinfo.value)

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

    # ── container-cell columns: type as (list) / (struct), shape stats ─

    def test_ndarray_column_types_as_list_with_items_stats(self):
        """
        Regression: a real agent failure observed in production —
        ``_compute_column_stats`` crashed with ``TypeError: unhashable
        type: 'numpy.ndarray'`` because the original str-branch called
        ``int(non_null.nunique())`` without try/except, and a UDF
        returned an object-dtype column whose cells are numpy arrays.
        Pin two behaviors at once: (a) no crash, (b) the column types as
        ``(list)`` with items-per-cell shape stats — NOT ``(str)`` with
        meaningless top_5 of stringified arrays. Top-N frequency on
        container cells is misleading (``[a,b]`` and ``[b,a]`` would
        register as different "categories") and the stringified keys
        blow the per-cell budget on any non-trivial dataset.
        """
        col = _pd.Series(
            [
                _np.array(["Full Suppression", "Other"], dtype=object),
                _np.array(["Full Suppression", "Other"], dtype=object),
                _np.array(["Other"], dtype=object),
            ],
            dtype="object",
        )
        line = self._stats(col)  # must not raise
        assert line.startswith("(list):"), line
        # Element counts are 2, 2, 1 → min=1, max=2, mean=1.67.
        assert "items_min=1" in line, line
        assert "items_max=2" in line, line
        assert "items_mean=" in line, line
        # Crucially: no top_N frequency map and no `distinct=…` — the
        # column is typed as list, not stringified-str.
        assert "top_5={" not in line, line
        assert "top_10={" not in line, line
        assert "distinct=" not in line, line

    def test_list_column_types_as_list(self):
        """
        Plain Python list cells get the same treatment as ndarrays:
        ``(list)`` typing with items_min/max/mean — no top_N and no
        distinct count.
        """
        col = _pd.Series(
            [["a", "b"], ["a", "b"], ["c"]],
            dtype="object",
        )
        line = self._stats(col)
        assert line.startswith("(list):"), line
        assert "items_min=1" in line, line
        assert "items_max=2" in line, line
        assert "top_5={" not in line, line
        assert "distinct=" not in line, line

    def test_dict_column_types_as_struct_minimal_stats(self):
        """
        ``dict`` cells are STRUCT-shaped; type label is ``(struct)``.
        Unlike LIST, STRUCT emits ONLY ``null=N`` — no items_min/max/mean,
        no top_N, no distinct. Dict-keys-per-cell is rarely useful as a
        planning signal; the stable key set lives downstream in the
        columns surfaced via explode/normalize, not in a stats summary.
        """
        col = _pd.Series(
            [{"k": 1, "v": 2}, {"k": 3}, {"k": 4, "v": 5, "w": 6}],
            dtype="object",
        )
        line = self._stats(col)
        assert line.startswith("(struct):"), line
        # Only null=N — nothing else.
        assert "null=0" in line, line
        # No item-shape stats — distinguishes STRUCT from LIST here.
        assert "items_min=" not in line, line
        assert "items_max=" not in line, line
        assert "items_mean=" not in line, line
        # No top_N or distinct either.
        assert "top_5={" not in line, line
        assert "top_10={" not in line, line
        assert "distinct=" not in line, line
        # The full line should be exactly the type label + null count.
        assert line == "(struct): null=0", line

    def test_struct_with_null_cells_reports_null_count(self):
        """STRUCT branch must still surface null=N correctly."""
        col = _pd.Series(
            [{"k": 1}, None, {"k": 2}, None],
            dtype="object",
        )
        line = self._stats(col)
        assert line.startswith("(struct):"), line
        assert "null=2" in line, line

    def test_struct_with_nested_dict_cells_does_not_recurse(self):
        """
        A dict whose values are themselves dicts (or lists) is still
        typed as STRUCT — we don't try to summarize the inner shape.
        Sample-based detection looks at the top-level cell type only.
        """
        col = _pd.Series(
            [
                {"outer": {"inner": 1}, "tags": ["a", "b"]},
                {"outer": {"inner": 2}, "tags": ["c"]},
            ],
            dtype="object",
        )
        line = self._stats(col)
        assert line == "(struct): null=0", line

    def test_struct_with_empty_dict_cells(self):
        """Empty dicts count as STRUCT cells (not as null)."""
        col = _pd.Series([{}, {}, {"k": 1}], dtype="object")
        line = self._stats(col)
        assert line == "(struct): null=0", line

    def test_struct_column_all_nulls_falls_back_to_str(self):
        """
        An all-null object column has no non-null sample to inspect, so
        ``_is_container_column`` can't classify it as a container. It
        falls through to the str fallback (which is the right behavior:
        we don't know what type a future cell will be).
        """
        col = _pd.Series([None, None, None], dtype="object")
        line = self._stats(col)
        assert line.startswith("(str):"), line
        assert "null=3" in line, line

    def test_tuple_column_types_as_list(self):
        """Tuples count as list-shaped (no separate (tuple) label)."""
        col = _pd.Series(
            [("a", "b"), ("c",)],
            dtype="object",
        )
        line = self._stats(col)
        assert line.startswith("(list):"), line
        assert "items_min=1" in line, line
        assert "items_max=2" in line, line

    def test_mixed_container_column_does_not_route_to_list(self):
        """
        Defensive: a pathological column where some cells are scalar
        (strings) and others are containers must NOT be misclassified as
        (list). The sample check requires every sampled cell to be a
        container; mixed columns fall through to the str fallback so
        the engine still emits SOMETHING usable for the agent.
        """
        col = _pd.Series(
            ["scalar", ["a", "b"], "other"],
            dtype="object",
        )
        line = self._stats(col)
        assert line.startswith("(str):"), line

    # ── (binary) branch: pickled-object columns surface the Python type ──

    def test_binary_column_with_shapely_polygons_surfaces_type(self):
        """
        End-to-end: a column whose cells are pickled-object payloads
        written by ``_encode_pickled_object`` (the BINARY-pickle write
        path) must render as ``(binary): null=N, type=<Class>,
        size_min/max/mean=…`` — the agent sees what kind of Python
        object the column holds without the engine layer's `pickle`
        terminology leaking through.
        """
        from shapely.geometry import Polygon

        from core.models.tuple import _encode_pickled_object

        encoded = [
            _encode_pickled_object(Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])),
            _encode_pickled_object(Polygon([(0, 0), (2, 0), (2, 2), (0, 2)])),
            _encode_pickled_object(Polygon([(0, 0), (3, 0), (3, 3), (0, 3)])),
        ]
        col = _pd.Series(encoded, dtype="object")
        line = self._stats(col)
        assert line.startswith("(binary):"), line
        assert "null=0" in line, line
        assert "type=shapely.geometry.polygon.Polygon" in line, line
        # Size shape must be present and self-consistent (size_mean is the
        # numeric mean of size_min..size_max).
        assert "size_min=" in line, line
        assert "size_max=" in line, line
        assert "size_mean=" in line, line
        # No agent-facing leakage of "pickle" terminology.
        assert "pickle" not in line.lower(), line
        # No top_N / distinct decorations from the str branch.
        assert "top_5=" not in line, line
        assert "top_10=" not in line, line
        assert "distinct=" not in line, line

    def test_binary_column_with_raw_bytes_omits_type(self):
        """
        Raw bytes cells (no pickled-object marker) get the size stats
        but no ``type=`` field — there is no Python class to surface.
        """
        col = _pd.Series(
            [b"\x00\x01\x02", b"\x03\x04", b"\x05\x06\x07\x08"],
            dtype="object",
        )
        line = self._stats(col)
        assert line.startswith("(binary):"), line
        assert "null=0" in line, line
        assert "type=" not in line, line
        assert "size_min=2" in line, line
        assert "size_max=4" in line, line
        assert "size_mean=3" in line, line

    def test_binary_column_with_legacy_pickle_marker_omits_type(self):
        """
        Legacy ``pickle    `` payloads carry no class-name header, so
        ``type=`` must be silent (we don't unpickle just to discover
        the type — too expensive on every cell).
        """
        import pickle

        from shapely.geometry import Polygon

        legacy_cells = [
            b"pickle    " + pickle.dumps(Polygon([(0, 0), (1, 1), (2, 2)])),
            b"pickle    " + pickle.dumps(Polygon([(3, 3), (4, 4), (5, 5)])),
        ]
        col = _pd.Series(legacy_cells, dtype="object")
        line = self._stats(col)
        assert line.startswith("(binary):"), line
        assert "type=" not in line, line
        assert "size_min=" in line, line
        assert "size_max=" in line, line

    def test_binary_column_with_null_cells_interleaved(self):
        """`null=N` must be correct when binary cells are mixed with None."""
        col = _pd.Series(
            [b"\x00\x01", None, b"\x02\x03\x04", None],
            dtype="object",
        )
        line = self._stats(col)
        assert line.startswith("(binary):"), line
        assert "null=2" in line, line

    def test_binary_column_all_null_falls_back_to_str(self):
        """
        Symmetric with the list/struct branch: an all-null object
        column has no non-null sample to inspect, so we can't classify
        it as binary. Falls through to (str) just like list/struct.
        """
        col = _pd.Series([None, None, None], dtype="object")
        line = self._stats(col)
        assert line.startswith("(str):"), line
        assert "null=3" in line, line

    def test_binary_class_branch_fires_on_pre_cast_shapely_polygons(self):
        """
        Critical: column-stats run on the DataFrame BEFORE
        cast_to_schema converts Polygon cells to bytes. The bytes
        branch can't fire here (cells are still Polygon objects), so
        the `_is_binary_class_column` branch must catch them and emit
        ``(binary): null=N, type=shapely.geometry.polygon.Polygon``.
        Without this fix the column would type as `(str)` and the
        agent would see a misleading top_5 of stringified polygons.
        """
        from shapely.geometry import Polygon

        col = _pd.Series(
            [
                Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]),
                Polygon([(0, 0), (2, 0), (2, 2), (0, 2)]),
                Polygon([(0, 0), (3, 0), (3, 3), (0, 3)]),
            ],
            dtype="object",
        )
        line = self._stats(col)
        assert line.startswith("(binary):"), line
        assert "null=0" in line, line
        assert "type=shapely.geometry.polygon.Polygon" in line, line
        # No top_N, no distinct — and no "pickle" terminology.
        assert "top_5=" not in line, line
        assert "distinct=" not in line, line
        assert "pickle" not in line.lower(), line

    def test_binary_class_branch_does_not_fire_on_str_column(self):
        """
        The binary-class branch must NOT misclassify a plain string
        column as `(binary)`. str cells are explicitly excluded from
        ``_is_binary_class_column``'s primitive-type filter.
        """
        col = _pd.Series(["alpha", "beta", "gamma"], dtype="object")
        line = self._stats(col)
        assert line.startswith("(str):"), line

    def test_binary_class_branch_skips_numpy_and_pandas_classes(self):
        """
        Numpy scalars and pandas classes have their own rendering paths
        (numeric / datetime branches kick in once the column has the
        right dtype). When they show up as object-dtype object cells,
        we still don't want to route them through (binary) — that'd be
        misleading. ``_is_binary_class_column`` excludes the numpy and
        pandas namespaces explicitly.
        """
        # numpy scalar in an object column
        col = _pd.Series([_np.int64(1), _np.int64(2), _np.int64(3)], dtype="object")
        line = self._stats(col)
        # Falls through to numeric/str — NOT (binary).
        assert not line.startswith("(binary):"), line

    def test_binary_class_branch_requires_homogeneous_type(self):
        """
        Mixed non-primitive classes (e.g. one Polygon and one Point)
        in the same column must NOT collapse to a single `type=` —
        ``_is_binary_class_column`` requires every sampled cell to be
        the same class. Mixed columns fall through to the str branch.
        """
        from shapely.geometry import Polygon, Point

        col = _pd.Series(
            [
                Polygon([(0, 0), (1, 0), (1, 1)]),
                Point(0, 0),
                Polygon([(0, 0), (2, 0), (2, 2)]),
            ],
            dtype="object",
        )
        line = self._stats(col)
        assert line.startswith("(str):"), line


class TestDetectTableStructure:
    """Structural observations, without semantic key/eligibility heuristics."""

    @staticmethod
    def _hints(df):
        return DataProcessor._detect_table_structure(df)

    def test_empty_rows_and_cols(self):
        df = _pd.DataFrame({"a": [1, None, 3], "b": [None, None, None]})
        hints = self._hints(df)
        assert "empty rows: 1 of 3 rows are entirely null" in hints
        assert 'empty columns: ["b"] are entirely null' in hints

    def test_duplicate_rows(self):
        df = _pd.DataFrame({"a": [1, 1, 1, 1], "b": ["x", "x", "x", "x"]})
        hints = self._hints(df)
        assert hints == ["duplicate rows: 3 of 4 (75%)"]

    def test_unique_column_does_not_claim_a_semantic_key(self):
        df = _pd.DataFrame({"id": list(range(10)), "v": [1] * 10})
        hints = self._hints(df)
        assert hints == []

    def test_binary_column_does_not_claim_an_eligibility_gate(self):
        df = _pd.DataFrame({"excluded": (["No"] * 8) + (["Yes"] * 2), "x": list(range(10))})
        hints = self._hints(df)
        assert hints == []

    def test_header_observation_identifies_partially_unnamed_columns(self):
        df = _pd.DataFrame({"real": [1, 2, 3], "Unnamed: 1": [4, 5, 6], "Unnamed: 2": [7, 8, 9]})
        hints = self._hints(df)
        hdr = [h for h in hints if h.startswith("headers:")]
        assert hdr, hints
        assert '2 of 3 columns are unnamed ("Unnamed: 1", "Unnamed: 2")' in hdr[0], hdr
        assert "skiprows=" not in hdr[0] and "header=" not in hdr[0], hdr

    def test_header_hint_silent_when_no_placeholders(self):
        df = _pd.DataFrame({"a": [1, 2, 3], "b": [4, 5, 6]})
        assert not any(h.startswith("headers:") for h in self._hints(df)), self._hints(df)

    def test_header_hint_silent_when_all_placeholders(self):
        # A fully headerless frame may be a deliberate header=None read; this
        # observation only distinguishes partially unresolved headers.
        df = _pd.DataFrame({"Unnamed: 0": [1, 2, 3], "Unnamed: 1": [4, 5, 6]})
        assert not any(h.startswith("headers:") for h in self._hints(df)), self._hints(df)

    def test_placeholder_cols_excluded_from_grain_partition(self):
        # Unnamed columns must NOT appear in key/partition output (they are
        # dropped from those, even though the header hint counts them).
        df = _pd.DataFrame({"Unnamed: 0": list(range(10)), "real": [1] * 10})
        hints = self._hints(df)
        assert not any("Unnamed" in h for h in hints if h.startswith(("key:", "partition:", "groups:"))), hints

    def test_empty_frame_returns_no_hints(self):
        assert self._hints(_pd.DataFrame()) == []


def test_any_pandas_string_dtype_maps_to_string_not_binary():
    # 2026-09-29: a shared-environment pandas change gave text columns a
    # string dtype this map did not name, and every cell was pickled.
    import pandas

    from core.models.schema.attribute_type import AttributeType
    from core.runnables.data_processor import DataProcessor

    for dtype in (pandas.StringDtype(), pandas.StringDtype("pyarrow")):
        assert DataProcessor._map_pandas_dtype_to_attribute_type(dtype) == AttributeType.STRING
