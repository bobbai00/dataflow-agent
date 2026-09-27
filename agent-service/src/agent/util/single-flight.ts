/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * `task` with at most one run in flight. A call while it runs schedules one
 * more run after it, and calls in between coalesce into that one, which reads
 * the state current when it starts. The returned promise settles when the
 * runs it joined are done.
 *
 * The workflow auto-persist uses it: each save rewrites the whole workflow
 * (megabytes for a long session), and overlapping saves of one workflow
 * queued on its row lock and held the web service's database connections
 * until no session could start (2026-09-27, 18 concurrent sessions).
 */
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await task();
      } while (again);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
}
