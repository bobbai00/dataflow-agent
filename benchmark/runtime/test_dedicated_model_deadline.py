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
"""A dedicated thread-targeted deadline must not take ownership of SIGALRM."""

import signal
import linecache
import sys
import threading
import time

import pytest

from benchmark.runtime import model_deadline as module
from benchmark.runtime.model_deadline import ModelRequestTimeoutError, model_call_deadline

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="Linux main-thread signal deadline")


def test_parent_handler_and_timer_remain_untouched_inside_model_call():
    previous, timer = signal.getsignal(signal.SIGALRM), signal.getitimer(signal.ITIMER_REAL)

    def parent(signum, frame):
        raise AssertionError("later parent must not expire")

    signal.signal(signal.SIGALRM, parent)
    signal.setitimer(signal.ITIMER_REAL, 0.5)
    try:
        with model_call_deadline(0.1) as metadata:
            assert signal.getsignal(signal.SIGALRM) is parent
            assert signal.getitimer(signal.ITIMER_REAL)[0] > 0.3
            assert metadata["method"] == "linux_main_thread_pthread_signal_watchdog_elapsed_deadline"
            assert metadata["signal_number"] != signal.SIGALRM
            assert metadata["target_thread"] == "main_thread"
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
        signal.setitimer(signal.ITIMER_REAL, *timer)


def test_watchdog_targets_only_the_main_thread(monkeypatch):
    original = signal.pthread_kill
    targets = []

    def captured(target, number):
        if number:
            targets.append((target, number))
        return original(target, number)

    monkeypatch.setattr(signal, "pthread_kill", captured)
    with pytest.raises(ModelRequestTimeoutError):
        with model_call_deadline(0.02) as metadata:
            time.sleep(0.1)
    assert targets == [(threading.main_thread().ident, metadata["signal_number"])]


@pytest.mark.parametrize("body_error", [False, True])
def test_success_and_body_error_leave_no_watchdog_or_reserved_handler(body_error):
    before_mask = signal.pthread_sigmask(signal.SIG_BLOCK, [])
    try:
        with model_call_deadline(0.1) as metadata:
            if body_error:
                raise ValueError("original body error")
    except ValueError as error:
        assert body_error and str(error) == "original body error"
    assert signal.getsignal(metadata["signal_number"]) == signal.SIG_DFL
    assert signal.pthread_sigmask(signal.SIG_BLOCK, []) == before_mask
    assert not [thread for thread in threading.enumerate() if thread.name.startswith("model-request-deadline-")]


def test_nested_calls_reserve_distinct_signals_and_earlier_outer_deadline_wins():
    with pytest.raises(ModelRequestTimeoutError) as error:
        with model_call_deadline(0.025) as outer:
            with model_call_deadline(0.2) as inner:
                assert outer["signal_number"] != inner["signal_number"]
                time.sleep(0.3)
    assert error.value.timeout_seconds == 0.025
    for metadata in (inner, outer):
        assert signal.getsignal(metadata["signal_number"]) == signal.SIG_DFL


def test_reserved_signal_conflict_fails_before_model_body(monkeypatch):
    reserved = signal.SIGRTMIN
    previous = signal.getsignal(reserved)
    signal.signal(reserved, lambda *args: None)
    monkeypatch.setattr(module, "_DEADLINE_SIGNALS", (reserved,), raising=False)
    try:
        called = False
        with pytest.raises(RuntimeError, match="unused.*signal"):
            with model_call_deadline(0.1):
                called = True
        assert called is False
    finally:
        signal.signal(reserved, previous)


def test_pending_main_thread_alarm_is_drained_before_reserved_handler_restore(monkeypatch):
    original = signal.pthread_sigmask
    selected = None
    masks = 0

    def delayed_close_mask(how, mask):
        nonlocal masks
        before = original(how, mask)
        if selected is not None and how == signal.SIG_BLOCK and set(mask) == {selected}:
            masks += 1
            if masks == 1:
                time.sleep(0.04)  # Watchdog queues its targeted signal while main is blocked.
        return before

    monkeypatch.setattr(signal, "pthread_sigmask", delayed_close_mask)
    with pytest.raises(ModelRequestTimeoutError):
        with model_call_deadline(0.02) as metadata:
            selected = metadata["signal_number"]
    assert signal.getsignal(selected) == signal.SIG_DFL
    assert selected not in signal.sigpending()


