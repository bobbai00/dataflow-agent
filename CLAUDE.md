# CLAUDE.md

Use the project guidance in [AGENTS.md](AGENTS.md). [README.md](README.md) has the commands to install, launch and test.

## Running one JVM service from sbt

`bin/local-dev.sh` is the supported way to run the stack. To run one service under sbt instead, for a debugger say, stop it
in the launcher first (`bin/local-dev.sh down texera-web`) and run from the repo root with the launcher's database and catalog
settings: the defaults in `storage.conf` do not match the local stack, and jOOQ needs Postgres at compile time.

```bash
GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true \
STORAGE_JDBC_USERNAME=texera STORAGE_JDBC_PASSWORD=password \
STORAGE_ICEBERG_CATALOG_TYPE=postgres \
STORAGE_ICEBERG_CATALOG_POSTGRES_USERNAME=texera STORAGE_ICEBERG_CATALOG_POSTGRES_PASSWORD=password \
UDF_PYTHON_PATH=$PWD/.venv/bin/python TEXERA_HOME=$PWD \
sbt 'WorkflowExecutionService/runMain org.apache.texera.web.TexeraWebApplication'
```

`build.sbt` already forks each `run`, runs it from the repo root and passes the `.jvmopts` flags, so no `set` overrides are
needed. The project names:

| Service | Port | Command |
|---|---|---|
| ConfigService | 9094 | `sbt ConfigService/run` |
| AccessControlService | 9096 | `sbt AccessControlService/run` |
| FileService | 9092 | `sbt FileService/run` |
| ComputingUnitManagingService | 8888 | `sbt ComputingUnitManagingService/run` |
| WorkflowCompilingService | 9090 | `sbt WorkflowCompilingService/run` |
| ComputingUnitMaster | 8085 | `sbt 'WorkflowExecutionService/runMain org.apache.texera.web.ComputingUnitMaster'` |
| TexeraWebApplication | 8080 | `sbt 'WorkflowExecutionService/runMain org.apache.texera.web.TexeraWebApplication'` |

sbt's project lock allows one of these at a time per checkout.

The agent runs separately, under Bun: `cd agent-service && bun run dev` listens on :3001.
