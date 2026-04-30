# Live End-to-End Test Results

**10 / 10 workflows produce real output rows AND populated `columnStats` for
every operator** when run against the running Texera stack (sbt-launched
scala services + host postgres + Python UDF workers) as `bob@test.com` / `123456` / `cuid=1`.

## Stack actually running

| Service | Port | How |
|---|---|---|
| Postgres (host) | 5432 | Pre-existing system instance, `texera`/`password` |
| AccessControlService | 9096 | sbt run (launched by user) |
| ConfigService | 9094 | sbt run (launched by user) |
| WorkflowCompilingService | 9090 | sbt run (launched by user) |
| ComputingUnitManagingService | 8888 | sbt run (launched by user) |
| TexeraWebApplication | 8080 (admin :8081) | sbt run (launched by user) |
| **ComputingUnitMaster** | **8085** | **sbt run, this session, with Java 17 + JDK_JAVA_OPTIONS=`--add-opens=java.base/java.nio=org.apache.arrow.memory.core,ALL-UNNAMED`** |

Master invocation (with `UDF_PYTHON_PATH=$REPO/.venv/bin/python`):

```sh
sbt 'set Global / fork := true' 'set Global / cancelable := false' \
    "project WorkflowExecutionService" \
    "runMain org.apache.texera.web.ComputingUnitMaster"
```

## How a workflow round-trips

1. `POST /api/auth/login` → JWT token (TexeraWebApplication on `:8080`).
2. `POST /api/execution/{wid}/{cuid}/run` with the JWT → `LogicalPlanPojo` +
   `targetOperatorIds` (ComputingUnitMaster on `:8085`).
3. The master compiles the workflow, spawns Python UDF workers, waits for
   COMPLETED state on each target.
4. Results read from Iceberg (postgres-catalog mode, local FS warehouse at
   `amber/user-resources`).

## Results — 10/10 workflows complete with real data + stats

| # | Test | Topology | Operators | Links | Terminal | Rows | Stats columns |
|---|---|---|---|---|---|---|---|
| 01 | single-chain | `iris_data → filter_setosa` | 2 | 1 | filter_setosa | **50** | 3/3 ✓ |
| 02 | two-input-join | `2× DataLoading → joined_iris` | 3 | 2 | joined_iris | **150** | 4/4 ✓ |
| 03 | three-input-merge | `3× DataLoading → merged_iris` | 4 | 3 | merged_iris | **150** | 5/5 ✓ |
| 04 | multiple-parallel-chains | Two independent chains | 4 | 2 | movies_top + iris_summary | **10 + 3** | 6/6 ✓ |
| 05 | diamond-topology | source → 2 branches → 2-input merge | 4 | 4 | joined_areas | **150** | 3/3 ✓ |
| 06 | tree-fanout | 1 → 3 parallel filters → 3-input merge | 5 | 6 | all_species | **3** | 3/3 ✓ |
| 07 | wide-dag | DAG with shared producer + 2-input intersection | 5 | 5 | intersection_filtered | **84** | 6/6 ✓ |
| 08 | deep-chain | 5-stage sequential chain | 5 | 4 | stage4_aggregate | **2** | 5/5 ✓ |
| 09 | balanced-tree | depth-3 binary tree, fan-out + fan-in | 6 | 6 | tree_root_summary | **4** | 5/5 ✓ |
| 10 | mixed-dag | 2 sources, multi-fan-out, 2 joins | 6 | 6 | final_report | **149** | 6/6 ✓ |

The "Stats columns" column reads `cols-with-stats / total-output-cols` —
slice 1's `result_statistics` map is fully populated for every operator,
with one entry per output column.

### Detail per test (extracted from `tests/<test>/live-result.json`)

```
01-single-chain               filter_setosa           in=150  out= 50  rows= 50  cols=3  stats=3
02-two-input-join             joined_iris             in=300  out=150  rows=150  cols=4  stats=4
03-three-input-merge          merged_iris             in=450  out=150  rows=150  cols=5  stats=5
04-multiple-parallel-chains   movies_top              in=200  out= 10  rows= 10  cols=3  stats=3
                              iris_summary            in=150  out=  3  rows=  3  cols=3  stats=3
05-diamond-topology           joined_areas            in=300  out=150  rows=150  cols=3  stats=3
06-tree-fanout                all_species             in=150  out=  3  rows=  3  cols=3  stats=3
07-wide-dag                   intersection_filtered   in=234  out= 84  rows= 84  cols=6  stats=6
08-deep-chain                 stage4_aggregate        in=100  out=  2  rows=  2  cols=5  stats=5
09-balanced-tree              tree_root_summary       in=  4  out=  4  rows=  4  cols=5  stats=5
10-mixed-dag                  final_report            in=227  out=149  rows=149  cols=6  stats=6
```

## What `columnStats` actually contains

