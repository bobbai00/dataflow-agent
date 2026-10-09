/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJournaledExecutionRecorder } from "./execution-recorder-run";

function readEvents(path: string) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
}

test("journal writes exclusive private start/finish records and a drained footer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-recorder-journal-test-"));
  const journalPath = join(directory, "execution_requests.jsonl");
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const events = readEvents(journalPath);
      expect(events.map(event => event.kind)).toEqual(["recorder_started", "request_started"]);
      return Response.json({
        success: true,
        state: "Completed",
        executionId: "123",
        phaseMetrics: { version: 1, compilation: "passed", compilationDurationMs: 1, runtimeStartAttempted: true },
        operators: { op: { cell: "private result" } },
      });
    },
  });
  const recorder = startJournaledExecutionRecorder({ backend: backend.url.origin, computingUnitIds: [7], journalPath });
  try {
    expect(() =>
      startJournaledExecutionRecorder({ backend: backend.url.origin, computingUnitIds: [7], journalPath })
    ).toThrow();
    const response = await fetch(`${recorder.url}/api/execution/42/7/run`, {
      method: "POST",
      headers: { authorization: "Bearer private-token" },
      body: JSON.stringify({ logicalPlan: { operators: [{ code: "private code" }] } }),
    });
    expect(response.status).toBe(200);
    await recorder.close();
    const events = readEvents(journalPath);
    expect(events.map(event => event.kind)).toEqual([
      "recorder_started",
      "request_started",
      "request_finished",
      "recorder_closed",
    ]);
    expect(events[0].instanceId).toBe(events[1].instanceId);
    expect(events[0].pid).toBe(process.pid);
    expect(events[0].source.gitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(events[0].source.files).toHaveLength(2);
    expect(events[1].record.requestId).toBe(events[2].record.requestId);
    expect(events[2].record.executionId).toBe("123");
    expect(events[3].pending).toBe(0);
    expect(events[3].completed).toBe(1);
    expect(events[3].persistenceFailed).toBe(false);
    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(journalPath, "utf8")).not.toContain("private");
  } finally {
    await recorder.close();
    await backend.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("draining refuses new work while the admitted request finishes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-recorder-drain-test-"));
  const journalPath = join(directory, "execution_requests.jsonl");
  let entered!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => (entered = resolve));
  const waiting = new Promise<void>(resolve => (release = resolve));
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      entered();
      await waiting;
      return Response.json({});
    },
  });
  const recorder = startJournaledExecutionRecorder({ backend: backend.url.origin, computingUnitIds: [7], journalPath });
  const first = fetch(`${recorder.url}/api/execution/42/7/run`, { method: "POST", body: "{}" });
  try {
    await admitted;
    recorder.stopAccepting();
    expect((await fetch(`${recorder.url}/api/execution/42/7/run`, { method: "POST", body: "{}" })).status).toBe(503);
    expect(readEvents(journalPath)).toHaveLength(2);
    release();
    expect((await first).status).toBe(200);
    await recorder.close();
    expect(readEvents(journalPath).at(-1).completed).toBe(1);
  } finally {
    release();
    await first;
    await recorder.close();
    await backend.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("killing the recorder preserves an unfinished request and does not prove backend termination", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-recorder-crash-test-"));
  const journalPath = join(directory, "execution_requests.jsonl");
  let entered!: () => void, release!: () => void;
  let backendFinished = false;
  const admitted = new Promise<void>(resolve => (entered = resolve));
  const waiting = new Promise<void>(resolve => (release = resolve));
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      entered();
      await waiting;
      backendFinished = true;
      return Response.json({});
    },
  });
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "execution-recorder-run.ts"),
      "--backend",
      backend.url.origin,
      "--computing-units",
      "7",
      "--journal",
      journalPath,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" }
  );
  let request: Promise<unknown> | undefined;
  try {
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("recorder exited before ready");
      output += new TextDecoder().decode(next.value);
    }
    reader.releaseLock();
    const metadata = JSON.parse(output.split("\n")[0]);
    request = fetch(`${metadata.url}/api/execution/42/7/run`, { method: "POST", body: "{}" }).catch(() => null);
    await admitted;
    expect(backendFinished).toBe(false);
    child.kill("SIGKILL"); // only this test-owned child process
    await child.exited;
    expect(backendFinished).toBe(false);
    const events = readEvents(journalPath);
    expect(events.map(event => event.kind)).toEqual(["recorder_started", "request_started"]);
    expect(events[1].record).not.toHaveProperty("compilation");
    expect(events[1].record).not.toHaveProperty("execution");
    release();
    await request;
  } finally {
    release();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    await request;
    await backend.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
