/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { getBackendConfig } from "./backend-api";
import { createAuthHeaders } from "./auth-api";
import type { WorkflowContent } from "../types/workflow";
import { workflowNativeRuntime } from "../agent/native/codegen";

export interface Workflow {
  wid: number;
  name: string;
  description?: string;
  content: WorkflowContent;
  creationTime?: number;
  lastModifiedTime?: number;
  isPublished?: boolean;
}

interface WorkflowPersistRequest {
  wid?: number;
  name: string;
  description?: string;
  content: string;
  isPublic?: boolean;
}

const WORKFLOW_BASE_URL = "workflow";

export async function persistWorkflow(
  token: string,
  wid: number,
  name: string,
  content: WorkflowContent,
  description?: string
): Promise<Workflow> {
  const config = getBackendConfig();
  const url = `${config.apiEndpoint}/api/${WORKFLOW_BASE_URL}/persist`;

  const response = await fetch(url, {
    method: "POST",
    headers: createAuthHeaders(token),
    body: JSON.stringify({
      wid,
      name,
      description: description || "",
      // Saved as the engine runs it, so the workflow also runs outside the agent.
      content: JSON.stringify(workflowNativeRuntime(content, "inline")),
      isPublic: false,
    } as WorkflowPersistRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to persist workflow: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = (await response.json()) as Workflow;
  if (typeof data.content === "string") {
    data.content = JSON.parse(data.content as unknown as string);
  }
  return data;
}

export async function retrieveWorkflow(token: string, wid: number): Promise<Workflow> {
  const config = getBackendConfig();
  const url = `${config.apiEndpoint}/api/${WORKFLOW_BASE_URL}/${wid}`;

  const response = await fetch(url, {
    method: "GET",
    headers: createAuthHeaders(token),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to retrieve workflow: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = (await response.json()) as Workflow;
  if (typeof data.content === "string") {
    data.content = JSON.parse(data.content as unknown as string);
  }
  // The agent keeps native code without the runtime source (NATIVE_RUNTIME_TOKEN).
  if (data.content?.operators) data.content = workflowNativeRuntime(data.content, "token");
  return data;
}

interface DashboardWorkflow {
  isOwner: boolean;
  accessLevel: string;
  ownerName: string;
  workflow: { wid: number; name: string; description?: string; content: string };
  projectIDs: number[];
  ownerId: number;
}

/**
 * Insert a brand-new workflow row. Server requires `wid` to be absent.
 * Returns the freshly assigned `wid`.
 */
export async function createWorkflow(
  token: string,
  name: string,
  content: WorkflowContent,
  description = ""
): Promise<number> {
  const config = getBackendConfig();
  const url = `${config.apiEndpoint}/api/${WORKFLOW_BASE_URL}/create`;

  const response = await fetch(url, {
    method: "POST",
    headers: createAuthHeaders(token),
    body: JSON.stringify({
      name,
      description,
      // Saved as the engine runs it, so the workflow also runs outside the agent.
      content: JSON.stringify(workflowNativeRuntime(content, "inline")),
      isPublic: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create workflow: ${response.status} ${response.statusText} - ${errorText}`);
  }
  const data = (await response.json()) as DashboardWorkflow;
  return data.workflow.wid;
}

export async function deleteWorkflow(token: string, wid: number): Promise<void> {
  const config = getBackendConfig();
  const url = `${config.apiEndpoint}/api/${WORKFLOW_BASE_URL}/delete`;

  const response = await fetch(url, {
    method: "POST",
    headers: createAuthHeaders(token),
    body: JSON.stringify({ wids: [wid], pid: null }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete workflow ${wid}: ${response.status} ${response.statusText} - ${errorText}`);
  }
}
