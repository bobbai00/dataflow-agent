# Bobflow Local Development

Bobflow is a local development setup for a Texera-based dataflow system with an agent copilot service. The `bin/local-dev` script starts the Docker infrastructure, JVM services, Node/Bun services, RTC websocket service, and Angular frontend needed for the local UI.

## Prerequisites

Install and make sure these commands are available on your `PATH`:

- Docker Desktop or Docker Engine with Docker Compose
- Java 17
- `sbt`
- Node.js 20+
- `yarn`
- `bun`
- Python 3.12, managed with `uv`
- `curl`, `lsof`, `ps`, and `unzip`

Docker must be running before starting the stack.

## Python Environment

Create the repository-local Python environment from the Bobflow repository root:

```bash
uv sync --locked --python 3.12 --extra dev --extra kramabench --no-install-project
```

This creates `.venv` and installs the Python dependencies used by Texera's Python workers and optional benchmark operators. Activating the environment is not required: `bin/local-dev` uses `.venv/bin/python` directly.

You can verify that the environment matches `uv.lock` with:

```bash
uv sync --check --locked --python .venv/bin/python --extra dev --extra kramabench --no-install-project
```

During `bin/local-dev start`, the script checks that `.venv` exists, uses Python 3.12, contains the core worker packages, and is synchronized with `uv.lock`. It stops with the setup command before starting any services if validation fails.

## Required Ports

These ports must be free before running `bin/local-dev start`:

```text
5432   postgres
9000   minio
8000   lakefs
4000   litellm
9094   config-service
9096   access-control-service
9092   file-service
9090   workflow-compiling-service
8888   computing-unit-managing-service
8080   Texera web application
8085   computing-unit-master / workflow execution
3001   agent-service
1234   RTC / y-websocket
4200   frontend
```

If a previous local stack is running, stop it first:

```bash
bin/local-dev stop
```

## API Keys

`ANTHROPIC_API_KEY` must be set before starting local-dev because LiteLLM is part of the stack.

For local plumbing tests, a dummy value is enough:

```bash
export ANTHROPIC_API_KEY=dummy
```

For real copilot/LLM use, set a real provider key. `OPENAI_API_KEY` and `GEMINI_API_KEY` may also be set if the LiteLLM config uses those providers.

## Start

From the Bobflow repository root:

```bash
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-dummy}" bin/local-dev start
```

Open the frontend:

```text
http://localhost:4200
```

Default local login:

```text
username: texera
password: texera
```

Service logs are written under:

```text
/tmp/bobflow-local-dev
```

## Stop

From the Bobflow repository root:

```bash
bin/local-dev stop
```

## Apache Texera Attribution

Bobflow is based on Apache Texera (Incubating), an open-source collaborative data science and workflow system. This project builds on Texera's architecture, services, workflow execution model, and frontend foundation while adding Bobflow-specific local development and agent copilot wiring.

For more about Apache Texera, see:

- https://texera.io
- https://github.com/Texera/texera
