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
import type { AgentTurnResult } from "../../src/api/agent-service-api";

/** Never submit the next request until a failed turn has stopped. */
export async function checkedTurn(
  run: () => Promise<AgentTurnResult>,
  stopAndWait: () => Promise<void>
): Promise<{ answer: string; error?: string; canContinue: boolean }> {
  try {
    const result = await run();
    if (!result.completed) throw new Error(result.errors.join("; ") || "Turn ended without completion");
    return { answer: result.finalAnswer ?? "", canContinue: true };
  } catch (failure) {
    let error = String(failure);
    try {
      await stopAndWait();
      return { answer: "", error, canContinue: true };
    } catch (stopFailure) {
      error += `; could not stop session: ${stopFailure}`;
      return { answer: "", error, canContinue: false };
    }
  }
}