def test_watchdog_is_joined_before_restoring_reserved_signal_handler(monkeypatch):
    original = signal.signal
    selected = None
    restored = []

    def verify_restore(number, handler):
        if selected == number and handler == signal.SIG_DFL:
            assert not [thread for thread in threading.enumerate() if thread.name.startswith("model-request-deadline-")]
            restored.append(number)
        return original(number, handler)

    monkeypatch.setattr(signal, "signal", verify_restore)
    with model_call_deadline(0.1) as metadata:
        selected = metadata["signal_number"]
    assert restored == [selected]


@pytest.mark.parametrize(
    "boundary", ["first_cancel", "second_cancel", "join", "first_mask", "final_mask", "drain", "handler_restore"]
)
def test_parent_exception_during_teardown_completes_signal_and_watchdog_cleanup(monkeypatch, boundary):
    class ParentDeadline(Exception):
        pass

    parent_handler, parent_timer = signal.getsignal(signal.SIGALRM), signal.getitimer(signal.ITIMER_REAL)
    initial_mask = signal.pthread_sigmask(signal.SIG_BLOCK, [])
    timer = None
    reserved = None

    def parent(*args):
        raise ParentDeadline("parent teardown deadline")

    signal.signal(signal.SIGALRM, parent)
    try:
        with pytest.raises(ParentDeadline):
            with model_call_deadline(0.2) as metadata:
                reserved = metadata["signal_number"]
                timer = signal.getsignal(reserved).__self__
                delayed = False
                count = 0

                def delay_once():
                    nonlocal delayed
                    if not delayed:
                        delayed = True
                        time.sleep(0.05)

                if boundary in ("first_cancel", "second_cancel"):
                    original = timer.cancel.set

                    def cancel():
                        nonlocal count
                        count += 1
                        if count == (1 if boundary == "first_cancel" else 2):
                            delay_once()
                        return original()

                    monkeypatch.setattr(timer.cancel, "set", cancel)
                elif boundary == "join":
                    original = timer.watchdog.join

                    def join(*args, **kwargs):
                        delay_once()
                        return original(*args, **kwargs)

                    monkeypatch.setattr(timer.watchdog, "join", join)
                elif boundary in ("first_mask", "final_mask"):
                    original = signal.pthread_sigmask

                    def mask(how, numbers):
                        nonlocal count
                        result = original(how, numbers)
                        if how == signal.SIG_BLOCK and reserved in numbers:
                            count += 1
                            if count == (1 if boundary == "first_mask" else 2):
                                delay_once()
                        return result

                    monkeypatch.setattr(signal, "pthread_sigmask", mask)
                elif boundary == "drain":
                    original = signal.sigtimedwait

                    def drain(numbers, timeout):
                        if reserved in numbers:
                            delay_once()
                        return original(numbers, timeout)

                    monkeypatch.setattr(signal, "sigtimedwait", drain)
                else:
                    original = signal.signal

                    def handler(number, value):
                        if number == reserved and value == signal.SIG_DFL:
                            delay_once()
                        return original(number, value)

                    monkeypatch.setattr(signal, "signal", handler)
                signal.setitimer(signal.ITIMER_REAL, 0.015)
        assert signal.getsignal(reserved) == signal.SIG_DFL
        assert signal.pthread_sigmask(signal.SIG_BLOCK, []) == initial_mask
        assert not timer.watchdog.is_alive()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if timer:
            timer.cancel.set()
            timer.watchdog.join()
        if reserved is not None:
            signal.signal(reserved, signal.SIG_DFL)
        signal.pthread_sigmask(signal.SIG_SETMASK, initial_mask)
        signal.signal(signal.SIGALRM, parent_handler)
        signal.setitimer(signal.ITIMER_REAL, *parent_timer)


