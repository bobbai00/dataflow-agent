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
from concurrent.futures import ThreadPoolExecutor
from threading import Event

from campaign_schedule import completed_jobs


def test_a_fast_session_releases_its_slot_before_its_slow_partner_finishes():
    release_slow = Event()
    third_started = Event()

    def run(job):
        if job == "slow":
            assert release_slow.wait(5)
        if job == "third":
            third_started.set()
        return job

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = completed_jobs(pool, ["slow", "fast", "third"], run)
        try:
            job, _ = next(results)
            assert job != "slow"
            assert third_started.wait(1)
        finally:
            release_slow.set()
        rest = list(results)
    assert {job for job, _ in [(job, job)] + rest} == {"slow", "fast", "third"}
