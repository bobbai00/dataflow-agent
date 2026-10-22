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

interface DatasetPojo {
  did: number;
  name: string;
  description?: string;
  ownerUid?: number;
  isPublic?: boolean;
  isDownloadable?: boolean;
  repositoryName?: string;
}

export interface DashboardDataset {
  dataset: DatasetPojo;
  ownerEmail: string;
  accessPrivilege: string;
  isOwner: boolean;
  size: number;
}

interface DatasetVersionPojo {
  dvid: number;
  did: number;
  creatorUid: number;
  name: string;
  versionHash: string;
}

export interface DashboardDatasetVersion {
  datasetVersion: DatasetVersionPojo;
  fileNodes: unknown[];
}

export async function createDataset(
  token: string,
  datasetName: string,
  datasetDescription = "",
  isDatasetPublic = false,
  isDatasetDownloadable = true
): Promise<DashboardDataset> {
  const { fileEndpoint: apiEndpoint } = getBackendConfig();
  const response = await fetch(`${apiEndpoint}/api/dataset/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      datasetName,
      datasetDescription,
      isDatasetPublic,
      isDatasetDownloadable,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create dataset: ${response.status} ${response.statusText} - ${errorText}`);
  }
  return (await response.json()) as DashboardDataset;
}

/**
 * Upload one file to a dataset's working tree (uncommitted). The file path is
 * relative to the dataset root and may contain forward slashes for sub-dirs.
 *
 * Body is sent as raw octet-stream with Content-Length so the server can
 * pre-compute the number of S3 multipart parts.
 */
export async function uploadFileToDataset(
  token: string,
  did: number,
  filePath: string,
  fileBytes: Uint8Array | ArrayBuffer,
  message = "upload"
): Promise<void> {
  const { fileEndpoint: apiEndpoint } = getBackendConfig();
  const url =
    `${apiEndpoint}/api/dataset/${did}/upload` +
    `?filePath=${encodeURIComponent(filePath)}` +
    `&message=${encodeURIComponent(message)}`;

  const buf = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buf.byteLength),
      Authorization: `Bearer ${token}`,
    },
    body: buf,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to upload file ${filePath} to dataset ${did}: ${response.status} ${response.statusText} - ${errorText}`
    );
  }
}

/**
 * Commit all pending uploads in the dataset working tree as a new version.
 * The server picks a name like "v1", "v2", ...; pass an empty `versionName`
 * unless you want a custom suffix.
 */
export async function createDatasetVersion(
  token: string,
  did: number,
  versionName = ""
): Promise<DashboardDatasetVersion> {
  const { fileEndpoint: apiEndpoint } = getBackendConfig();
  const response = await fetch(`${apiEndpoint}/api/dataset/${did}/version/create`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Authorization: `Bearer ${token}`,
    },
    body: versionName,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create dataset version on did=${did}: ${response.status} ${response.statusText} - ${errorText}`
    );
  }
  return (await response.json()) as DashboardDatasetVersion;
}

/**
 * A short-lived download link for one dataset file, addressed as
 * `/ownerEmail/datasetName/versionName/fileRelativePath`, or `undefined` when
 * the path is not a dataset file this user may read. The file service checks
 * access with the user's token; the link itself carries no credential beyond
 * that one object (15 minutes by default).
 */
export async function presignDatasetFile(token: string, filePath: string): Promise<string | undefined> {
  const { fileEndpoint: apiEndpoint } = getBackendConfig();
  const response = await fetch(`${apiEndpoint}/api/dataset/presign-download?filePath=${encodeURIComponent(filePath)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { presignedUrl?: string };
  return body.presignedUrl || undefined;
}

export async function deleteDataset(token: string, did: number): Promise<void> {
  const { fileEndpoint: apiEndpoint } = getBackendConfig();
  const response = await fetch(`${apiEndpoint}/api/dataset/${did}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete dataset ${did}: ${response.status} ${response.statusText} - ${errorText}`);
  }
}