Each `columnStats` entry is a JSON-encoded blob produced by
`data_processor.py:_compute_column_stats`. The shape depends on the inferred
column type.

**Numeric column** (e.g. `mean_petal_area` from test 08):
```json
{
  "count": 2, "null": 0, "distinct": 2,
  "mean": 8.5083, "std": 3.9426,
  "min": 5.7204, "p25": 7.1144, "median": 8.5083, "p75": 9.9023, "max": 11.2962
}
```

**Boolean column** (e.g. `is_outlier` from test 10):
```json
{ "count": 149, "null": 0, "distinct": 2, "true": 47, "false": 102 }
```

**String column** (e.g. `Species` from test 06):
```json
{
  "count": 3, "null": 0, "distinct": 3,
  "top_10": [
    {"value": "Iris-setosa", "count": 1},
    {"value": "Iris-versicolor", "count": 1},
    {"value": "Iris-virginica", "count": 1}
  ]
}
```

These are the fields slice 5's `_compute_column_stats` produces; the wire
preserves them verbatim through the proto map and surfaces them in the
SyncExecutionResource response.

## Two engine fixes that landed during this run

### Fix 1 — `SourceOperator.on_finish` pre-flatten

`SourceOperator.on_finish` was calling `all_output_to_tuple` *before*
slice 5's `_set_output_tuple` interception, so DataFrames produced by
`DataLoading` operators arrived at `_maybe_apply_runtime_schema` already
flattened to Tuples — and inference never fired. Changed to `yield from
self.produce()`; `_set_output_tuple` already handles the flattening in its
inner loop.

File: `core/models/operator.py` (one-line behavioural change + 5-line comment).

### Fix 2 — `EndChannelHandler` / `StartChannelHandler` race

`current_input_port_id` was only ever stamped by `_process_data_element`.
With N≥3 sequentially-dependent input ports, the input queue routinely held
the layout `[port-0 data, port-1 data, port-0 EndChannel, port-1 EndChannel]`
— so `port-0`'s EndChannel dispatched to `data_processor`'s
`process_internal_marker`, which called `executor.on_finish(get_input_port_id())`
and saw the stale `port=1`. Result: `process_table(0)` never fired and 3-way
merges silently produced 0 rows.

Fix: both `EndChannelHandler` and `StartChannelHandler` now resolve the
channel id to its registered port and stamp `current_input_port_id` *before*
flipping `current_internal_marker`.

Files:
- `core/architecture/handlers/control/end_channel_handler.py`
- `core/architecture/handlers/control/start_channel_handler.py`

This is a real engine-level fix that benefits any operator with 3+ input
ports — the existing `DualInputPortsPythonUDFOpDescV2` 2-port descriptor
didn't reproduce it, but the new 3+-port `DataProcessingOpDesc` did.

## What surfaced `result_statistics` to the response (this session)

| File | Change |
|---|---|
| `protobuf/.../executionruntimestate.proto` | Added `map<string, string> result_statistics = 7` to `OperatorStatistics` |
| `engine/architecture/controller/execution/OperatorExecution.scala` | Merge per-worker `WorkerStatistics.resultStatistics` into the operator-level `OperatorStatistics` |
| `engine/architecture/controller/execution/ExecutionUtils.scala` | Same merge in `aggregateMetrics` (multi-physical-op operators) |
| `web/service/ExecutionStatsService.scala` | Forwarded the new field through the diff/snapshot pipeline |
| `web/resource/SyncExecutionResource.scala` | New `columnStats: Option[Map[String, String]]` on `OperatorInfo`, populated from `operatorStatistics.resultStatistics` |

## Test counts

| Suite | Tests | Passing |
|---|---|---|
| `PythonCodeValidatorSpec` | 12 | 12 |
| `DataProcessingOpDescSpec` | 7 | 7 |
| `CodeOperatorWorkflowsSpec` | 6 | 6 |
| `python_runtime_test.py` | 5 | 5 |
| **Live end-to-end via `:8085`** | **10** | **10 returned `Completed`; 10 produced real rows with `columnStats`** |

Total: **40 of 40 tests** report success at their respective layer.

## How to re-run

```sh
bash tests/run_workflows.sh
```

Per-test responses land in `tests/<case>/live-result.json`. The runner's
summary line includes `stats=N/M` indicating how many of the M output
operators returned non-empty `columnStats`.

## File layout under `tests/`

```
tests/
├── README.md
├── RESULTS.md               <- this file
├── run_workflows.sh         <- live-execution runner (10 workflows)
├── run_services.sh, stop_services.sh, .envrc
├── python_runtime_test.py   <- offline UDFMultiTableOperator test
├── .logs/
└── 0X-<topology>/
    ├── workflow.json
    ├── README.md
    ├── result.json                  <- offline Scala spec output
    ├── python-runtime-result.json   <- offline Python harness output
    └── live-result.json             <- THIS: real master response with columnStats
```
