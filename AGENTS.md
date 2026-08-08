<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# AGENTS.md

## Architecture Map

Apache Texera: Scala/sbt backend services + the Amber workflow execution
engine, an Angular UI, and the agent service. JVM modules wired in
[`build.sbt`](build.sbt).

| Area | Path | Detail |
| --- | --- | --- |
| Workflow execution engine (Amber) | `amber/` | [amber/README.md](amber/README.md) |
| Backend services | `config-service/`, `access-control-service/`, `file-service/`, `computing-unit-managing-service/`, `workflow-compiling-service/`, `notebook-migration-service/` | `build.sbt` |
| Shared Scala libs | `common/` (`auth`, `config`, `dao`, `util`, `workflow-core`, `workflow-operator`, `pybuilder`) | `build.sbt` |
| Frontend (Angular) | `frontend/` | [frontend/README.md](frontend/README.md) |
| Agent service (Bun/TS, LLM agents) | `agent-service/` | `agent-service/package.json` |
| Pyright language service | `pyright-language-service/` | [pyright-language-service/README.md](pyright-language-service/README.md) |
| Deploy scripts / Dockerfiles | `bin/` | [README](bin/README.md) / [k8s](bin/k8s/README.md) / [single-node](bin/single-node/README.md) |
| DDL, sbt plugins | `sql/`, `project/` | files therein |

### Amber breakdown

| Path | Role |
| --- | --- |
| `amber/src/main/scala` | Pekko actors, scheduler, reconfiguration, fault tolerance, gRPC/proto |
| `amber/src/main/python/pyamber` | Python engine (`pyamber`) — bridge to the Scala engine |
| `amber/src/main/python/pytexera` | Python operator SDK exposed to UDFs |

## Where Things Live

| Topic | Source of truth |
| --- | --- |
| Contribution / PR / lint / format / testing / license header | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Reporting security issues | [SECURITY.md](SECURITY.md) |
| PR template | [.github/PULL_REQUEST_TEMPLATE](.github/PULL_REQUEST_TEMPLATE) |
| Issue templates | [bug](.github/ISSUE_TEMPLATE/bug-template.yaml) / [task](.github/ISSUE_TEMPLATE/task-template.yaml) / [feature](.github/ISSUE_TEMPLATE/feature-template.yaml) |
| License-header coverage; vendored `workflow-operator` | [.licenserc.yaml](.licenserc.yaml); [project/AddMetaInfLicenseFiles.scala](project/AddMetaInfLicenseFiles.scala) |
| Run the local dev stack (infra in Docker; backend/frontend/agent-service native) | [bin/local-dev.sh](bin/local-dev/README.md) |
| Local single-node / k8s deploy | [single-node](bin/single-node/README.md), [k8s](bin/k8s/README.md) |
| Native full-stack launch/stop + KramaBench one-task validation | [SETUP.md](SETUP.md) |

If a topic is above, **read that file** instead of asking here.

## Agent-Specific Rules

### Scope and safety

- Narrowly scoped changes. No unrelated rewrites or cross-service moves.
- `git status --short` before editing; don't revert unrelated dirty files.
- Never commit secrets / local config / build output / caches / binaries
  (`python_udf.conf`, `.env`, `target/`, `dist/`, `.pytest_cache/`,
  `.ruff_cache/`, logs).

### Develop in a worktree

Leave `texera/` on `main`. One worktree per PR, branched off a freshly
fetched `upstream/main`.

```
texera/                      # stays on main, never dirty
texera-worktrees/<branch>/   # one worktree per PR
```

Reset to `upstream/main` at start; `git log upstream/main..HEAD` should
contain only this PR's commits before pushing; remove the worktree after
merge.

Prefer [`bin/local-dev.sh`](bin/local-dev/README.md) to run the stack while
developing. Its native services bind fixed ports and share one PID/state dir,
so only one worktree's stack runs at a time: `bin/local-dev.sh down` in the
old worktree before switching, then `up` in the new one. Use the
non-interactive CLI subcommands (`up` / `down` / `status` / `logs`); the
interactive TUI (`-i`) is for humans, not agents.

### Environment

| Component | Version |
| --- | --- |
| Java | JDK 17 |
| Scala | 2.13 |
| Python | 3.12 |
| Node | 24 |

One Python venv shared across worktrees, sibling of the texera checkout:

