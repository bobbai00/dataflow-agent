/*
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

/**
 * Dataset discovery tools.
 *
 * Closes the "agent doesn't know what dataset paths to type" failure mode.
 * The engine resolves source-operator file paths via `FileResolver`, which
 * expects the format `/ownerEmail/datasetName/versionName/file`. The agent
 * has no way to guess owner email or which versions exist, so without these
 * tools it loops on path variants and never converges.
 *
 * These tools query the file-service REST API:
 *   - GET  /dataset/list                                 → datasets the user can read
 *   - GET  /dataset/{did}/version/list                   → versions of a dataset
 *   - GET  /dataset/{did}/version/{dvid}/rootFileNodes   → file tree for a version
 *
 * Both return resolvable paths in the exact format source operators expect,
 * so the agent can paste them straight into a `JSONLFileScan` / `CSVScan`
 * operator's `fileName` property.
 */

import { tool } from "ai";
import { z } from "zod";
import { getBackendConfig } from "../api/backend-api";
import { createErrorResult, createToolResult } from "./tools-utility";

// ─── Tool name constants ──────────────────────────────────────────────────

export const TOOL_NAME_LIST_DATASETS = "listDatasets";
export const TOOL_NAME_LIST_DATASET_FILES = "listDatasetFiles";

// ─── Wire-shape (matches file-service REST responses) ────────────────────

interface DashboardDataset {
  dataset: { did: number; name: string; description?: string };
  ownerEmail: string;
  isOwner: boolean;
  size: number;
}

interface DatasetVersion {
  dvid: number;
  did: number;
  name: string;
  creationTime?: number;
}

interface FileNode {
  // From DatasetFileNode: path is relative to version root, e.g. "subdir/file.jsonl".
  // Directories have non-empty `children`; files have `children: []`.
  parentDir: string;
  name: string;
  size: number;
  type: "file" | "directory" | string;
  children?: FileNode[];
}

