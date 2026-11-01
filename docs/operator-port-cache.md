# Operator port result cache

The engine reuses a materialized output port from an earlier execution of the
same workflow when nothing upstream of that port has changed. An entry is keyed
by workflow, port, and a SHA-256 hash of the port's upstream sub-DAG; the cached
data is the Iceberg result table that the producing execution wrote. Reuse is
forced: a port the run needs that has an entry is always read from that entry and
never recomputed, and an operator whose needed outputs all come from cache does
not run. There is no cost model and no on/off switch (`cache.enabled` in
`common/config/src/main/resources/application.conf` is not read by any code).

| Step | Code | What happens |
| --- | --- | --- |
| Lookup | `WorkflowExecutionService.executeWorkflow` | after compiling, fingerprint every output port and fetch the matching rows |
| Plan | `CacheReusePreSchedulingStep`, then `CostBasedScheduleGenerator` | decide which operators run; bind consumers to cached tables |
| Run | `RegionExecutionManager` | skipped regions complete at once, without workers |
| Write | `PortCompletedHandler` → `PortMaterialized` → `ExecutionCacheService` | each completed, materialized output port upserts its row |
| Report | `ExecutionCacheUsageStore`, `SyncExecutionResource` | the sync response says which results came from cache |
| Remove | `removeAllExecutionFiles`, workflow FK cascade | rows go when their producing execution or the workflow is deleted |

## Cache key

`FingerprintUtil.computeSubdagFingerprint(plan, port)` walks upstream from the
port's physical operator (`getUpstreamPhysicalLinks`, transitively) and builds
a JSON payload with sorted keys and sorted lists:

- `version` (currently 2);
- `targetPort`: the `GlobalPortIdentity` string;
- every operator in the sub-DAG, the port's own operator included: physical and
  logical operator id, the SHA-256 of its `opExecInitInfo` proto string (class
  name plus serialized descriptor, or code plus language), and each output
  port's id, internal flag and schema string (or "not available");
- every link among those operators: from/to operator, port id and internal flag.

`fingerprint_json` is that JSON and `subdag_hash` is its SHA-256. Consequences:

- A change to an upstream operator's definition, schema or wiring gives a new
  hash and a miss. A change in a part of the workflow that is not upstream does
  not.
- Reverting a change brings back the old hash, so the old row matches again if
  it still exists.
- Operator ids are part of the key. The same computation under a new operator id
  misses.
- Workflow and execution ids are not in the payload. Entries are scoped to one
  workflow by the row's `workflow_id`; nothing is shared across workflows.
- The data a source reads is not in the key. A source whose definition is
  unchanged but whose input changed in place still hits.
- Version 2 stores a digest per operator instead of the program text, which keeps
  the JSON small for long generated Python programs. Rows written under version 1
  never match.

## Table

`operator_port_cache`, as defined in `sql/texera_ddl.sql`. Primary key
`(workflow_id, global_port_id, subdag_hash)`.

| Column | Content |
| --- | --- |
| `workflow_id` | FK to `workflow(wid)`, `ON DELETE CASCADE` |
| `global_port_id` | serialized `GlobalPortIdentity` (`GlobalPortIdentitySerde`) |
| `subdag_hash` | SHA-256 of `fingerprint_json` |
| `fingerprint_json` | the canonical payload |
| `result_uri` | the producing execution's result URI (`<port base>/result`) |
| `tuple_count` | output row count from runtime statistics, when known |
| `source_execution_id` | the execution that wrote the table |
| `result_statistics_json` | unused: nothing reads or writes it |
| `updated_at` | `DEFAULT now()`, refreshed on every upsert |

`OperatorPortCacheDao` has four methods: `get` (by primary key), `upsert`,
`listBySourceExecutionIds` and `deleteBySourceExecutionIds`.
`OperatorPortCacheService.lookupResultUrisInCache` also queries the table
directly.

