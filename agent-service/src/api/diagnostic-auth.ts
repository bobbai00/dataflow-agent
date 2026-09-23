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

import type { AgentDelegateConfig } from "../types/agent";
import { extractBearerToken, extractUserFromToken, validateToken } from "./auth-api";
import { getBackendConfig } from "./backend-api";

type Authorization = { ok: true } | { ok: false; status: 401 | 403 | 503; error: string };

/** A JWT payload alone is not authenticated. Delegate signature verification
 * and current workflow read access to Texera's @Auth / @RolesAllowed route.
 * No fallback to the agent's stored token, redirects, cached ACL or raw backend
 * error body. This protects this endpoint, not the pre-existing trusted-local
 * agent API/WS surfaces; deployments must protect those separately. */
export async function authorizeDiagnosticRead(
  header: string | undefined,
  owner: AgentDelegateConfig | undefined
): Promise<Authorization> {
  const token = extractBearerToken(header);
  if (!token || !validateToken(token)) return { ok: false, status: 401, error: "A valid Bearer token is required." };
  let uid: number;
  try {
    uid = extractUserFromToken(token).uid;
  } catch {
    return { ok: false, status: 401, error: "Invalid Bearer token." };
  }
  if (
    !Number.isSafeInteger(uid) ||
    !owner?.userInfo ||
    owner.userInfo.uid !== uid ||
    !Number.isSafeInteger(owner.workflowId) ||
    owner.workflowId! <= 0
  ) {
    return { ok: false, status: 403, error: "Diagnostic access requires the agent owner and a bound workflow." };
  }
  try {
    const response = await fetch(`${getBackendConfig().apiEndpoint}/api/workflow/${owner.workflowId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    // Only the authorization outcome is needed; never expose the workflow body.
    await response.body?.cancel();
    if (response.status === 401) return { ok: false, status: 401, error: "Texera rejected the caller's token." };
    if (response.status === 403 || response.status === 404)
      return { ok: false, status: 403, error: "Workflow access was denied." };
    if (response.status === 200) return { ok: true };
  } catch {
    /* Fail closed without logging credentials or upstream text. */
  }
  return { ok: false, status: 503, error: "Unable to verify workflow access; retry when Texera is available." };
}
