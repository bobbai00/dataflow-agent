# AGENTS.md

Guidance for coding agents working in the Apache Texera repository.

## Project Overview

Apache Texera is a collaborative data science and AI/ML workflow system. The
repo is a multi-language monorepo with Scala/sbt backend services, Python worker
runtime code, an Angular frontend, and a TypeScript/Bun agent service.

Major areas:

- `amber/`: workflow execution engine, Scala tests, Python worker runtime, and
  Python operator dependencies.
- `common/`: shared Scala modules for auth, config, DAO, workflow core,
  workflow operators, and Python-template building.
- `config-service/`, `access-control-service/`, `file-service/`,
  `computing-unit-managing-service/`, `workflow-compiling-service/`: backend
  services wired through `build.sbt`.
- `frontend/`: Angular application. Uses Yarn 4.14.1, Node >= 20.19.0, Nx,
  Prettier, ESLint, Karma/Jasmine, and ng-zorro.
- `agent-service/`: TypeScript Elysia service for Texera LLM agents. CI uses
  Bun 1.3.3.
- `pyright-language-service/`: TypeScript service for Python language support.
- `sql/`: database DDL used by local runs and CI.
- `bin/`: shell scripts and Dockerfiles for services, local deployment, and
  generated protobuf assets.

## Ground Rules

- Keep changes narrowly scoped. Do not rewrite unrelated files or move code
  between services unless the task explicitly requires it.
- Preserve local user changes. Check `git status --short` before editing and do
  not revert unrelated dirty files.
- Follow existing module boundaries and naming patterns. Prefer local helpers
  and service abstractions over introducing new framework-level utilities.
- Add or update tests when behavior changes. For small UI-only fixes where unit
  tests are not practical, document the manual test steps.
- Never commit secrets, local config, generated build output, caches, or binary
  artifacts. Examples to avoid include `python_udf.conf`, `.env` files, `target/`,
  `dist/`, `.pytest_cache/`, `.ruff_cache/`, and local logs.

## Licensing

- New source/config files should include the Apache 2.0 ASF license header unless
  `.licenserc.yaml` excludes that file type or path.
- Markdown files are excluded from the license-header check.
- Keep third-party/vendored-code attribution intact. `common/workflow-operator`
  has special license handling in `project/AddMetaInfLicenseFiles.scala`.
- GitHub Actions in ASF repositories should use approved actions and preferably
  pinned SHAs, matching the existing workflow style.

## Scala / Backend

- Scala version: 2.13.18.
- Java in CI: Temurin JDK 11.
- Formatting: `.scalafmt.conf` uses scalafmt 2.6.4 with `maxColumn = 100`.
- Lint rules live in `.scalafix.conf` and include `ProcedureSyntax` and
  `RemoveUnused`.

Useful root commands:

```bash
sbt scalafmtCheckAll
sbt scalafmtAll
sbt "scalafixAll --check"
sbt scalafixAll
sbt clean package
sbt test
```

Targeted tests are preferred while iterating. Examples:

```bash
sbt "WorkflowExecutionService/testOnly org.apache.texera.amber.engine.e2e.ReconfigurationSpec"
sbt "WorkflowCompilingService/testOnly *SomeSpec"
```

CI creates PostgreSQL databases from:

```bash
psql -h localhost -U postgres -f sql/texera_ddl.sql
psql -h localhost -U postgres -f sql/iceberg_postgres_catalog.sql
psql -h localhost -U postgres -f sql/texera_lakefs.sql
psql -h localhost -U postgres -v DB_NAME=texera_db_for_test_cases -f sql/texera_ddl.sql
```

## Python Runtime

Python worker code lives primarily under `amber/src/main/python`.

- Supported CI Python versions: 3.10, 3.11, 3.12, 3.13.
- Ruff config is in `amber/src/main/python/pyproject.toml`.
- Ruff line length is 88 and target version is `py310`.
- Generated protobuf code under `amber/src/main/python/proto` is excluded from
  Ruff.

Useful commands:

```bash
cd amber/src/main/python
ruff check .
ruff format --check .
pytest -sv
python -m pytest core/runnables/test_main_loop.py -v
```

Install dependencies from `amber/requirements.txt` and
`amber/operator-requirements.txt` when running the Python runtime or tests
outside CI.

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
