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
import { replayDebug } from "./state-pilot-debug";

function endpoint(complete: boolean, error?: string) {
  let sends = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("missing", { status: 404 }); },
    websocket: {
      open(socket) { socket.send(JSON.stringify({ type: "init" })); },
      message(socket) {
        sends++;
        if (error) socket.send(JSON.stringify({ type: "error", error }));
        else if (complete) socket.send(JSON.stringify({ type: "complete", state: "AVAILABLE" }));
      },
    },
  });
  return { server, sends: () => sends, url: `ws://localhost:${server.port}` };
}

test("debug completion does not require the optional next-context preview", async () => {
  const e = endpoint(true);
  try {
    await replayDebug(e.url, "recorded action", { timeoutMs: 200 });
    expect(e.sends()).toBe(1);
  } finally { e.server.stop(true); }
});

test("missing debug completion can be confirmed without replaying the action", async () => {
  const e = endpoint(false);
  try {
    await replayDebug(e.url, "recorded action", {
      timeoutMs: 200, pollMs: 20, confirmCompletion: async () => e.sends() === 1,
    });
    expect(e.sends()).toBe(1);
  } finally { e.server.stop(true); }
});

test("debug error preserves the server reason", async () => {
  const e = endpoint(false, "invalid action");
  try {
    await expect(replayDebug(e.url, "recorded action", { timeoutMs: 200 })).rejects.toThrow("invalid action");
    expect(e.sends()).toBe(1);
  } finally { e.server.stop(true); }
});

test("an unchanged idle agent does not confirm a debug request", async () => {
  const e = endpoint(false);
  try {
    await expect(replayDebug(e.url, "recorded action", {
      timeoutMs: 100, pollMs: 20, confirmCompletion: async () => false,
    })).rejects.toThrow("Debug replay timeout");
    expect(e.sends()).toBe(1);
  } finally { e.server.stop(true); }
});
