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

/**
 * Bun-native bundler for the trace dashboard. Runs as:
 *
 *   bun run dashboard:build          # one-shot build
 *   bun run dashboard:dev            # rebuild on every source change
 *
 * Inputs:  src/dashboard/web/main.tsx (+ everything it imports), web/styles.css,
 *          web/index.html (template — copied with the bundled asset names
 *          substituted in).
 * Output:  src/dashboard/dist/{main.js, styles.css, index.html}.
 *
 * Kept dependency-free on purpose: no Vite, no esbuild config, no postcss.
 * Bun's bundler already handles TSX, JSX runtime, source maps, tree-shaking
 * and minification. The watch loop is a 250 ms polling debounce — fine for
 * a single developer; switch to chokidar if anyone needs lower latency.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, statSync, watch, copyFileSync, writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, "web");
const DIST_DIR = resolve(HERE, "dist");
const ENTRY = resolve(WEB_DIR, "main.tsx");
const HTML_TEMPLATE = resolve(WEB_DIR, "index.html");
const CSS_ENTRY = resolve(WEB_DIR, "styles.css");

const watchMode = process.argv.includes("--watch");

async function buildOnce(): Promise<void> {
  const started = Date.now();
  mkdirSync(DIST_DIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: DIST_DIR,
    target: "browser",
    format: "esm",
    minify: !watchMode,
    sourcemap: watchMode ? "inline" : "external",
    naming: {
      entry: "[dir]/main.js",
      chunk: "[name]-[hash].js",
      asset: "[name].[ext]",
    },
  });

  if (!result.success) {
    console.error("dashboard build failed:");
    for (const log of result.logs) console.error(log);
    if (!watchMode) process.exit(1);
    return;
  }

  // Copy CSS verbatim — bundling it through Bun.build would pull it into the
  // JS module graph, which is fine for component-scoped styles but overkill
  // for a single global stylesheet.
  copyFileSync(CSS_ENTRY, resolve(DIST_DIR, "styles.css"));

  // Read the HTML template, substitute asset names, write to dist. Keeping
  // the template editable in web/ rather than generating it from scratch
  // means designers / Claude can iterate on `<title>` and meta tags
  // without touching this script.
  // Asset URLs are absolute (`/dashboard/...`) so that hitting
  // `http://host/dashboard` (no trailing slash) resolves them correctly.
  // With relative URLs the browser would resolve against `/`, missing the
  // `/dashboard/` prefix and 404'ing.
  const html = await Bun.file(HTML_TEMPLATE).text();
  writeFileSync(
    resolve(DIST_DIR, "index.html"),
    html.replace("__MAIN_JS__", "/dashboard/main.js").replace("__STYLES_CSS__", "/dashboard/styles.css")
  );

  const ms = Date.now() - started;
  console.log(`dashboard built → ${DIST_DIR} (${ms}ms${watchMode ? ", watch mode" : ""})`);
}

if (watchMode) {
  await buildOnce();
  let pending: NodeJS.Timeout | null = null;
  const debounce = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      buildOnce().catch(err => console.error("rebuild failed", err));
    }, 250);
  };
  watch(WEB_DIR, { recursive: true }, () => debounce());
  console.log(`watching ${WEB_DIR} for changes…`);
} else {
  await buildOnce();
}