```
<workspace>/
├── texera/                   # main checkout
├── texera-worktrees/<br>/    # per-PR worktrees
└── venv312/                  # shared Python 3.12 venv
```

```bash
python3.12 -m venv ../venv312 && source ../venv312/bin/activate
pip install -r amber/requirements.txt -r amber/operator-requirements.txt
# For pytest or running bin/python-proto-gen.sh, also install dev deps:
pip install -r amber/dev-requirements.txt
```

Tests that spawn Python workers need an interpreter path. Edit `python.path`
in [`udf.conf`](common/config/src/main/resources/udf.conf) or
`export UDF_PYTHON_PATH="$(pwd)/../venv312/bin/python"` (env var overrides).
Without it, `sbt` Python-integration tests fail to launch a worker.

[`.jvmopts`](.jvmopts) holds every `--add-opens` flag Texera needs for
JDK 17+, with each group annotated by its upstream source (Kryo,
Apache Arrow, Apache Pekko). sbt's launcher and the [`.run/`](.run)
configs read it automatically; for raw `java` launches, pass it as an
argfile: `java @.jvmopts -jar …`. If a future library version or a new
code path triggers an `InaccessibleObjectException`, add the open to
`.jvmopts`. [`project/JdkOptions.scala`](project/JdkOptions.scala)
propagates the changed options to forked test JVMs, `Compile / run`
forks (e.g. `sbt <project>/run` and `bgRun`), sbt-native-packager dist
launchers, and IntelliJ.

### Branch and commit naming

Short, **Conventional Commits**, same shape for branch and commit subject.

| Kind | Branch | Commit |
| --- | --- | --- |
| Feature | `feat/agent-workflow-edit` | `feat(agent-service): enable workflow edit` |
| Bug fix | `fix/marker-replay` | `fix(amber): marker replay during reconfiguration` |
| Tests | `test/pyamber-handlers` | `test(pyamber): add handler unit tests` |
| Chore | `chore/angular-21` | `chore(deps): upgrade frontend to Angular 21` |
| CI | `ci/cache-action-bump` | `ci: bump coursier/cache-action to v8.1.0` |

Both ≤ ~60 chars. For code changes, if you use a scope, use the module name
(`amber`, `pyamber`, `frontend`, `agent-service`, `file-service`, …) — not
`amber-python`. Dependency-only updates split by semantics: `fix(deps): ...` for
runtime/production dependency bumps (they ship to users),
`chore(deps): ...` for dev/toolchain-only bumps, and `ci: ...` for
CI-only changes (including GitHub Actions bumps). Append the module
as a second scope when the bump is module-specific, e.g.
`fix(deps, pyamber): ...`; omit it for cross-module bumps (sbt). No `Co-authored-by:` trailer for the repo
owner.

### Issues and PRs

Issue-first; both stay short.

```
issue (template + Type)  ->  PR (Closes #N, template)  ->  review  ->  merge
```

- Every change starts as an issue (minor typo / docs excepted). File against
  `apache/texera`, never a fork.
- Pick the right template **and** set the GitHub Issue **Type** explicitly
  (`Bug` / `Task` / `Feature`); the template's `type:` frontmatter doesn't
  always apply on creation.
- Reference the issue: `Closes #N` (or `Fixes` / `Resolves`, or "related to").
- Issue titles are **plain prose**; never use the Conventional Commits
  format (`type(scope): ...`) — that prefix is for commit and PR titles only.
- Task issues match `task-template.yaml` exactly.
- Prefer **tables** and small **ASCII diagrams** over long bullets. Don't
  restate the diff or the template.
- For bugs, lead with **root cause** and a **before -> after** sketch:
  ```
  Before:  reconfiguration -> replay marker -> worker hangs
  After:   reconfiguration -> replay marker -> resume from checkpoint
  ```
- **Frontend PRs**: any visible UI change requires screenshots / GIF,
  **before / after** side by side. For purely visual fixes that's the
  primary verification under "How was this PR tested?"; interactive flows
  also list manual steps (click path, browser, viewport).

### Tests come first

TDD. Write the test before the source change.

```
write/adjust test (red)  ->  edit source (green)  ->  refactor
```

| Situation | Order |
| --- | --- |
| New feature / behavior change | Failing test, then implement. |
| Bug fix | Regression test reproducing the bug, then fix. |
| Code with **no tests** | **Characterization tests** pin current behavior first; only then change source. |
| Refactor (no behavior change) | Tests stay green throughout — no assertion edits. |

