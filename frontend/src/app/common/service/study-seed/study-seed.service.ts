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
import { HttpClient } from "@angular/common/http";
import { catchError, of } from "rxjs";
import { UserService } from "../user/user.service";
import { GuiConfigService } from "../gui-config.service";

/** What the agent service says of a user's seed (`GET /api/agents/seed`). */
export interface StudySeedStatus {
  status: "disabled" | "none" | "running" | "done" | "failed";
  seed?: string;
  workflowId?: number;
  agentId?: string;
  error?: string;
}

/**
 * Asks the agent service, once per signed-in user, to give that user what the
 * deployment seeds every account with: a workflow with the agent's analysis and
 * its trace already in it (a user study's prepared scenario, say). The service
 * decides whether anything is configured and does the work in the background;
 * the dashboard's workflow list fills in once it is done. Nothing here blocks
 * or shows an error: seeding is the deployment's business, not the user's.
 */
@Injectable({ providedIn: "root" })
export class StudySeedService {
  private askedFor = new Set<number>();

  constructor(
    private http: HttpClient,
    private userService: UserService,
    private config: GuiConfigService
  ) {
    this.userService.userChanged().subscribe(user => {
      if (!user || this.askedFor.has(user.uid) || !this.copilotEnabled()) return;
      this.askedFor.add(user.uid);
      this.http
        .post<StudySeedStatus>("/api/agents/seed", {})
        .pipe(catchError(() => of(undefined)))
        .subscribe();
    });
  }

  private copilotEnabled(): boolean {
    try {
      return this.config.env.copilotEnabled;
    } catch {
      return false;
    }
  }
}
