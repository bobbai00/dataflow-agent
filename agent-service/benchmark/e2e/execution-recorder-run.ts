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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { startExecutionRecorder } from "./execution-recorder";

function recorderSource() {
  const root = resolve(import.meta.dir, "../../..");
  const paths = [
    "agent-service/benchmark/e2e/execution-recorder.ts",
    "agent-service/benchmark/e2e/execution-recorder-run.ts",
  ];
  try {
    const git = (args: string[]) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
    const gitSha = git(["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new Error("Unresolved recorder source");
    return {
      root,
      gitSha,
      dirty: git(["status", "--porcelain", "--untracked-files=normal", "--", ...paths]) !== "",
      files: paths.map(path => ({
        path,
        sha256: createHash("sha256")
          .update(readFileSync(resolve(root, path)))
          .digest("hex"),
      })),
      bunVersion: Bun.version,
    };
  } catch {
    return { root, gitSha: null, dirty: null, files: [], bunVersion: Bun.version };
  }
}

function processIdentity() {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const ticks = Number(
      stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)[19]
    );
    return {
      pid: process.pid,
      processStartTicks: Number.isSafeInteger(ticks) && ticks > 0 ? ticks : null,
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    };
  } catch {
    return { pid: process.pid, processStartTicks: null, bootId: null };
  }
}

/** Evaluation-only executable journal. No Texera service/resource creation.
 * The file must not exist. Every start is fsynced before forwarding, every
 * finish afterward. A hard-killed process leaves an open/unfinished journal,
 * never a fictional completed/terminated backend execution. */
export function startJournaledExecutionRecorder(options: {
  backend: string;
  computingUnitIds: readonly number[];
  journalPath: string;
  port?: number;
  maxRequests?: number;
}) {
  const journalPath = resolve(options.journalPath);
  // The caller creates its own private run directory. Never append to or
  // overwrite an old attempt journal (including a failed/empty one).
  const fd = openSync(journalPath, "wx", 0o600);
  const append = (event: unknown): undefined => {
    const bytes = Buffer.from(JSON.stringify(event) + "\n");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Incomplete execution journal write");
      offset += written;
    }
    fsyncSync(fd);
  };
  let recorder: ReturnType<typeof startExecutionRecorder>;
  try {
    recorder = startExecutionRecorder({
      backend: options.backend,
      computingUnitIds: options.computingUnitIds,
      port: options.port,
      maxRequests: options.maxRequests,
      onEvent: append,
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const metadata = {
    ...recorder.status(),
    kind: "recorder_started",
    url: recorder.url,
    startedAt: new Date().toISOString(),
    ...processIdentity(),
    source: recorderSource(),
  };
  try {
    // The synchronous startup stack has not yielded, so no HTTP request can
    // be handled before this header reaches stable storage.
    append(metadata);
    const directoryFd = openSync(resolve(journalPath, ".."), "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    void recorder.close(); // no requests have entered this event loop yet
    closeSync(fd);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    ...recorder,
    journalPath,
    metadata,
    close(reason = "caller") {
      if (!closing)
        closing = (async () => {
          try {
            await recorder.close(); // drain, do not cancel an admitted request
            append({
              ...recorder.status(),
              kind: "recorder_closed",
              closedAt: new Date().toISOString(),
              reason: ["caller", "SIGTERM", "SIGINT"].includes(reason) ? reason : "caller",
            });
          } finally {
            closeSync(fd);
          }
        })();
      return closing;
    },
  };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      strict: true,
      options: {
        backend: { type: "string" },
        "computing-units": { type: "string" },
        journal: { type: "string" },
        port: { type: "string", default: "0" },
        "max-requests": { type: "string", default: "1000" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: bun benchmark/e2e/execution-recorder-run.ts --backend http://localhost:8085 --computing-units CUID[,CUID] --journal /private/run/execution_requests.jsonl [--port PORT]"
      );
    } else {
      if (
        !values.backend ||
        !values.journal ||
        !/^\d+(,\d+)*$/.test(values["computing-units"] ?? "") ||
        !/^\d+$/.test(values.port!) ||
        !/^\d+$/.test(values["max-requests"]!)
      )
        throw new Error("Missing or invalid recorder configuration");
      const computingUnitIds = values["computing-units"]!.split(",").map(Number);
      const port = Number(values.port);
      if (new Set(computingUnitIds).size !== computingUnitIds.length || !Number.isSafeInteger(port) || port > 65535)
        throw new Error("Invalid recorder identifiers or port");
      const recorder = startJournaledExecutionRecorder({
        backend: values.backend,
        journalPath: values.journal,
        computingUnitIds,
        port,
        maxRequests: Number(values["max-requests"]),
      });
      console.log(JSON.stringify({ ...recorder.metadata, journalPath: recorder.journalPath }));
      let stopping = false;
      const shutdown = async (signal: "SIGTERM" | "SIGINT") => {
        if (stopping) return;
        stopping = true;
        try {
          await recorder.close(signal);
          process.exitCode = recorder.status().persistenceFailed ? 1 : 0;
        } catch {
          console.error("Execution recorder could not close its journal; preserve partial evidence");
          process.exitCode = 1;
        }
      };
      process.on("SIGTERM", () => {
        void shutdown("SIGTERM");
      });
      process.on("SIGINT", () => {
        void shutdown("SIGINT");
      });
    }
  } catch {
    // No argv or raw error text: credentials accidentally passed as arguments
    // must not be echoed into a launch log.
    console.error("Execution recorder startup failed; check configuration, output path and loopback binding");
    process.exitCode = 1;
  }
}