Every test must cover:

- **Both directions**: positive (valid → expected) **and** negative (invalid
  / error → specific failure mode).
- **Edge cases**: empty / null / zero / max / boundary, unicode,
  concurrency/order, missing or malformed config.
- **Don't assume valid.** External input (user / API / file / message) must
  be tested with bad input.

Don't claim "tested" without commands. Paste the exact `sbt testOnly` /
`pytest` / `yarn test:ci` / `bun test` invocation under "How was this PR
tested?".

### CI labels & gating

CI runs are **selected by PR labels**, not by file diff.

```
diff -> pr-labeler -> labels on PR -> required-checks maps labels to stacks -> CI runs
```

- Path → label rules: [`.github/labeler.yml`](.github/labeler.yml)
- Label → stacks (`LABEL_STACKS`, source of truth):
  [`.github/workflows/required-checks.yml`](.github/workflows/required-checks.yml).
  Read it directly; don't duplicate the mapping here.
- Need extra coverage the diff doesn't imply (e.g. a `common/` change you
  suspect breaks the frontend)? **Add the relevant label manually**.
- Empty stack union (docs-only / dev-only / `dependencies` / `feature` /
  `fix` / `refactor` / `release/*` only) skips every build stack on purpose.
- `release/*` labels select backport targets; removing one cancels that
  backport.

## Frontend

The Angular frontend lives in `frontend/`.

- Node engine: `>=20.19.0`.
- Package manager: Yarn 4.14.1 via Corepack.
- Formatting is Prettier plus prettier-eslint. Prettier uses 2 spaces,
  semicolons, double quotes, `printWidth: 120`, and LF endings.
- Unit tests are Karma/Jasmine. Specs should live next to frontend code as
  `.spec.ts` files.

Useful commands:

```bash
cd frontend
corepack enable
corepack prepare yarn@4.14.1 --activate
yarn install --immutable --inline-builds --network-timeout=100000
yarn format:ci
yarn format:fix
yarn lint
yarn test --watch=false
yarn test:ci
yarn build:ci
yarn start
```

For UI changes, include screenshots/GIFs or clear manual verification steps in
the PR description when the behavior is visual or interactive.

## Agent Service

The standalone LLM agent service lives in `agent-service/`.

- Runtime/package tool in CI: Bun 1.3.3.
- Source is TypeScript ESM.

Useful commands:

```bash
cd agent-service
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun test
bun run dev
```

## GitHub PR Writing

Texera requires Conventional Commit PR titles and commit messages. Closed PRs
commonly use titles like:

- `feat(agent-service): enable Texera Agent to do workflow editing and execution`
- `fix(amber): Python internal marker replay during reconfiguration`
- `fix(frontend): version history timestamp display`
- `test(amber-python): add unit tests for evaluate-expression and retry-current-tuple handlers`
- `chore(deps): upgrade frontend to Angular 21`
- `ci: bump coursier/cache-action to v8.1.0`

Use the existing `.github/PULL_REQUEST_TEMPLATE` sections:

- `What changes were proposed in this PR?`
- `Any related issues, documentation, discussions?`
- `How was this PR tested?`
- `Was this PR authored or co-authored using generative AI tooling?`

PR description conventions from recent closed PRs:

- Start with the reason for the change, not just the files touched.
- For bugs, state the root cause and the before/after behavior.
- For features, describe the user-facing capability and key implementation
  pieces.
- Link issues with `Closes #1234`, `Fixes #1234`, or `Resolves #1234` when the
  PR should close the issue.
- Include exact test commands and, when useful, the specific test names or pass
  counts.
- For UI work, add screenshots/GIFs or explicit manual verification notes.
- If no automated tests were added, explain why and list manual tests.
- Answer the AI tooling question explicitly. If AI was used, use the
  `Generated-by: <tool and version>` wording from the template or a similarly
  explicit disclosure. If not, write `No`.

## GitHub Issue Writing

Use the issue templates in `.github/ISSUE_TEMPLATE`.

Bug reports should include:

- What happened and what was expected.
- Reproduction steps that another contributor can run.
- Texera version, usually `1.1.0-incubating (Pre-release/Master)` for current
  main.
