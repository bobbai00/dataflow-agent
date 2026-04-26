/**
 * Phase 1 integration smoke test: open a real WebSocket to the engine,
 * send a heartbeat, verify HeartBeatResponse, close cleanly.
 *
 * Requires:
 *   - Engine (master) running at localhost:8085
 *   - Webapp running at localhost:8080 to mint a JWT
 *
 * Run with: bun run scripts/ws-smoke-test.ts
 */

import { ExecutionWsClient } from "../src/api/execution-ws-client";
import type { TexeraWebSocketEvent } from "../src/types/execution-ws";

async function getDevToken(): Promise<string> {
  const res = await fetch("http://localhost:8080/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "texera", password: "texera" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

async function main() {
  console.log("[smoke] minting dev JWT...");
  const token = await getDevToken();
  console.log(`[smoke] got JWT (${token.length} chars)`);

  const client = new ExecutionWsClient({
    url: "ws://localhost:8085/wsapi/workflow-websocket",
    token,
    workflowId: 1,
    computingUnitId: 1,
    heartbeatIntervalMs: 0,
  });

  const events: TexeraWebSocketEvent[] = [];
  client.onEvent(evt => {
    events.push(evt);
    console.log(`[smoke] event: ${evt.type}`, JSON.stringify(evt).slice(0, 200));
  });
  client.onClose((code, reason) => {
    console.log(`[smoke] close: code=${code} reason=${reason}`);
  });
  client.onError(err => {
    console.error(`[smoke] error:`, err);
  });

  console.log("[smoke] connecting...");
  await client.connect();
  console.log(`[smoke] connected. isOpen=${client.isOpen()}`);

  // Wait briefly for any unsolicited initial events (e.g., WorkflowStateEvent("Uninitialized"))
  await new Promise(r => setTimeout(r, 1000));

  console.log("[smoke] sending HeartBeatRequest...");
  client.send({ type: "HeartBeatRequest" });

  await new Promise(r => setTimeout(r, 1000));

  const heartbeatResp = events.find(e => e.type === "HeartBeatResponse");
  console.log(`[smoke] heartbeat response received: ${!!heartbeatResp}`);

  console.log("[smoke] closing...");
  client.close();

  console.log(`[smoke] done. total events received: ${events.length}`);
  console.log(`[smoke] event types: ${[...new Set(events.map(e => e.type))].join(", ")}`);

  if (heartbeatResp) {
    console.log("[smoke] PASS");
    process.exit(0);
  } else {
    console.error("[smoke] FAIL: no heartbeat response");
    process.exit(1);
  }
}

main().catch(e => {
  console.error("[smoke] fatal:", e);
  process.exit(1);
});