`sql/updates/26.sql` (changeSet 26 in `sql/changelog.xml`, added by upstream
Texera #5967) creates a table with the same name but different columns
(`cache_key_hash`, `cache_key_json`, `storage_uri`, and no
`result_statistics_json`). The DAO matches `texera_ddl.sql`, not that migration.

## Lookup at submission

`WorkflowExecutionService.executeWorkflow` serves both the websocket path and the
sync REST path (`POST /api/execution/{wid}/{cuid}/run`). After compiling the
workflow, it calls `OperatorPortCacheService.lookupCachedOutputs(workflowId,
physicalPlan)`. That method fingerprints every output port of every physical
operator, internal ports included, and issues one `dao.get` per port. Hits go to
two places:

- `WorkflowSettings.cachedOutputs`: a `Map[String, CachedOutput]` keyed by the
  serialized port id. It reaches the coordinator inside the `WorkflowContext` and
  replaces whatever the request carried.
- `executionStateStore.cacheUsageStore`: an `ExecutionCacheUsageStore` with one
  `CachedPortUsage` per hit (port, logical operator, subdag hash, tuple count,
  source execution id; never the URI). This store does not publish to the
  websocket (`ExecutionStateStore.getAllStores` leaves it out). Only
  `SyncExecutionResource` reads it.

## Planning

`WorkflowScheduler.updateSchedule` keeps the full physical plan and runs
`CacheReusePreSchedulingStep.prepare` before `CostBasedScheduleGenerator` (Pasta).
With no hits, `prepare` passes the plan through unchanged and scheduling is the
same as without a cache. With at least one hit:

1. **Requiredness.** The seed ports are `outputPortsNeedingStorage`: the external
   output ports of terminal operators and of operators whose results the request
   asks to view. The step repeats topological passes until nothing changes. An
   operator that has a required output with no entry is marked to execute, and
   every output port that feeds one of its input links becomes required. Ports
   with an entry never cause their operator to execute.
2. **Skipped regions.** Every operator not marked to execute is skipped: its
   required outputs all have entries, or nothing that runs needs it. The skipped
   operators are grouped into connected components. Each component becomes a
   `Region` with `cached = true`, and its `ResourceConfig` holds an
   `OutputPortConfig(materialize = false)` for each required port with an entry
   that the region owns.
3. **Residual plan.** The plan is cut down to the operators that execute and the
   links into them from required ports without an entry. The planning
   `outputPortsNeedingStorage` becomes the seeds without an entry.
4. **Hints** (`PreSchedulingHints`):
   - `outputPortConfigOverrides`: when an executing operator also has a required
     output with an entry, that output gets `OutputPortConfig(storageURIBase =
     cached base, cachedTupleCount, materialize = false)`. It is reuse-only and is
     not written again.
   - `inputPortUriOverrides`: an executing operator's input that is fed by a port
     with an entry is bound to the cached table. The cache stores the result URI;
     `cachedPortBaseURI` decodes it with `VFSURIFactory` and rebuilds the port base
     under the source execution, because readers derive `<base>/result`
     themselves.
5. **Search and compose.** `CostBasedScheduleGenerator` runs its usual search on
   the residual plan, and `createRegions` merges the hints into the region port
   configs. `composeWithLeadingRegions` then puts all skipped regions in level 0,
   renumbers the region ids, and appends the search's levels.

The physical plan itself is never changed; the residual plan exists only for
planning. A region is either fully skipped or fully executed.

## Runtime

`RegionExecutionManager` handles the two kinds of region.

- **Skipped region** (`region.cached`). `completeCachedRegion` creates operator
  executions but no workers. It then sets synthetic metrics through
  `OperatorExecution.setCachedMetrics`: state `COMPLETED_FROM_CACHE`, `-1`
  (unknown) for every input port count, an output count from `cachedTupleCount`
  (or `-1`) for each reuse-only port, and zero workers and times. Every operator
  in the region gets this state, including one that has no entry of its own (for
  example, an operator upstream of a hit). For each reuse-only port, it writes the
  cached result URI into `operator_port_executions` under the current execution
  (`WorkflowExecutionsResource.insertOperatorPortResultUri`). It sends one
  `ExecutionStatsUpdate` and sets the phase to `CompletedFromCache`. Cached
  operators report every port as completed, so the region counts as completed.
- **Executed region.** `registerReuseOnlyOutputPortResults` records the cached URI
  for each `materialize = false` output. Storage is created only for
  `materialize = true` outputs, and workers get an empty storage URI for
  reuse-only ones. Cache-fed inputs go through the normal materialization readers
  (`InputPortMaterializationReaderThread`,
  `input_port_materialization_reader_runnable.py`). On the JVM side, a missing
  table fails the read with "Error reading cached input".

Related state handling: `COMPLETED_FROM_CACHE` is defined in `controlreturns.proto`
and is `"CompletedFromCache"` as a string (`Utils.aggregatedStateToString`). In
`ExecutionUtils.aggregateStates`, a logical operator is `COMPLETED_FROM_CACHE` only
when all of its physical operators are; mixed with completed operators, it is
`COMPLETED`. The synthetic metrics are part of `getAllRegionExecutionsStats`, so
they also appear in `RuntimeStatisticsPersist` snapshots. Do not read them as
measured costs.

## Writing entries

`PortCompletedHandler` checks each output port when it completes on all workers
of its operator. If the region's `OutputPortConfig` for that port has
`materialize = true`, the handler:

1. looks up the port's result URI in `operator_port_executions`
   (`getResultUriByPhysicalPortId`; `ExecutionResultService` wrote that row on
   `OperatorPortResultUriAvailable`),
2. reads the tuple count from the operator's runtime statistics, and
3. sends `PortMaterialized(portId, resultUri, tupleCount)` to the client.

If there is no URI row, it sends nothing.

`ExecutionCacheService` (one per execution) handles `PortMaterialized`. It calls
`OperatorPortCacheService.upsertCachedOutput`, which recomputes the fingerprint
from the execution's physical plan and upserts the row with
`source_execution_id` set to this execution. On a primary-key conflict, the
upsert overwrites `result_uri`, `fingerprint_json`, `tuple_count` and
`source_execution_id` and refreshes `updated_at`. Upsert errors are logged and do
not fail the run.

So every port that the schedule materializes gets an entry: terminal and viewed
outputs without an entry, and outputs on edges the scheduler chose to
materialize. A row is written as soon as its port completes, and a later failure
in the run does not remove it.

## Who reads reuse information

- **`SyncExecutionResource`** reports operator state `CompletedFromCache` and
  treats it as completed when it waits for target operators. With
  `structuredResults`, `StructuredResultTransport.materialization` and
  `inputMaterializations` use the `cacheUsageStore` entries. An operator whose
  output port 0 was a hit is reported with `cached = true`, the source execution
  id and the `subdagHash`. In `inputMaterializations`, an operator that is
  `CompletedFromCache` but has no entry of its own is reported with
  `cached = true` and no provenance.
- **Result reads.** `WorkflowExecutionsResource.getResultUriByLogicalPortId`
  serves the sync response, `ExecutionResultService` and `ResultExportService`.
  When an execution's `operator_port_executions` rows are gone, it falls back to
  the cache row whose `source_execution_id` is that execution and whose URI
  encodes that execution and the row's workflow.
  `benchmark/prepbench/export_result.py` uses a similar fallback.
- **agent-service** treats `CompletedFromCache` or `materialization.cached` as a
  cached result (`agent-service/src/api/operator-result-summary.ts`,
  `agent-service/src/agent/tools/dataflow-action-runtime.ts`). On the agent's
  snapshot results, the frontend draws a blue border and a "cached" pill
  (`JointUIService.setOperatorSnapshotResult`). The frontend's `OperatorState` has
  no `CompletedFromCache` member. When the live websocket statistics frame
  carries that state, `JointUIService.changeOperatorState` falls through to its
  default (gray) color.

## Removal and cleanup

Nothing compares old rows against the current workflow and evicts them. A changed
upstream simply produces a new hash, and old rows stay until one of the
following removes them. There is no eviction, TTL or storage quota.

- **Deleting executions** (`PUT /api/executions/delete_executions`, `DELETE
  /api/quota/deleteCollection/{eid}`, both through
  `WorkflowExecutionsResource.removeAllExecutionFiles`).
  `OperatorPortCacheService.invalidateCacheBySourceExecutions` lists the rows
  whose `source_execution_id` is being deleted. It removes the
  `operator_port_executions` rows of any execution that point at those URIs,
  deletes the cache rows, and drops the tables.
- **Deleting the workflow** (`POST /api/workflow/delete`). The foreign-key cascade
  removes the rows.
- **Idle cleanup** (`WorkflowService.clearExecutionResources`).
  `WorkflowLifecycleManager` runs it once the workflow has had no connected user
  and no running execution for `web-server.workflow-state-cleanup-in-seconds`
  (30 by default). It removes
  the executions' `operator_port_executions` rows and drops their result
  documents, but skips any URI still referenced by `operator_port_cache`
  (`lookupResultUrisInCache`). Cache rows and their tables survive, so reuse works
  across idle periods such as the gaps between agent turns.

## Known gaps

- **Deleting a consumer can break the producer's entry.** If an execution reused
  a cached port, deleting that execution can drop the producer's table. The
  reusing execution's `operator_port_executions` row points at that table, and
  `removeAllExecutionFiles` does not skip URIs still in `operator_port_cache`
  (idle cleanup does). The producer's row survives, so later hits resolve to a
  dropped table.
- **Deleting a workflow can leave tables behind.** Workflow deletion drops only
  the tables listed in `operator_port_executions`. After idle cleanup, the
  cache-backed tables are listed only in `operator_port_cache`, and the cascade
  deletes those rows, so the tables stay in storage.
- **Changes to source data go unseen.** The key does not cover the data a source
  reads (see [Cache key](#cache-key)).
- **Loops get no special handling.** Ports inside a loop body are keyed and
  reused like any other port.

## Code map

| File | Role |
| --- | --- |
| `common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/cache/FingerprintUtil.scala` | fingerprint payload and hash |
| `common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/WorkflowSettings.scala` | `CachedOutput`, `WorkflowSettings.cachedOutputs` |
| `amber/src/main/scala/org/apache/texera/web/service/OperatorPortCacheService.scala` | lookup, upsert, invalidation by source execution |
| `amber/src/main/scala/org/apache/texera/web/dao/OperatorPortCacheDao.scala` | jOOQ access to `operator_port_cache` |
| `amber/src/main/scala/org/apache/texera/web/service/WorkflowExecutionService.scala` | lookup at submission; fills `cacheUsageStore` |
| `amber/src/main/scala/org/apache/texera/web/service/ExecutionCacheService.scala` | `PortMaterialized` → upsert |
| `amber/src/main/scala/org/apache/texera/web/service/WorkflowService.scala` | one `OperatorPortCacheService` per workflow service; idle cleanup |
| `amber/src/main/scala/org/apache/texera/amber/engine/architecture/coordinator/WorkflowScheduler.scala` | runs the pre-scheduling step, then Pasta |
| `amber/src/main/scala/org/apache/texera/amber/engine/architecture/coordinator/CacheReusePreSchedulingStep.scala` | requiredness, skipped regions, residual plan, hints |
| `amber/src/main/scala/org/apache/texera/amber/engine/architecture/scheduling/PreSchedulingHints.scala` | hint types |
| `amber/src/main/scala/org/apache/texera/amber/engine/architecture/scheduling/CostBasedScheduleGenerator.scala` | applies hints in `createRegions`; `composeWithLeadingRegions` |
| `amber/src/main/scala/org/apache/texera/amber/engine/architecture/scheduling/config/PortConfig.scala` | `OutputPortConfig.materialize`, `cachedTupleCount` |
| `amber/src/main/scala/org/apache/texera/amber/engine/architecture/scheduling/Region.scala` | `Region.cached` |
| `amber/src/main/scala/org/apache/texera/amber/engine/architecture/scheduling/RegionExecutionManager.scala` | skipped-region completion, reuse-only bindings |
| `amber/src/main/scala/org/apache/texera/amber/engine/architecture/coordinator/execution/OperatorExecution.scala` | `setCachedMetrics` / `clearCachedMetrics` |
| `amber/src/main/scala/org/apache/texera/amber/engine/architecture/coordinator/promisehandlers/PortCompletedHandler.scala` | emits `PortMaterialized` |
| `amber/src/main/scala/org/apache/texera/amber/engine/architecture/coordinator/ClientEvent.scala` | `PortMaterialized` event |
| `amber/src/main/scala/org/apache/texera/web/storage/ExecutionCacheUsageStore.scala`, `amber/src/main/scala/org/apache/texera/web/model/websocket/event/CachedPortUsage.scala` | per-execution list of hits |
| `amber/src/main/scala/org/apache/texera/web/resource/SyncExecutionResource.scala`, `amber/src/main/scala/org/apache/texera/web/service/StructuredResultTransport.scala` | `CompletedFromCache` and materialization provenance in the sync response |
| `amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/workflow/WorkflowExecutionsResource.scala` | `removeAllExecutionFiles`, `getResultUriByLogicalPortId`, `insertOperatorPortResultUri`, `getResultUriByPhysicalPortId` |
| `sql/texera_ddl.sql` | table definition |

Tests: `FingerprintPayloadSpec` (common/workflow-core) and `FingerprintUtilSpec`
(amber) cover the key. `StructuredResultTransportSpec` covers the provenance
fields. `WorkflowExecutionsResourceSpec` covers the cached-producer fallback in
`getResultUriByLogicalPortId`. `CacheReusePreSchedulingStep` and the skipped-region
runtime path have no unit tests.