- Commit hash when known.
- Browser information for frontend bugs.
- Relevant logs or stack traces in fenced code blocks.

Task and feature issues should include:

- A concise task/feature summary.
- Motivation or user impact.
- Proposed action or scope, ideally as concrete bullets.
- Priority (`P0` through `P3`) and task type.
- File paths, classes, or modules when the work is already localized.

Recent closed issues are usually specific and actionable: they name the failing
test, exact command, affected files/classes, observable symptoms, and expected
fix direction. Preserve that style for future issues.

## Before Opening a PR

Run the narrowest checks that cover the change, then broaden when touching shared
behavior:

- Scala/backend: targeted `testOnly`, then `sbt scalafmtCheckAll`,
  `sbt "scalafixAll --check"`, and `sbt test` as appropriate.
- Python runtime: `ruff check .`, `ruff format --check .`, and targeted/full
  `pytest` from `amber/src/main/python`.
- Frontend: `yarn format:ci`, targeted/full `yarn test:ci`, and
  `yarn build:ci`.
- Agent service: `bun run format:check`, `bun run typecheck`, and `bun test`.

If a full check is too expensive or cannot run locally, state exactly what was
run and why the omitted check was skipped.

## Fork notes (this checkout)

This is a downstream fork. Items below are either fork-specific or non-obvious
gotchas not derivable from a quick read of the tree.

### Branch / PR base

- Active branch: `feat/agent-copilot-refactored`.
- The PR base for this fork's feature work is `feat/agent-copilot` — **not**
  `master` or upstream `main`. Open fork-internal PRs against
  `feat/agent-copilot`; only sync to upstream `main` from the fork's main
  branch.
- `.java-version` pins JDK 17 locally even though upstream CI still uses
  Temurin JDK 11. Local builds may diverge from CI on JVM-version-sensitive
  behavior — verify against CI before assuming a problem is environmental.

### Big-picture architecture (read once, then skim)

`amber/` is one sbt project but contains two logically distinct things, which
is the most common source of "where does this code live" confusion:

1. **Texera web application** under `org.apache.texera.web.*` — Dropwizard
   server (REST + websockets + collaboration). Notable resources:
   `web/resource/aiassistant/` (integration with `agent-service/`),
   `web/model/websocket/`, `web/model/collab/`, `web/auth/`.
2. **Amber dataflow engine** under `org.apache.texera.amber.engine.*` — the
   distributed actor runtime. `engine/architecture/` holds master/worker
   actor code; workers spawn Python sub-processes that load
   `pytexera`/`pyamber`.

Typical workflow request path: Frontend → web app (`amber/`) →
`WorkflowCompilingService` (compiles logical → physical plan) →
`ComputingUnitManagingService` (allocates compute) → Amber engine
(executes, streams state/results back over websockets). The sbt module graph
in `build.sbt` mirrors this — services that compile depend on
`WorkflowOperator`, services that execute depend on `WorkflowExecutionService`.
Operator-semantics changes typically touch `common/workflow-operator` (metadata
+ JSON schema), `common/workflow-core` (physical plan / scheduling), the
engine, and possibly the Python runtime.

### Agent service ↔ Texera

`agent-service/` is a standalone Bun/Elysia process — **not** part of the sbt
build. It's invoked from `web/resource/aiassistant/` with a user JWT + workflow
ID, and:

- Reads/writes workflows via REST (`api/workflow-api.ts`).
- Compiles via `compile-api.ts` (calls `WorkflowCompilingService`).
- Triggers executions via `execution-api.ts`.
- Calls LLMs through the LiteLLM proxy configured in
  `bin/litellm-config.yaml`.

Agent tools live in `agent-service/src/agent/tools/` (CRUD operators,
code-operator authoring, execution); state is in `workflow-state.ts` /
`workflow-result-state.ts`; `AgentMode` selects between system prompts in
`prompts.ts`. **Do not import frontend or amber code from `agent-service/`** —
it's a separate process boundary.

For native full-stack validation with KramaBench, follow
[`SETUP.md`](SETUP.md). The JVM services must be launched with
`GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true`; otherwise AccessControlService
returns `403 {"error": "Copilot feature is disabled"}` for `/api/chat/*`, and
the agent trace ends before tool use.

### Python runtime layout

- `amber/src/main/python/pyamber/` — worker entrypoint, talks to the Scala
  worker over Arrow Flight RPC. `texera_run_python_worker.py` is the script
  entry.
