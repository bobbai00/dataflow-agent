# Agent Trace Dashboard

A lightweight web UI, hosted by the agent service itself, for inspecting how an
agent built a workflow turn-by-turn. The dashboard reads the same `ReActStep`
and `SnapshotData` records that the benchmark trace files (e.g.
`system_scratch/.../react_steps.json`) capture, but it pulls them **live** from
the running agent service rather than from disk.

## Goal

When the developer opens the dashboard and picks an agent, they should see, at a
glance, *how that agent was built*:

1. Every ReAct step the agent has taken so far, in order.
2. The data-flow DAG that those steps produced, rendered as a clean directed
   acyclic graph.
3. A way to **replay** the trace — step through it, with the workflow and
   operator results re-rendering at each point in history.
4. Each step's output (tool result, operator preview rows, errors, console
   logs) shown in a tabular / beautified format.
5. Token-usage analytics:
   - per-step usage (input / output / cached),
   - accumulated usage over the trace,
   - hotspots (top-N most expensive steps).
6. A view of the **snapshot tree** — the versioned workflow + per-operator
   results that back the trace — so the user can pick any node and replay
   from there, not just the linear ReAct order.

Keep it **simple and beautiful** — not a re-implementation of the main Texera
workbench. Think "trace viewer" / "agent post-mortem", not "IDE".

## Reuse existing types

The dashboard does **not** invent its own trace model. It consumes the same
types the agent service already defines, so the wire format is whatever
`JSON.stringify` produces from these:

- **`src/types/agent.ts` → `ReActStep`** — each row in the timeline; carries `usage` for token charts.
- **`src/types/agent.ts` → `AgentInfo`, `AgentState`, `AgentDriverKind`** — agent-list rendering + status badges.
- **`src/types/agent.ts` → `TokenUsage`** — token-analytics panel.
- **`src/types/agent.ts` → `AgentSettingsApi`** — read-only settings inspector on the trace view.
- **`src/agent/workflow-snapshot-storage.ts` → `SnapshotData`, `ResolvedSnapshotEntry<T>`** — snapshot-tree viewer + "what did the workflow look like at step N" replay.
- **`src/types/workflow.ts` → `WorkflowContent`** (operator / link shapes) — DAG rendering.
- **`src/types/execution.ts`** — execution / operator-result summary shapes for step-detail tables and node-status colors.

The frontend imports these via a path alias (`import type { ReActStep } from
"@agent-service/types/agent"`) so when a field is added or renamed on the
server, the dashboard fails to typecheck instead of silently going stale.

## Data sources

The dashboard is a thin client over the agent service's existing HTTP + WS
surface (see `agent-service/src/server.ts`). No new backend storage is added.