interface RootFileNodesResponse {
  fileNodes: FileNode[];
  // ownerEmail / datasetName / versionName are sometimes echoed back — defensive read
  [k: string]: any;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────

async function fetchDatasetApi<T>(
  path: string,
  userToken: string,
): Promise<T> {
  const cfg = getBackendConfig();
  // file-service registers its REST resource at @Path("/dataset"). Talk to
  // it directly on its own port (datasetEndpoint, default :9092) instead of
  // through the main gateway — the gateway proxy mapping isn't a guarantee
  // we want to depend on here.
  const url = `${cfg.datasetEndpoint.replace(/\/$/, "")}/api/dataset${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`GET ${url} → ${resp.status} ${resp.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return (await resp.json()) as T;
}

// ─── File-tree flattening ────────────────────────────────────────────────

/**
 * Walk a FileNode tree, yielding `{ relativePath, size }` for each file
 * (directories are recursed but not emitted). Path is joined with `/`.
 */
function flattenFileTree(nodes: FileNode[], prefix = ""): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  for (const n of nodes) {
    const rel = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === "file" || (n.children && n.children.length === 0 && n.type !== "directory")) {
      out.push({ path: rel, size: n.size });
    } else if (n.children && n.children.length > 0) {
      out.push(...flattenFileTree(n.children, rel));
    }
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─── Tool factory ─────────────────────────────────────────────────────────

export interface CreateDatasetToolsOptions {
  /** Returns the user's JWT for authenticated dataset API calls. */
  getUserToken: () => string | undefined;
}

export function createDatasetTools(opts: CreateDatasetToolsOptions) {
  const { getUserToken } = opts;

  const listDatasets = tool({
    description:
      "List datasets the current user can read. Use this when you need to load data " +
      "from a source operator (JSONLFileScan, CSVScan, etc.) and need to know the " +
      "available datasets and their owner emails. Search is by dataset name only — " +
      "if the user describes the data semantically (\"climate tweets\", \"my CSV file\") " +
      "rather than by exact dataset name, just call without `search` to see all " +
      "available datasets and their files in one round trip.",
    inputSchema: z.object({
      search: z
        .string()
        .optional()
        .describe(
          "Optional case-insensitive substring filter on dataset name. Use only when " +
            "you know an exact substring of the dataset's name. If unsure, omit this " +
            "argument to list all datasets.",
        ),
    }),
    execute: async ({ search }) => {
      const token = getUserToken();
      if (!token) return createErrorResult("No user token available — dataset listing requires an authenticated session.");
      try {
        const datasets = await fetchDatasetApi<DashboardDataset[]>(`/list`, token);
        let filtered = datasets;
        if (search) {
          const s = search.toLowerCase();
          filtered = datasets.filter(d => d.dataset.name.toLowerCase().includes(s));
        }
        // If the search filter matched nothing, fall back to showing all
        // datasets in the same response — saves the agent a second call to
        // discover what's actually available. The agent's named guess
        // (e.g. "climate") often won't match the actual dataset name (e.g.
        // "twitter1"), but the dataset they want is right there in the
        // full list.
        if (filtered.length === 0 && search && datasets.length > 0) {
          const lines: string[] = [];
          lines.push(`No dataset name matches "${search}". Showing all ${datasets.length} accessible datasets instead:`);
          for (const d of datasets) {
            lines.push(
              `  - "${d.dataset.name}" (owner: ${d.ownerEmail}, did=${d.dataset.did}, size: ${formatBytes(d.size ?? 0)})`,
            );
          }
          lines.push("");
          lines.push(
            `Use listDatasetFiles({ datasetName: "<name>" }) to see files inside one. The dataset name is the FULL name shown above, not your search term.`,
          );
          return createToolResult(lines.join("\n"));
        }
        if (filtered.length === 0) {
          return createToolResult("No datasets are accessible to this user.");
        }
        const lines: string[] = [];
        lines.push(`${filtered.length} dataset${filtered.length === 1 ? "" : "s"} accessible:`);
        for (const d of filtered) {
          lines.push(
            `  - "${d.dataset.name}" (owner: ${d.ownerEmail}, did=${d.dataset.did}, size: ${formatBytes(d.size ?? 0)})`,
          );
        }
        lines.push("");
        lines.push(
          `Use listDatasetFiles({ datasetName: "<name>" }) to see versions and file paths inside a dataset.`,
        );
        return createToolResult(lines.join("\n"));
      } catch (err: any) {
        return createErrorResult(`Failed to list datasets: ${err?.message ?? String(err)}`);
      }
    },
  });

  const listDatasetFiles = tool({
    description:
      "List versions and files inside a dataset, returning the EXACT path strings to " +
      "paste into a source operator's fileName property. Without `version`, returns " +
      "all versions plus files in the latest. With `version`, returns files only for " +
      "that version. Use this before configuring any JSONLFileScan / CSVScan / " +
      "TextFileScan source operator — guessing the path syntax does not work.",
    inputSchema: z.object({
      datasetName: z.string().describe("Dataset name (as shown by listDatasets)."),
      version: z
        .string()
        .optional()
        .describe(
          "Optional version name (e.g. 'v1', 'v2'). If omitted, files from the latest " +
            "version are listed.",
        ),
    }),
    execute: async ({ datasetName, version }) => {
      const token = getUserToken();
      if (!token) return createErrorResult("No user token available — dataset listing requires an authenticated session.");
      try {
        // 1. Resolve datasetName → did + ownerEmail
        const datasets = await fetchDatasetApi<DashboardDataset[]>(`/list`, token);
        const matches = datasets.filter(d => d.dataset.name === datasetName);
        if (matches.length === 0) {
          // Be forgiving — try case-insensitive
          const ci = datasets.filter(d => d.dataset.name.toLowerCase() === datasetName.toLowerCase());
          if (ci.length === 0) {
            const available = datasets.slice(0, 10).map(d => d.dataset.name).join(", ");
            return createErrorResult(
              `Dataset '${datasetName}' not found. Available: ${available}${datasets.length > 10 ? ", …" : ""}.`,
            );
          }
          matches.push(...ci);
        }
        if (matches.length > 1) {
          // Ambiguous — multiple datasets share that name across owners.
          const lines = [`Dataset name '${datasetName}' is ambiguous. Pick one:`];
          for (const d of matches) {
            lines.push(`  - did=${d.dataset.did} owner=${d.ownerEmail}`);
          }
          return createErrorResult(lines.join("\n"));
        }
        const ds = matches[0];
        const did = ds.dataset.did;
        const ownerEmail = ds.ownerEmail;

        // 2. List versions
        const versions = await fetchDatasetApi<DatasetVersion[]>(`/${did}/version/list`, token);
        if (versions.length === 0) {
          return createToolResult(
            `Dataset '${datasetName}' (owner ${ownerEmail}) has no versions yet — files cannot be loaded.`,
          );
        }

        // 3. Pick the version: explicit or latest (versions are returned newest-first)
        let chosen: DatasetVersion;
        if (version) {
          const v = versions.find(x => x.name === version);
          if (!v) {
            const names = versions.map(x => x.name).join(", ");
            return createErrorResult(`Version '${version}' not found in dataset '${datasetName}'. Available: ${names}.`);
          }
          chosen = v;
        } else {
          chosen = versions[0];
        }

        // 4. Fetch the file tree for the chosen version
        const tree = await fetchDatasetApi<RootFileNodesResponse>(
          `/${did}/version/${chosen.dvid}/rootFileNodes`,
          token,
        );
        const files = flattenFileTree(tree.fileNodes ?? []);

        // 5. Format response: list versions + paths
        const lines: string[] = [];
        lines.push(`Dataset: "${datasetName}" (owner: ${ownerEmail}, did=${did})`);
        lines.push("");
        lines.push(`Versions (newest first):`);
        for (const v of versions) {
          const marker = v.dvid === chosen.dvid ? " ← showing this version" : "";
          lines.push(`  - "${v.name}"${marker}`);
        }
        lines.push("");
        if (files.length === 0) {
          lines.push(`No files in version "${chosen.name}".`);
        } else {
          lines.push(`Files in version "${chosen.name}" — paste these straight into a source operator's fileName:`);
          for (const f of files) {
            const fullPath = `/${ownerEmail}/${datasetName}/${chosen.name}/${f.path}`;
            lines.push(`  - ${fullPath} (${formatBytes(f.size)})`);
          }
        }
        return createToolResult(lines.join("\n"));
      } catch (err: any) {
        return createErrorResult(`Failed to list dataset files for '${datasetName}': ${err?.message ?? String(err)}`);
      }
    },
  });

  return {
    [TOOL_NAME_LIST_DATASETS]: listDatasets,
    [TOOL_NAME_LIST_DATASET_FILES]: listDatasetFiles,
  };
}
