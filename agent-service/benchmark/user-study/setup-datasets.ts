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

/**
 * Load the user study's data files into two Texera datasets, one per scenario,
 * owned by the study account and public, so every participant's account can
 * read them, and print the dataset paths the agent reads them by. Re-running
 * only makes an existing dataset public when it is not.
 *
 *   STUDY_DIR=~/Desktop/user-study bun run benchmark/user-study/setup-datasets.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDataset,
  createDatasetVersion,
  listDatasets,
  login,
  presignDatasetFile,
  toggleDatasetPublicity,
  uploadFileToDataset,
} from "../../src/api";
import { STUDY, studyLogin } from "./study";

const SCENARIOS: Array<{ dataset: string; folder: string; description: string }> = [
  {
    dataset: STUDY.datasets[1],
    folder: "scenario-1",
    description: "User study, scenario 1: Olympic golds and geography, 2006-2016",
  },
  {
    dataset: STUDY.datasets[2],
    folder: "scenario-2/data",
    description: "User study, scenario 2: SF Airbnb listings, September 2026",
  },
];

const token = await studyLogin(login);
const owner = STUDY.ownerEmail;
for (const { dataset, folder, description } of SCENARIOS) {
  const dir = join(STUDY.dir, folder);
  const files = readdirSync(dir)
    .filter(name => name.endsWith(".csv"))
    .sort();
  const first = `/${owner}/${dataset}/v1/${files[0]}`;
  if (await presignDatasetFile(token, first)) {
    console.log(`${dataset}: already there (${first} resolves)`);
    // Participants read the files from their own accounts, so the dataset must be public.
    const existing = (await listDatasets(token)).find(d => d.dataset.name === dataset && d.isOwner);
    if (existing && !existing.dataset.isPublic) {
      await toggleDatasetPublicity(token, existing.dataset.did);
      console.log(`${dataset}: made public (did=${existing.dataset.did})`);
    }
    continue;
  }
  const created = await createDataset(token, dataset, description, true, true);
  const did = created.dataset.did;
  for (const name of files) {
    await uploadFileToDataset(token, did, name, readFileSync(join(dir, name)), "user study data");
    console.log(`${dataset}: uploaded ${name}`);
  }
  const version = await createDatasetVersion(token, did, "");
  console.log(`${dataset}: did=${did} version=${version.datasetVersion.name}`);
}
for (const { dataset, folder } of SCENARIOS) {
  const files = readdirSync(join(STUDY.dir, folder))
    .filter(name => name.endsWith(".csv"))
    .sort();
  for (const name of files) {
    const path = `/${owner}/${dataset}/v1/${name}`;
    console.log(`${(await presignDatasetFile(token, path)) ? "ok " : "MISSING"} ${path}`);
  }
}
