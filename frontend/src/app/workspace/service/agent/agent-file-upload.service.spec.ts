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

import { describe, expect, it, vi } from "vitest";
import { of, throwError } from "rxjs";
import { HttpErrorResponse } from "@angular/common/http";
import { AgentFileUpload, AgentFileUploadService } from "./agent-file-upload.service";
import { DatasetService } from "../../../dashboard/service/user/dataset/dataset.service";
import { UserService } from "../../../common/service/user/user.service";
import { DashboardDataset } from "../../../dashboard/type/dashboard-dataset.interface";

const EMAIL = "me@texera.dev";

function dashboardDataset(did: number, name: string, isOwner = true): DashboardDataset {
  return {
    isOwner,
    ownerEmail: EMAIL,
    accessPrivilege: "WRITE",
    size: 0,
    dataset: {
      did,
      ownerUid: 1,
      name,
      isPublic: false,
      isDownloadable: false,
      storagePath: undefined,
      description: "",
      creationTime: undefined,
      coverImage: undefined,
    },
  };
}

function makeService(
  overrides: Partial<Record<keyof DatasetService, unknown>> = {},
  // `null`, not `undefined`: an explicit `undefined` would fall back to the
  // default parameter and quietly sign the user back in.
  email: string | null = EMAIL
) {
  const datasetService = {
    retrieveAccessibleDatasets: vi.fn(() => of([dashboardDataset(7, AgentFileUploadService.UPLOAD_DATASET_NAME)])),
    createDataset: vi.fn(() => of(dashboardDataset(9, AgentFileUploadService.UPLOAD_DATASET_NAME))),
    multipartUpload: vi.fn(() => of({ percentage: 100, status: "finished" })),
    createDatasetVersion: vi.fn(() => of({ name: "v3" })),
    ...overrides,
  } as unknown as DatasetService;
  const userService = {
    getCurrentUser: vi.fn(() => (email ? { email } : undefined)),
  } as unknown as UserService;
  return { service: new AgentFileUploadService(datasetService, userService), datasetService, userService };
}

function collect(service: AgentFileUploadService, files: File[]): Promise<AgentFileUpload[]> {
  return new Promise((resolve, reject) => {
    const events: AgentFileUpload[] = [];
    service.uploadFiles(files).subscribe({
      next: e => events.push(e),
      error: reject,
      complete: () => resolve(events),
    });
  });
}

