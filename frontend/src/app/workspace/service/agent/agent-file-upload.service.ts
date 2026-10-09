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

import { Injectable } from "@angular/core";
import { HttpErrorResponse } from "@angular/common/http";
import { Observable, concat, of, throwError } from "rxjs";
import { catchError, map, switchMap } from "rxjs/operators";
import { DatasetService } from "../../../dashboard/service/user/dataset/dataset.service";
import { UserService } from "../../../common/service/user/user.service";
import { Dataset } from "../../../common/type/dataset";
import { DashboardDataset } from "../../../dashboard/type/dashboard-dataset.interface";

/** Progress of one dropped file on its way to a dataset path. */
export interface AgentFileUpload {
  /** Name the file is stored under (sanitized, so not always `File.name`). */
  fileName: string;
  /** 0-100 for the upload itself; the version commit is instant by comparison. */
  percentage: number;
  status: "uploading" | "committing" | "done" | "failed";
  /** Dataset path, once the file is in a committed version. */
  path?: string;
  /** True when the bytes were already committed, so no new version was made. */
  reused?: boolean;
  error?: string;
}

/**
 * Uploads files dropped on the agent panel into a per-user dataset and returns
 * the dataset paths, which is what the agent's operators consume (the same
 * `/owner@email/dataset/version/file.csv` string a user would otherwise copy
 * out of the dataset explorer by hand).
 *
 * One dataset per user rather than one per workflow: a dropped file is usually
 * worth reusing across workflows, and the alternative fills the dataset list
 * with near-empty datasets.
 */
@Injectable({
  providedIn: "root",
})
export class AgentFileUploadService {
  /** Dataset that every agent-panel drop lands in. Created on first drop. */
  public static readonly UPLOAD_DATASET_NAME = "agent-uploads";
  private static readonly UPLOAD_DATASET_DESCRIPTION = "Files dropped on the agent panel.";
  /** Matches the dataset explorer's default chunking. */
  private static readonly PART_SIZE_BYTES = 20 * 1024 * 1024;
  private static readonly PART_CONCURRENCY = 3;

  constructor(
    private datasetService: DatasetService,
    private userService: UserService
  ) {}

  /**
   * LakeFS accepts most names, but a path with spaces or quotes in it has to
   * survive being pasted into a chat message and then into an operator's
   * property, so keep it boring.
   */
  public static sanitizeFileName(fileName: string): string {
    const base = fileName.split(/[\\/]/).pop() ?? fileName;
    const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
    return cleaned.length > 0 ? cleaned : "file";
  }

  /**
   * Whether a version-creation failure means "these exact bytes are already
   * committed" (file-service checks LakeFS for uncommitted objects first and
   * returns 400 when there are none). Matched on status *and* message so a
   * different 400 still surfaces as a real error.
   */
  private static isNothingToCommit(err: unknown): boolean {
    if (!(err instanceof HttpErrorResponse) || err.status !== 400) {
      return false;
    }
    const body = err.error;
    const message = typeof body === "string" ? body : body?.message ?? err.message ?? "";
    return /no changes detected/i.test(message);
  }

  /** `/owner@email/dataset/version/file.csv` — the form operators expect. */
  public static buildDatasetPath(ownerEmail: string, datasetName: string, version: string, fileName: string): string {
    return `/${ownerEmail}/${datasetName}/${version}/${fileName}`;
  }

  /**
   * Upload every file, then commit one version holding all of them, and emit a
   * `done` event per file carrying its path.
   *
   * One version for the whole drop, not one per file: versions are the unit a
   * user browses in the dataset explorer, and a five-file drop is one action.
   */
  public uploadFiles(files: File[]): Observable<AgentFileUpload> {
    if (files.length === 0) {
      return of();
    }
    const user = this.userService.getCurrentUser();
    if (!user?.email) {
      return throwError(() => new Error("Sign in before uploading files."));
    }
    const named = files.map(file => ({ file, fileName: AgentFileUploadService.sanitizeFileName(file.name) }));

    return this.resolveUploadDataset().pipe(
      switchMap(dataset =>
        concat(
          ...named.map(({ file, fileName }) => this.uploadOne(dataset.ownerEmail, dataset.name, fileName, file)),
          this.commitVersion(
            dataset.did,
            dataset.ownerEmail,
            dataset.name,
            named.map(n => n.fileName)
          )
        )
      )
    );
  }