@pytest.mark.parametrize("error_kind", ["parent", "body"])
def test_later_cleanup_model_alarm_cannot_mask_an_active_exception(monkeypatch, error_kind):
    class ParentDeadline(Exception):
        pass

    previous = signal.getsignal(signal.SIGALRM)
    timer = None
    reserved = None

    def parent(*args):
        raise ParentDeadline("earlier parent")

    signal.signal(signal.SIGALRM, parent)
    try:
        with pytest.raises(ParentDeadline if error_kind == "parent" else ValueError):
            with model_call_deadline(0.03) as metadata:
                reserved = metadata["signal_number"]
                timer = signal.getsignal(reserved).__self__
                original = timer.cancel.set
                delayed = False

                def cancel():
                    nonlocal delayed
                    if not delayed:
                        delayed = True
                        time.sleep(0.04)
                    return original()

                monkeypatch.setattr(timer.cancel, "set", cancel)
                if error_kind == "body":
                    raise ValueError("original body error")
                signal.setitimer(signal.ITIMER_REAL, 0.015)
                time.sleep(0.2)
        assert signal.getsignal(reserved) == signal.SIG_DFL
        assert not timer.watchdog.is_alive()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if timer:
            timer.cancel.set()
            timer.watchdog.join()
        if reserved is not None:
            signal.signal(reserved, signal.SIG_DFL)
        signal.signal(signal.SIGALRM, previous)


def test_outer_deadline_during_inner_error_cleanup_cannot_be_consumed(monkeypatch):
    with pytest.raises(ModelRequestTimeoutError) as caught:
        with model_call_deadline(0.03):
            try:
                with model_call_deadline(0.2) as inner:
                    timer = signal.getsignal(inner["signal_number"]).__self__
                    original = timer.cancel.set
                    delayed = False

                    def cancel():
                        nonlocal delayed
                        if not delayed:
                            delayed = True
                            time.sleep(0.04)
                        return original()

                    monkeypatch.setattr(timer.cancel, "set", cancel)
                    raise ValueError("inner body error")
            except ValueError:
                time.sleep(0.08)  # Catching a body error cannot consume the outer deadline.
    assert caught.value.timeout_seconds == 0.03


def test_real_model_alarm_at_context_finalizer_entry_still_cleans_reserved_signal():
    previous = sys.gettrace()
    delayed = False

    def trace(frame, event, argument):
        nonlocal delayed
        if (
            event == "line"
            and frame.f_code.co_name == "model_call_deadline"
            and linecache.getline(frame.f_code.co_filename, frame.f_lineno).strip() == "if timer.installed:"
            and not delayed
        ):
            delayed = True
            time.sleep(0.04)
        return trace

    try:
        sys.settrace(trace)
        with pytest.raises(ModelRequestTimeoutError):
            with model_call_deadline(0.02) as metadata:
                pass
    finally:
        sys.settrace(previous)
    assert signal.getsignal(metadata["signal_number"]) == signal.SIG_DFL
    assert not [thread for thread in threading.enumerate() if thread.name.startswith("model-request-deadline-")]


def test_kernel_caught_disposition_cannot_be_overwritten_when_python_cache_reports_default(monkeypatch):
    reserved = signal.SIGRTMIN
    assert signal.getsignal(reserved) == signal.SIG_DFL
    monkeypatch.setattr(module, "_DEADLINE_SIGNALS", (reserved,))
    monkeypatch.setattr(module, "_kernel_signal_dispositions", lambda: 1 << (reserved - 1), raising=False)
    with pytest.raises(RuntimeError, match="unused.*signal"):
        with model_call_deadline(0.1):
            raise AssertionError("model must not start with a kernel-owned signal")


def test_unavailable_kernel_disposition_fails_before_inference(monkeypatch):
    monkeypatch.setattr(module.Path, "read_text", lambda path: "Name:\toffline\n")
    with pytest.raises(RuntimeError, match="Cannot verify kernel signal dispositions"):
        with model_call_deadline(0.1):
            raise AssertionError("model must not start without kernel conflict evidence")