- `GET /api/agents` — list all live agents.
- `GET /api/agents/:id` — agent metadata + workflow at HEAD.
- `GET /api/agents/:id/react-steps` — the full ReAct trace.
- `GET /api/agents/:id/operator-results` — operator results at HEAD.
- `GET /api/agents/:id/workflow` — workflow at HEAD.
- `GET /api/agents/:id/snapshots/:stepId` — workflow + visible operator results at step `:stepId` (use `head` to mean the agent's current HEAD).
- `WS  /api/agents/:id/react` — live step / snapshot / state stream.
- `POST /api/agents` + `POST /api/agents/:id/import-react-steps` — the
  existing pair used by the **Import** dialog to hydrate offline traces;
  see "Importing traces" below.

The `snapshots/:stepId` endpoint is what powers **linear replay**: feed it any
`stepId` from the trace and it returns the workflow + operator results visible
at that moment in history (via `WorkflowSnapshotStorage.getAllVisibleResults`'s
ancestor walk). Use the literal `head` alias for the agent's current HEAD.

For the **snapshot-tree** view we expose one new read-only endpoint (small
addition to `server.ts`, no new storage):

```
GET /api/agents/:id/snapshot-tree
→ {
    rootId: string,
    nodes: Array<{
      id: SnapshotData["id"],
      parentId: SnapshotData["parentId"],
      reactStepId: SnapshotData["reactStepId"],
      operatorCount: number,
      resultCount: number,
    }>
  }
```

It walks `WorkflowSnapshotStorage.snapshots` and returns the tree shape only
— actual workflow + results for any node are fetched lazily through the
existing `/snapshots/:stepId` endpoint (using the snapshot's `reactStepId` as
the alias, since that endpoint is already keyed by ReAct step).

Token usage lives on each `ReActStep.usage` (`inputTokens`, `outputTokens`,
`totalTokens`, `cachedInputTokens`) — no extra endpoint needed.

## Features

### Agent list (landing page)

- Table of every agent currently in `agentStore`, with id, name, model, driver
  (`vercel-tool-use` / `local-react`), state, created-at, and a quick
  step-count badge.
- Clicking an agent opens its trace view.
- Auto-refresh by polling `GET /api/agents` every few seconds — agents come
  and go as users create / delete them.
- An **Import** button (top-right) opens the import dialog below.

### Importing traces

Lets the developer load offline `react_steps.json` files into the live agent
service so the dashboard can render them just like a fresh run. **All file
scanning is done in the browser** — no server-side filesystem access. Every
discovered trace is hydrated through the existing wire APIs:

1. `POST /api/agents` with a placeholder `modelType` (e.g. `"imported"`) to
   allocate a fresh agent shell.
2. `POST /api/agents/:id/import-react-steps` with the parsed
   `{ steps, snapshots? }` body — this is the agent service's existing
   import endpoint, so the snapshot tree, HEAD, and per-operator results
   are rebuilt by the server exactly as they were during the original run.

Three modes, exposed as a tabbed dialog:

- **Single file.** `<input type="file" accept=".json">`. Reader parses the
  file, validates it has a `steps` array, derives an agent name from the
  filename (or first user-task `content` snippet), and runs the
  two-call import flow above. One agent created per file.
- **Folder (flat).** `<input type="file" webkitdirectory>`. The browser
  hands us every file under the picked folder; we keep only entries
  at the *immediate* depth whose name ends in `.json`. The dialog lists
  the candidates with parsed metadata (step count, first user task)
  and a checkbox per row so the user can drop anything spurious before
  hitting Import. One agent created per selected file.
- **Folder (recursive).** Same `webkitdirectory` input, but we walk the
  full tree (any depth) and keep entries whose **basename matches a
  configurable pattern** — defaults to `react_steps.json` (the
  Kramabench layout), shown in a small text box so the user can change
  it to e.g. `*.trace.json`. Same checkbox-preview UI before import.
  One agent created per selected match.

Bulk imports surface a per-row progress chip (`queued` → `creating` →
`importing` → `done` / `error`) and never abort the whole batch on a single
failure. After the dialog closes, the agent list refreshes and the
newly-imported agents appear at the top, sorted by import time.

Hard constraints baked into the design:

- Every byte of the trace flows through `POST .../import-react-steps`. The
  dashboard never invents its own ingestion path — it cannot drift from how
  the server interprets a trace.
- No new server-side filesystem APIs are added. "Provide a folder name"
  means the user picks a directory via the native picker; we then scan
  the resulting `File[]` array in JS.
- The fetched JSON shape is whatever `getReActSteps()` / `getAllSteps()`
  returns from the server — the same shape `react_steps.json` files on
  disk already use — so existing benchmark traces import without
  conversion.

### Trace view (per agent)

Three-pane layout with a top toolbar that holds the **view-mode knobs**:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [ReAct list] [Snapshot tree] [DAG]   ◀ ◀◀ ▶▶ ▶   [▶ Auto-play  1×▾]   │
├────────────────────────────────┬─────────────────────────────────────────┤
│ Steps timeline (left, scroll)  │ Data-flow DAG (top right)               │
│  ▸ 0  initialize               │  ┌─────┐    ┌────────┐    ┌─────────┐  │
│  ▸ 1  createOrModifyOperator   │  │scan │──▶│ filter │──▶│ project │  │
│  ▸ 2  createOrModifyOperator   │  └─────┘    └────────┘    └─────────┘  │
│  ▸ 3  executeWorkflow          │                                         │
│  ▸ 4  finalAnswer  ✓           │ Step detail (bottom right)              │
│                                │  Thought / Action / Action Input        │
│                                │  Tool result (tabular if rows)          │
│                                │  Token usage chip                       │
└────────────────────────────────┴─────────────────────────────────────────┘
```

The three left-pane modes (toggled from the toolbar) are knobs that control
*how* the user navigates the trace; the right panes always reflect the
currently-selected step / snapshot.

#### Knob 1 — ReAct list

Linear timeline, one row per `ReActStep` in the order returned by
`GET /api/agents/:id/react-steps`. Click a row to seek; the right panes
update via `/snapshots/:stepId`. Highlights the operator(s) the step touched
so the eye can follow the trace through the DAG. This is the default mode.

#### Knob 2 — Snapshot tree

Tree view rendered from `GET /api/agents/:id/snapshot-tree`. Each node is a
`SnapshotData` — the empty root at the top, then one child per
action-bearing ReAct step. Branches appear whenever the agent was checked
out to an earlier step and re-ran from there. Each node shows:

- short snapshot id,
- the `reactStepId` it belongs to (or "root" for the empty root),
- a small badge with `operatorCount` / `resultCount` so heavy nodes stand
  out at a glance.

Clicking a node seeks the right panes to that snapshot — same effect as
seeking via the ReAct list, except the snapshot id is the source of truth.
This is the view to use when the trace has branches; the linear list flattens
them away.

#### Knob 3 — DAG-only

Hides the timeline and expands the DAG to fill the pane. Useful when the
user just wants to study the workflow at a chosen step. Replay controls still
work; the DAG just animates updates as the head moves.

### Replay controls (always visible)

Sit in the top toolbar so they work regardless of the active knob:

- ⏮ first / ◀ prev / ▶ next / ⏭ last — step through ReAct order, or through
  the tree's BFS order when Snapshot-tree mode is active.
- ▶ auto-play — advances by one step at the chosen interval (0.5× / 1× / 2×
  / 4×) until it hits the end or the user pauses.
- A keyboard layer: `←` / `→` to step, `space` to toggle play, `home` / `end`
  to jump to either end.

### Step / snapshot detail (right pane, bottom)

Renders whatever node is selected:

- Assistant `content` (thought), each `toolCall.input` pretty-printed, and
  each `toolResult.output`. When a result is a list of records (operator
  preview rows), render it as a real table with column headers; otherwise
  formatted JSON or text.
- Errors and warnings get a distinct chip.
- A "show input messages" disclosure exposes `ReActStep.inputMessages`
  verbatim — handy for debugging exactly what the model received.

### Live mode

If the agent is still `GENERATING`, the WebSocket stream (`type: "step"`,
`type: "snapshot"`, `type: "headChange"`) appends new steps / snapshots in
real time and the timeline auto-scrolls to the tail — unless the user has
manually seeked away, in which case the new tail is just appended and a
"jump to live" pill appears.

### Token analytics

A collapsible panel (or separate tab) on the trace view:

- **Per-step bar chart** — output vs. input vs. cached tokens, one bar per
  step. Click a bar to seek to that step.
- **Cumulative line** — running total of `totalTokens` across the trace.
- **Hotspots** — top-5 steps by `totalTokens`, with a one-line summary of
  what each did (tool name + first ~80 chars of `content`).

Use a small, dependency-light chart lib (e.g. Recharts or uPlot) — no heavy
analytics stack.

## Architecture

- **Frontend.** React + Vite + TypeScript. State via React Query for the
  HTTP polling and a thin WebSocket hook for live streaming. Layout with a
  utility CSS framework (Tailwind) to keep the surface tiny. DAG rendering
  with `dagre` (layout — already a dependency) + plain SVG or React Flow
  (rendering); start with SVG, promote to React Flow only if interactions
  demand it. Snapshot-tree rendering also goes through `dagre` (top-down
  layout) so we don't pull in a second graph lib.
- **Hosting.** Built assets are served by the agent-service Elysia app under
  `/dashboard/*`. Source lives in `agent-service/src/dashboard/web/`, builds
  into `agent-service/src/dashboard/dist/`, and `server.ts` mounts a static
  handler at startup so opening `http://localhost:3001/dashboard` Just Works.
- **Auto-start.** No separate process. The dashboard is part of the agent
  service binary; when `bun run dev` starts, it's already up. Startup banner
  in `printStartupMessage` should print the dashboard URL alongside the API
  URL.
- **Type sharing.** The Vite project's `tsconfig` adds a path alias pointing
  back at `agent-service/src/types/*` and `agent-service/src/agent/*` so the
  dashboard imports `ReActStep`, `SnapshotData`, etc. directly. No
  duplicated DTOs.
- **Auth.** Same model as the rest of the agent service — none locally;
  delegate tokens flow through unchanged when present.

## Out of scope (for v1)

- Editing the workflow from the dashboard. Read-only viewer.
- Diffing two agents' traces side-by-side.
- Persisting traces across server restarts (the agent service is already
  in-memory; once the agent is deleted, its trace is gone).
- (Was: "loading offline `react_steps.json` files from disk." Now covered
  by the Import dialog — kept here as a note that the import path is
  strictly browser-side, no server-side FS access.)

## Layout on disk

```
agent-service/src/dashboard/
├── README.md          ← this file
├── web/               ← React + Vite source
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api.ts             ← typed wrappers over /api/agents/*
│   │   ├── ws.ts              ← /api/agents/:id/react client
│   │   ├── pages/
│   │   │   ├── AgentList.tsx
│   │   │   └── AgentTrace.tsx
│   │   ├── components/
│   │   │   ├── ImportDialog.tsx     ← single file / flat folder / recursive scan
│   │   │   ├── StepTimeline.tsx     ← Knob 1
│   │   │   ├── SnapshotTree.tsx     ← Knob 2
│   │   │   ├── DagView.tsx          ← Knob 3 + right pane
│   │   │   ├── StepDetail.tsx
│   │   │   ├── ReplayControls.tsx
│   │   │   └── TokenPanel.tsx
│   │   └── styles.css
│   └── vite.config.ts
├── dist/              ← built output (gitignored), served by server.ts
└── static.ts          ← Elysia static-file plugin wiring for /dashboard
```
