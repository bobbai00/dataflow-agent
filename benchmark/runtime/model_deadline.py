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
"""Absolute model-call deadline targeting only Linux's main thread.

A reserved real-time signal keeps parent SIGALRM timers untouched. Cancellation
and joining the watchdog while the main thread blocks its signal prevent a late
owned callback from reaching a restored handler on another native thread.
"""

from contextlib import contextmanager
from pathlib import Path
import signal
import sys
import threading
import time

from .model_limits import validate_model_request_timeout_seconds

DEADLINE_METHOD = "linux_main_thread_pthread_signal_watchdog_elapsed_deadline"
_DEADLINE_SIGNALS = tuple(range(signal.SIGRTMIN, signal.SIGRTMAX + 1)) if sys.platform == "linux" else ()


class ModelRequestTimeoutError(TimeoutError):
    def __init__(self, timeout_seconds):
        self.timeout_seconds = timeout_seconds
        super().__init__(f"Model request elapsed deadline reached after {timeout_seconds} seconds")


def _kernel_signal_dispositions():
    """Python's cached handler can miss a native library's sigaction handler."""
    try:
        fields = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
        return int(fields["SigCgt"].strip(), 16) | int(fields["SigIgn"].strip(), 16)
    except (OSError, ValueError, KeyError) as error:
        raise RuntimeError("Cannot verify kernel signal dispositions before model inference") from error


def validate_deadline_support():
    """Select an unused signal or fail before inference; reserve it at call entry."""
    if sys.platform != "linux" or not hasattr(signal, "pthread_kill"):
        raise RuntimeError("Absolute model-request deadline requires Linux pthread signals")
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError("Absolute model-request deadline requires the main thread")
    blocked = signal.pthread_sigmask(signal.SIG_BLOCK, [])
    if signal.SIGALRM in blocked:
        raise RuntimeError("Absolute model-request deadline requires an unblocked SIGALRM task deadline")
    pending = signal.sigpending()
    occupied = _kernel_signal_dispositions()
    signal.pthread_kill(threading.main_thread().ident, 0)
    for number in _DEADLINE_SIGNALS:
        if (
            number not in blocked
            and number not in pending
            and not occupied & (1 << (number - 1))
            and signal.getsignal(number) == signal.SIG_DFL
        ):
            return number
    raise RuntimeError("Absolute model-request deadline requires an unused unblocked real-time signal")


@contextmanager
def _pause_signal_delivery(number):
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, [])
    try:
        signal.pthread_sigmask(signal.SIG_BLOCK, {number})
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


class _CallDeadline:
    def __init__(self, seconds):
        self.seconds = validate_model_request_timeout_seconds(seconds)
        self.cancel = threading.Event()
        self.done = threading.Event()
        self.installed = False
        self.closing = False
        self.deferred_alarm = False

    def start(self):
        self.signal_number = validate_deadline_support()
        self.started = time.monotonic()
        self.deadline = self.started + self.seconds
        self.main_ident = threading.main_thread().ident
        self.previous_handler = signal.getsignal(self.signal_number)
        self.watchdog = threading.Thread(
            target=self.watch,
            name=f"model-request-deadline-{self.signal_number}",
            daemon=True,
        )
        with _pause_signal_delivery(self.signal_number):
            self.installed = True
            signal.signal(self.signal_number, self.handle)
            self.watchdog.start()

    def watch(self):
        try:
            if not self.cancel.wait(max(0, self.deadline - time.monotonic())):
                signal.pthread_kill(self.main_ident, self.signal_number)
        finally:
            self.done.set()

    def handle(self, signum, frame):
        if self.closing:
            self.deferred_alarm = True
            return
        raise ModelRequestTimeoutError(self.seconds)

    def close(self, exception_active=False):
        self.closing = True
        interrupted = None
        try:
            with _pause_signal_delivery(self.signal_number):
                self.cancel.set()
        except BaseException:
            interrupted = sys.exc_info()
        # A parent signal can interrupt any teardown primitive. Finish the
        # idempotent shutdown before propagating that original interruption.
        while True:
            try:
                self.cancel.set()
                with _pause_signal_delivery(self.signal_number):
                    if self.watchdog.ident is not None:
                        self.done.wait()
                        self.watchdog.join()
                    if signal.sigtimedwait({self.signal_number}, 0) is not None:
                        self.deferred_alarm = True
                    signal.signal(self.signal_number, self.previous_handler)
                # The reserved signal was unblocked at entry. A parent interrupt
                # in a prior mask operation must not leave it blocked on retry.
                signal.pthread_sigmask(signal.SIG_UNBLOCK, {self.signal_number})
                self.installed = False
                break
            except BaseException:
                if interrupted is None:
                    interrupted = sys.exc_info()
        if interrupted is not None:
            raise interrupted[1].with_traceback(interrupted[2])
        if self.deferred_alarm and not exception_active:
            raise ModelRequestTimeoutError(self.seconds)


@contextmanager
def model_call_deadline(seconds):
    """Enforce elapsed call time without changing an enclosing SIGALRM deadline.

    Linux's main thread must have an unused, unblocked real-time signal. Each
    nesting level reserves a distinct signal. Watchdog CPU/memory belongs to the
    caller's process; signal delivery has normal kernel scheduling precision.
    """
    timer = _CallDeadline(seconds)
    try:
        timer.start()
        try:
            yield {
                "method": DEADLINE_METHOD,
                "timeout_seconds": timer.seconds,
                "boundary": "Synchronous model completion create entry through return or error",
                "signal_number": timer.signal_number,
                "target_thread": "main_thread",
                "parent_deadline_policy": "SIGALRM handler and timer untouched; earlier parent exception propagates",
            }
        finally:
            if timer.installed:
                timer.close(exception_active=sys.exc_info()[0] is not None)
    except BaseException:
        # An asynchronous deadline can interrupt finalizer entry itself. Retry
        # cleanup without replacing the exception that started unwinding.
        if timer.installed:
            timer.close(exception_active=True)
        raise
