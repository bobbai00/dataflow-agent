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

import { Elysia } from "elysia";
import { resolve, join, normalize, extname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger";

const log = createLogger("Dashboard");

/** Absolute path to `src/dashboard/dist`. Resolved once at module load. */
const DIST_DIR = resolve(fileURLToPath(new URL("./dist", import.meta.url)));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a requested URL path within `DIST_DIR`, refusing anything that
 * escapes the root via `..`. Returns `null` for traversal attempts or
 * misses.
 */
function safeJoin(distDir: string, requestPath: string): string | null {
  const cleaned = requestPath.replace(/^\/+/, "");
  const target = normalize(join(distDir, cleaned));
  if (!target.startsWith(distDir)) return null;
  return target;
}

/**
 * Mount the dashboard SPA at `/dashboard/*`. The SPA is a static asset
 * bundle in `src/dashboard/dist/`. If the bundle is missing — i.e. the
 * developer hasn't run `bun run dashboard:build` yet — every request
 * returns a small HTML page with build instructions instead of a 404, so
 * the failure mode is obvious.
 */
export const dashboardPlugin = new Elysia({ name: "dashboard" })
  .get("/dashboard", ctx => serveStatic(ctx, "index.html"))
  .get("/dashboard/", ctx => serveStatic(ctx, "index.html"))
  .get("/dashboard/*", ctx => {
    const rest = (ctx.params as Record<string, string>)["*"] ?? "";
    return serveStatic(ctx, rest || "index.html");
  });

/** Loose shape of the bits of Elysia's request context we touch. Avoids
 *  importing Elysia's full `Context` type (which is heavily parameterized
 *  by the route's schema), at the cost of a small `as` cast on `headers`
 *  whose declared element type is `string | number`. */
type CtxLike = { set: { status?: number | string; headers: Record<string, string | number> } };

async function serveStatic(ctx: CtxLike, relPath: string) {
  if (!existsSync(DIST_DIR)) {
    ctx.set.status = 503;
    ctx.set.headers["content-type"] = "text/html; charset=utf-8";
    return MISSING_BUNDLE_PAGE;
  }

  const target = safeJoin(DIST_DIR, relPath);
  if (!target) {
    ctx.set.status = 400;
    return "bad path";
  }

  const file = Bun.file(target);
  if (await file.exists()) {
    ctx.set.headers["content-type"] = contentType(target);
    return file;
  }

  // Hash-based routing means the SPA only ever needs `index.html` plus its
  // bundled assets — no client-side path fallback. A miss here is a real
  // 404 (typo, stale link to a removed asset).
  ctx.set.status = 404;
  log.warn({ relPath }, "dashboard asset not found");
  return "not found";
}

const MISSING_BUNDLE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dashboard not built</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #1f2933; }
  code { background: #f1f4f8; padding: 0 .25rem; border-radius: 3px; }
  h1 { font-size: 1.1rem; }
  pre { background: #1f2933; color: #f5f7fa; padding: .75rem 1rem; border-radius: 6px; overflow-x: auto; }
</style>
</head><body>
<h1>Agent dashboard isn't built yet</h1>
<p>The agent service can host the trace dashboard at <code>/dashboard</code>, but
the bundle in <code>src/dashboard/dist/</code> is missing. Build it once:</p>
<pre>cd agent-service
bun run dashboard:build</pre>
<p>Then reload this page. During active UI work, <code>bun run dashboard:dev</code>
rebuilds the bundle on every change.</p>
</body></html>`;
