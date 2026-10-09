# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
"""Prepare a private profile for the supported bin/local-dev.sh launcher."""
import argparse
import json
import re
import shlex
from pathlib import Path

import yaml
from dotenv import dotenv_values

BASE_PORTS = {"postgres": 5432, "minio": 9000, "lakefs": 8000,
              "lakekeeper": 8181, "litellm": 4000, "config-service": 9094,
              "access-control-service": 9096, "file-service": 9092,
              "workflow-compiling-service": 9090, "computing-unit-managing-service": 8082,
              "texera-web": 8080, "computing-unit-master": 8085, "frontend": 4200,
              "pekko": 2552, "manager-api": 8888, "web-admin": 8081}


def prepare(root: Path, state: Path, project: str, offset: int, agent_port: int):
    if (not re.fullmatch(r"[a-z][a-z0-9-]+", project)
            or project in {"texera-local-dev", "texera-single-node"} or offset <= 0):
        raise ValueError("Use a distinct project and positive port offset")
    ports = {name: port + offset for name, port in BASE_PORTS.items()}
    ports["agent-service"] = agent_port
    if any(p < 1024 or p > 65535 for p in ports.values()) or len(set(ports.values())) != len(ports):
        raise ValueError("Invalid or overlapping isolated ports")
    if any(p in BASE_PORTS.values() or p in {3001, 3007, 3021} for p in ports.values()):
        raise ValueError("Ports overlap the known shared stack")
    root, state = root.resolve(), state.resolve()
    state.mkdir(parents=True, exist_ok=True)
    compose_root = root / "bin/single-node"
    infra = {k: str(v) for k, v in dotenv_values(compose_root / ".env").items() if v is not None}
    infra.update({k: str(v) for k, v in dotenv_values(root / ".env").items() if v is not None})
    for key, value in list(infra.items()):
        infra[key] = value.replace("texera-postgres", "postgres").replace("texera-minio", "minio").replace("texera-lakefs", "lakefs")
    infra.update(STORAGE_S3_ENDPOINT="http://minio:9000", MINIO_PORT=str(ports["minio"]),
                 TEXERA_HOST="http://localhost", STORAGE_ICEBERG_CATALOG_TYPE="postgres")
    env_path = state / "infra.env"
    env_path.touch(mode=0o600)
    env_path.chmod(0o600)
    env_path.write_text("".join(f"{key}={shlex.quote(value)}\n" for key, value in sorted(infra.items())))
    config = yaml.safe_load((compose_root / "docker-compose.yml").read_text())
    names = ["postgres", "minio", "minio-init", "lakefs", "litellm"]
    services = {key: config["services"][key] for key in names}
    for name, service in services.items():
        service["container_name"] = f"{project}-{name}"
        if "env_file" in service:
            service["env_file"] = [str(env_path)]
        if name in BASE_PORTS:
            service["ports"] = [f"127.0.0.1:{ports[name]}:{BASE_PORTS[name]}"]
        volumes = []
        for volume in service.get("volumes", []):
            src, *rest = volume.split(":")
            if src.startswith("."):
                src = str((compose_root / src).resolve())
            volumes.append(":".join([src, *rest]))
        if volumes:
            service["volumes"] = volumes
    services["lakefs"]["environment"] = [
        f"LAKEFS_BLOCKSTORE_S3_PRE_SIGNED_ENDPOINT=http://localhost:{ports['minio']}",
        "LAKEFS_BLOCKSTORE_S3_CREDENTIALS_ACCESS_KEY_ID=${STORAGE_S3_AUTH_USERNAME}",
        "LAKEFS_BLOCKSTORE_S3_CREDENTIALS_SECRET_ACCESS_KEY=${STORAGE_S3_AUTH_PASSWORD}"]
    config = {"services": services, "networks": {"default": {}},
              "volumes": {"minio_data": {}, "postgres_data": {}}}
    (state / "compose.json").write_text(json.dumps(config, indent=2))
    (state / "empty-overlay.yml").write_text("services: {}\n")
    endpoint = lambda name: f"http://localhost:{ports[name]}"
    profile = {
        "TEXERA_LOCAL_DEV_DIR": str(state), "TEXERA_LOCAL_DEV_PORT_OFFSET": str(offset),
        "TEXERA_AGENT_SERVICE_PORT": str(agent_port), "TEXERA_DOCKER_PROJECT": project,
        "TEXERA_DOCKER_COMPOSE_FILE": str(state / "compose.json"),
        "TEXERA_DOCKER_OVERLAY_FILE": str(state / "empty-overlay.yml"),
        "TEXERA_DOCKER_ENV_FILE": str(env_path), "TEXERA_POSTGRES_CONTAINER": f"{project}-postgres",
        "TEXERA_COMPOSE_S3_ENDPOINT": "http://minio:9000", "TEXERA_HOME": str(root),
        "STORAGE_ICEBERG_CATALOG_TYPE": "postgres", "STORAGE_S3_ENDPOINT": endpoint("minio"),
        "STORAGE_LAKEFS_ENDPOINT": endpoint("lakefs") + "/api/v1",
        "STORAGE_JDBC_URL": f"jdbc:postgresql://localhost:{ports['postgres']}/texera_db?currentSchema=texera_db,public",
        "STORAGE_JDBC_URL_FOR_TEST_CASES": f"jdbc:postgresql://localhost:{ports['postgres']}/texera_db_for_test_cases?currentSchema=texera_db,public",
        "STORAGE_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME": f"localhost:{ports['postgres']}/texera_iceberg_catalog",
        "TEXERA_DASHBOARD_SERVICE_ENDPOINT": endpoint("texera-web"),
        "TEXERA_FILE_SERVICE_ENDPOINT": endpoint("file-service"),
        "TEXERA_COMPUTING_UNIT_ENDPOINT": endpoint("manager-api"),
        "WORKFLOW_COMPILING_SERVICE_ENDPOINT": endpoint("workflow-compiling-service"),
        "WORKFLOW_EXECUTION_SERVICE_ENDPOINT": endpoint("computing-unit-master"),
        "TEXERA_LOCAL_CU_URI": endpoint("computing-unit-master"),
        "TEXERA_AGENT_SERVICE_ENDPOINT": endpoint("agent-service"),
        "FILE_SERVICE_GET_PRESIGNED_URL_ENDPOINT": endpoint("file-service") + "/api/dataset/presign-download",
        "FILE_SERVICE_UPLOAD_ONE_FILE_TO_DATASET_ENDPOINT": endpoint("file-service") + "/api/dataset/did/upload",
        "LLM_ENDPOINT": endpoint("access-control-service"), "LITELLM_BASE_URL": endpoint("litellm"),
        "CODE_AGENT_API_BASE": endpoint("litellm"), "AMBER_MASTER_PORT": str(ports["pekko"]),
        "GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED": "true", "UDF_PYTHON_PATH": str(root / ".venv/bin/python"),
    }
    yaml_ports = {"CONFIG_SERVICE": "config-service", "ACCESS_CONTROL_SERVICE": "access-control-service",
                  "FILE_SERVICE": "file-service", "WORKFLOW_COMPILING_SERVICE": "workflow-compiling-service",
                  "COMPUTING_UNIT_MANAGER": "manager-api", "COMPUTING_UNIT_MANAGER_ADMIN": "computing-unit-managing-service",
                  "WEB": "texera-web", "WEB_ADMIN": "web-admin", "MASTER": "computing-unit-master"}
    for key, name in yaml_ports.items():
        profile[f"TEXERA_{key}_PORT"] = str(ports[name])
    (state / "profile.sh").write_text("".join(f"export {key}={shlex.quote(value)}\n" for key, value in sorted(profile.items())))
    manifest = {"root": str(root), "state": str(state), "project": project, "ports": ports}
    (state / "isolation.json").write_text(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state", type=Path)
    parser.add_argument("--project", default="texera-multiturn-mvp")
    parser.add_argument("--offset", type=int, default=10000)
    parser.add_argument("--agent-port", type=int, default=3031)
    args = parser.parse_args()
    print(json.dumps(prepare(Path(__file__).resolve().parents[3], args.state, args.project, args.offset, args.agent_port), indent=2))