  /** The user's upload dataset, created on first use. */
  private resolveUploadDataset(): Observable<{ did: number; name: string; ownerEmail: string }> {
    return this.datasetService.retrieveAccessibleDatasets().pipe(
      switchMap(datasets => {
        const existing = datasets.find(
          d => d.isOwner && d.dataset.name === AgentFileUploadService.UPLOAD_DATASET_NAME && d.dataset.did !== undefined
        );
        return existing ? of(existing) : this.createUploadDataset();
      }),
      map(dashboardDataset => ({
        did: dashboardDataset.dataset.did as number,
        name: dashboardDataset.dataset.name,
        // `ownerEmail` is missing on the create response; the creator is the
        // signed-in user either way.
        ownerEmail: dashboardDataset.ownerEmail || (this.userService.getCurrentUser()?.email as string),
      }))
    );
  }

  private createUploadDataset(): Observable<DashboardDataset> {
    const dataset: Dataset = {
      did: undefined,
      ownerUid: undefined,
      name: AgentFileUploadService.UPLOAD_DATASET_NAME,
      isPublic: false,
      isDownloadable: false,
      storagePath: undefined,
      description: AgentFileUploadService.UPLOAD_DATASET_DESCRIPTION,
      creationTime: undefined,
      coverImage: undefined,
    };
    return this.datasetService.createDataset(dataset);
  }

  private uploadOne(
    ownerEmail: string,
    datasetName: string,
    fileName: string,
    file: File
  ): Observable<AgentFileUpload> {
    return this.datasetService
      .multipartUpload(
        ownerEmail,
        datasetName,
        fileName,
        file,
        AgentFileUploadService.PART_SIZE_BYTES,
        AgentFileUploadService.PART_CONCURRENCY,
        false
      )
      .pipe(
        map(progress => ({
          fileName,
          percentage: Math.min(99, Math.round(progress.percentage ?? 0)),
          status: "uploading" as const,
        }))
      );
  }

  /**
   * Turn the staged uploads into a readable version. `""` lets the backend pick
   * the next name (`v1`, `v2`, …), which is also what the dataset explorer does.
   */
  private commitVersion(
    did: number,
    ownerEmail: string,
    datasetName: string,
    fileNames: string[]
  ): Observable<AgentFileUpload> {
    const committing = fileNames.map(fileName => ({
      fileName,
      percentage: 100,
      status: "committing" as const,
    }));
    return concat(
      of(...committing),
      this.datasetService.createDatasetVersion(did, "").pipe(
        map(version => ({ version: version.name, reused: false })),
        catchError((err: unknown) => {
          // Dropping a file whose bytes are already committed leaves LakeFS with
          // nothing to commit, so the version endpoint rejects with 400 "No
          // changes detected". That is not a failure for us: the file already
          // lives in the dataset, so resolve the path against the newest
          // version instead of failing the drop.
          if (!AgentFileUploadService.isNothingToCommit(err)) {
            return throwError(() => err);
          }
          return this.datasetService
            .retrieveDatasetLatestVersion(did)
            .pipe(map(version => ({ version: version.name, reused: true })));
        }),
        switchMap(({ version, reused }) =>
          of(
            ...fileNames.map(fileName => ({
              fileName,
              percentage: 100,
              status: "done" as const,
              reused,
              path: AgentFileUploadService.buildDatasetPath(ownerEmail, datasetName, version, fileName),
            }))
          )
        )
      )
    );
  }
}