describe("AgentFileUploadService", () => {
  describe("sanitizeFileName", () => {
    it("keeps a plain name untouched", () => {
      expect(AgentFileUploadService.sanitizeFileName("boston_fy2026.csv")).toBe("boston_fy2026.csv");
    });
    it("replaces characters that would not survive a chat message or an operator property", () => {
      expect(AgentFileUploadService.sanitizeFileName("my data (final).csv")).toBe("my_data_final_.csv");
    });
    it("drops any directory part a folder drop carries", () => {
      expect(AgentFileUploadService.sanitizeFileName("nested/dir/a.csv")).toBe("a.csv");
    });
    it("never yields an empty or dot-leading name", () => {
      expect(AgentFileUploadService.sanitizeFileName("...")).toBe("file");
      expect(AgentFileUploadService.sanitizeFileName(".hidden.csv")).toBe("hidden.csv");
    });
  });

  it("builds the path form operators expect", () => {
    expect(AgentFileUploadService.buildDatasetPath(EMAIL, "agent-uploads", "v2", "a.csv")).toBe(
      "/me@texera.dev/agent-uploads/v2/a.csv"
    );
  });

  it("uploads into the existing upload dataset and returns the committed path", async () => {
    const { service, datasetService } = makeService();
    const file = new File(["a,b\n"], "a.csv");

    const events = await collect(service, [file]);

    expect(datasetService.createDataset).not.toHaveBeenCalled();
    expect(datasetService.multipartUpload).toHaveBeenCalledWith(
      EMAIL,
      "agent-uploads",
      "a.csv",
      file,
      20971520,
      3,
      false
    );
    expect(events.at(-1)).toEqual({
      fileName: "a.csv",
      percentage: 100,
      status: "done",
      reused: false,
      path: "/me@texera.dev/agent-uploads/v3/a.csv",
    });
  });

  it("creates the upload dataset on first use", async () => {
    const { service, datasetService } = makeService({
      retrieveAccessibleDatasets: vi.fn(() => of([dashboardDataset(1, "unrelated")])),
    });

    const events = await collect(service, [new File(["x"], "a.csv")]);

    expect(datasetService.createDataset).toHaveBeenCalledTimes(1);
    expect(datasetService.createDatasetVersion).toHaveBeenCalledWith(9, "");
    expect(events.at(-1)?.path).toBe("/me@texera.dev/agent-uploads/v3/a.csv");
  });

  it("ignores a same-named dataset owned by somebody else", async () => {
    const { service, datasetService } = makeService({
      retrieveAccessibleDatasets: vi.fn(() =>
        of([dashboardDataset(4, AgentFileUploadService.UPLOAD_DATASET_NAME, false)])
      ),
    });

    await collect(service, [new File(["x"], "a.csv")]);

    // Writing into someone else's dataset would fail server-side anyway.
    expect(datasetService.createDataset).toHaveBeenCalledTimes(1);
  });

  it("commits one version for a multi-file drop and reports a path per file", async () => {
    const { service, datasetService } = makeService();

    const events = await collect(service, [new File(["x"], "a.csv"), new File(["y"], "b.csv")]);

    expect(datasetService.multipartUpload).toHaveBeenCalledTimes(2);
    expect(datasetService.createDatasetVersion).toHaveBeenCalledTimes(1);
    expect(events.filter(e => e.status === "done").map(e => e.path)).toEqual([
      "/me@texera.dev/agent-uploads/v3/a.csv",
      "/me@texera.dev/agent-uploads/v3/b.csv",
    ]);
  });

  it("holds back 100% until the version exists, so a path is never implied early", async () => {
    const { service } = makeService({
      multipartUpload: vi.fn(() => of({ percentage: 100, status: "finished" })),
    });

    const events = await collect(service, [new File(["x"], "a.csv")]);

    expect(events.filter(e => e.status === "uploading").every(e => e.percentage < 100)).toBe(true);
  });

  it("reuses the newest version when the bytes are already committed", async () => {
    // file-service rejects the commit with 400 when LakeFS has no diff — the
    // case of re-dropping a file that is already in the dataset.
    const conflict = new HttpErrorResponse({
      status: 400,
      error: { message: "No changes detected in dataset. Version creation aborted." },
    });
    const { service, datasetService } = makeService({
      createDatasetVersion: vi.fn(() => throwError(() => conflict)),
      retrieveDatasetLatestVersion: vi.fn(() => of({ name: "v7" })),
    });

    const events = await collect(service, [new File(["x"], "a.csv")]);

    expect(datasetService.retrieveDatasetLatestVersion).toHaveBeenCalledWith(7);
    expect(events.at(-1)).toEqual({
      fileName: "a.csv",
      percentage: 100,
      status: "done",
      reused: true,
      path: "/me@texera.dev/agent-uploads/v7/a.csv",
    });
  });

  it("still fails on a version error that is not about a missing diff", async () => {
    const { service } = makeService({
      createDatasetVersion: vi.fn(() =>
        throwError(() => new HttpErrorResponse({ status: 400, error: { message: "Dataset is read-only" } }))
      ),
    });

    await expect(collect(service, [new File(["x"], "a.csv")])).rejects.toBeTruthy();
  });

  it("errors when nobody is signed in", async () => {
    const { service } = makeService({}, null);

    await expect(collect(service, [new File(["x"], "a.csv")])).rejects.toThrow(/Sign in/);
  });

  it("does nothing for an empty drop", async () => {
    const { service, datasetService } = makeService();

    expect(await collect(service, [])).toEqual([]);
    expect(datasetService.retrieveAccessibleDatasets).not.toHaveBeenCalled();
  });
});
