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

export async function replayDebug(url: string, content: string, options: {
  timeoutMs?: number; pollMs?: number; confirmCompletion?: () => Promise<boolean>;
} = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    let sent = false, finished = false, checking = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearInterval(poll); socket.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Debug replay timeout")), options.timeoutMs ?? 300_000);
    const poll = setInterval(async () => {
      if (!sent || finished || checking || !options.confirmCompletion) return;
      checking = true;
      try { if (await options.confirmCompletion()) finish(); }
      catch { /* Keep checking the same request; never send it again. */ }
      finally { checking = false; }
    }, options.pollMs ?? 5_000);
    socket.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true; socket.send(JSON.stringify({ type: "debug", content }));
      } else if (frame.type === "complete" && sent) finish();
      else if (frame.type === "error") finish(new Error(String(frame.error ?? frame.content)));
    };
    socket.onerror = () => {
      if (!sent || !options.confirmCompletion) finish(new Error("Debug socket failed"));
    };
  });
}