- `amber/src/main/python/pytexera/` — user-facing API that custom Python
  operators import.
- `amber/src/main/python/proto/` — generated; regenerate with
  `bin/python-proto-gen.sh`. The frontend has the parallel
  `bin/frontend-proto-gen.sh` for its TS protos.

### Gotchas

- **Scalafix before scalafmt**, always — `sbt scalafixAll && sbt scalafmtAll`.
  Reverse order can leave fixable lint that the formatter then re-formats.
- **IntelliJ test working directory**: amber tests must run with cwd
  `amber/`; tests for other services run with cwd at the repo root. Wrong cwd
  produces confusing classpath/resource-not-found failures.
- **Pinned dep overrides in `build.sbt`** (don't "upgrade" without checking):
  Jackson is pinned to `2.18.6` per-module because Dropwizard 4 needs ≥
  2.16.1; Netty is pinned to `4.1.96.Final` for Arrow 14 compatibility. See
  the `dependencyOverrides` blocks per project.
- **Frontend monaco aliasing**: `vscode` and `monaco-editor` are aliased to
  `@codingame/monaco-vscode-*` via `resolutions` in `frontend/package.json`.
  Do not "fix" those imports — they're intentional.
- **Licensing settings**: `common/workflow-operator` uses
  `asfLicensingSettingsWithVendored` (it vendors mbknor code under a separate
  attribution); everything else uses `asfLicensingSettings`. Defined in
  `project/AddMetaInfLicenseFiles.scala`.

### Convenience entry points

- `bin/fix-format.sh [--scala|--frontend|--python|--all]` — wraps the three
  formatters; CI checks each independently so you can run just the target you
  touched.
- `.run/*.run.xml` — IntelliJ run configs are the canonical source for main
  classes and JVM args of every service (useful when reading `build.sbt`
  doesn't make it obvious which `Main` to launch).
- `bin/server.sh`, `bin/workflow-computing-unit.sh` — launch from a built
  `amber/target/texera-*` distribution after `bin/build-services.sh`
  (`sbt clean dist` + unzip).
- `tests/` — end-to-end workflow scenarios with `run_services.sh` /
  `run_workflows.sh` / `upload_workflows.py` for driving the live stack via
  REST. These are integration scenarios, not sbt/pytest unit tests.

### Python toolchain

- Supported CI Python versions: 3.10, 3.11, 3.12, 3.13.
- Ruff config is in `amber/src/main/python/pyproject.toml` (this is a
  ruff-only config, separate from the project-level `pyproject.toml` at
  the repo root).
- Ruff line length is 88 and target version is `py310`.
- Generated protobuf code under `amber/src/main/python/proto` is excluded from
  Ruff.

### Dependencies

The project-level `pyproject.toml` at the repo root holds the runtime
Python deps for local development and for the runtime PVE feature (see
`PveManager.scala`, which `pip install`s the project on each PVE
creation). `[project.dependencies]` is the base set; `[project.optional-dependencies]`
defines `dev` (test/lint) and `kramabench` (domain extras). `uv.lock` is
committed.

Local dev:

```bash
uv sync --all-extras   # creates .venv with base + dev + kramabench
.venv/bin/pytest amber/src/main/python   # or whichever target
```

Plain pip also works for one-off installs:

```bash
pip install --extra-index-url https://download.pytorch.org/whl/cpu .
pip install --extra-index-url https://download.pytorch.org/whl/cpu .[dev]
```

The `--extra-index-url` is required for the `torch==2.8.0+cpu` pin on Linux
x86_64. uv reads `[tool.uv.sources]` and handles this automatically; plain
pip needs the flag.

`amber/dev-requirements.txt` still exists separately — it holds CI-only
test deps (currently `pytest-cov`) installed *after* the LICENSE-binary
snapshot so they never appear in `pip-licenses` output.

The legacy `amber/requirements.txt` and `amber/operator-requirements.txt`
have been removed. Some Docker/CI/licensing helpers still reference them
(root `Dockerfile`, `bin/computing-unit-{master,worker}.dockerfile`,
`bin/licensing/check_binary_deps.py`, `.github/labeler.yml`,
`.github/workflows/build.yml`) and will need follow-up work before those
paths can be exercised; they don't affect local development on this
branch.
