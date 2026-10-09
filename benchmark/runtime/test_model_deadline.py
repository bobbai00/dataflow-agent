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
"""A call deadline must not replace or extend an earlier task deadline."""

from concurrent.futures import ThreadPoolExecutor
import signal
import sys
import time

import pytest

from benchmark.runtime.model_deadline import ModelRequestTimeoutError, model_call_deadline, validate_deadline_support

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="POSIX Linux deadline implementation")


@pytest.fixture(autouse=True)
def restore_alarm():
    handler, timer = signal.getsignal(signal.SIGALRM), signal.getitimer(signal.ITIMER_REAL)
    signal.setitimer(signal.ITIMER_REAL, 0)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        signal.setitimer(signal.ITIMER_REAL, *timer)


def test_dribbling_model_activity_cannot_extend_absolute_deadline():
    chunks = []
    started = time.monotonic()
    with pytest.raises(ModelRequestTimeoutError) as caught:
        with model_call_deadline(0.08):
            # Each chunk arrives before a 0.05s inactivity timeout, but total exceeds 0.08s.
            while time.monotonic() - started < 0.35:
                time.sleep(0.02)
                chunks.append(time.monotonic())
    assert caught.value.timeout_seconds == 0.08
    assert len(chunks) >= 2
    assert time.monotonic() - started < 0.3


@pytest.mark.parametrize("raise_error", [False, True])
def test_success_and_exception_restore_original_handler_and_remaining_task_time(raise_error):
    def original(signum, frame):
        raise AssertionError("parent should not expire during this call")

    signal.signal(signal.SIGALRM, original)
    signal.setitimer(signal.ITIMER_REAL, 0.5)
    before = signal.getitimer(signal.ITIMER_REAL)[0]
    started = time.monotonic()
    try:
        with model_call_deadline(0.2):
            time.sleep(0.025)
            if raise_error:
                raise ValueError("original error")
    except ValueError as error:
        assert raise_error and str(error) == "original error"
    remaining = signal.getitimer(signal.ITIMER_REAL)[0]
    assert signal.getsignal(signal.SIGALRM) is original
    assert 0 < remaining <= before - (time.monotonic() - started) + 0.005
    assert remaining < before - 0.015


def test_earlier_parent_deadline_forwards_original_exception_without_model_timeout():
    class ParentDeadline(Exception):
        pass

    def parent(signum, frame):
        raise ParentDeadline("task expired first")

    signal.signal(signal.SIGALRM, parent)
    signal.setitimer(signal.ITIMER_REAL, 0.025)
    with pytest.raises(ParentDeadline, match="task expired first"):
        with model_call_deadline(0.2):
            time.sleep(0.35)
    assert signal.getsignal(signal.SIGALRM) is parent
    assert signal.getitimer(signal.ITIMER_REAL)[0] == 0


def test_nested_later_deadline_cannot_mask_earlier_outer_model_timeout():
    with pytest.raises(ModelRequestTimeoutError) as caught:
        with model_call_deadline(0.025):
            with model_call_deadline(0.2):
                time.sleep(0.3)
    assert caught.value.timeout_seconds == 0.025
    assert signal.getitimer(signal.ITIMER_REAL)[0] == 0


def test_nested_shorter_deadline_does_not_extend_outer_elapsed_budget():
    started = time.monotonic()
    with pytest.raises(ModelRequestTimeoutError) as outer:
        with model_call_deadline(0.1):
            with pytest.raises(ModelRequestTimeoutError) as inner:
                with model_call_deadline(0.025):
                    time.sleep(0.3)
            assert inner.value.timeout_seconds == 0.025
            time.sleep(0.3)
    assert outer.value.timeout_seconds == 0.1
    assert time.monotonic() - started < 0.12


def test_unsupported_thread_or_platform_fails_before_model_callable(monkeypatch):
    with ThreadPoolExecutor(max_workers=1) as executor:
        with pytest.raises(RuntimeError, match="main thread"):
            executor.submit(validate_deadline_support).result()
    monkeypatch.setattr("benchmark.runtime.model_deadline.sys.platform", "win32")
    called = False
    with pytest.raises(RuntimeError, match="Linux"):
        with model_call_deadline(0.1):
            called = True
    assert called is False


def test_periodic_parent_timer_keeps_original_handler_and_schedule():
    ticks = []

    def parent(signum, frame):
        ticks.append(time.monotonic())

    signal.signal(signal.SIGALRM, parent)
    signal.setitimer(signal.ITIMER_REAL, 0.015, 0.03)
    with model_call_deadline(0.2):
        time.sleep(0.075)
    remaining, interval = signal.getitimer(signal.ITIMER_REAL)
    assert len(ticks) >= 2
    assert 0 < remaining <= 0.03
    assert interval == 0.03
    assert signal.getsignal(signal.SIGALRM) is parent


def test_blocked_task_alarm_fails_closed_before_model_body():
    mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM})
    try:
        with pytest.raises(RuntimeError, match="unblocked SIGALRM"):
            with model_call_deadline(0.1):
                raise AssertionError("model body must not start")
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, mask)
