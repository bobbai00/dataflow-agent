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

/** What the user-study scripts share: the study account, its datasets, and where the materials are. */
import { homedir } from "node:os";
import { resolve } from "node:path";

export const STUDY = {
  /** The study materials (data, notebook, dataflow plan); the doc's `scenario-1` and `scenario-2` folders. */
  dir: resolve(process.env.STUDY_DIR ?? `${homedir()}/Desktop/user-study`),
  /** The Texera account that owns the datasets and the participants' workflows. */
  username: process.env.STUDY_USERNAME ?? "texera",
  password: process.env.STUDY_PASSWORD ?? "texera",
  /** The owner segment of a dataset path (`/owner/dataset/v1/file`): the account's email. */
  ownerEmail: process.env.STUDY_OWNER_EMAIL ?? "texera",
  /** Scenario 2's name is what `scenario-2/dataflow/make_bobflow_steps.py` writes into the replayed scans. */
  datasets: { 1: "olympics", 2: "sf-airbnb" } as Record<1 | 2, string>,
  files: {
    1: ["athlete_events_2006_2016.csv", "noc_regions.csv", "country_geo.csv"],
    2: ["listings.csv", "reviews_last_12_months.csv", "neighbourhoods.csv"],
  } as Record<1 | 2, string[]>,
  agentBase: process.env.AGENT_BASE ?? "http://localhost:3001",
};

/** The dataset path of one study file, as the agent reads it. */
export function datasetPath(scenario: 1 | 2, file: string): string {
  return `/${STUDY.ownerEmail}/${STUDY.datasets[scenario]}/v1/${file}`;
}

export async function studyLogin(login: (username: string, password: string) => Promise<string>): Promise<string> {
  return login(STUDY.username, STUDY.password);
}
