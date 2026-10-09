"""Path layout for the LongDS harness inside the dataflow-agent repo.

LongDS used to live inside the KramaBench repo (`Kramabench/longds/`); it now
lives here, parallel to the KramaBench submodule:

    dataflow-agent/
    └── benchmark/
        ├── Kramabench/        KramaBench submodule (systems/, kb.py, data/, .venv)
        └── longds/            this harness
            ├── DataMind/      read-only upstream clone (zjunlp/DataMind) — judge
            │                  prompt + the HF dataset download target (gitignored)
            ├── prepared/      prepare.py output: manifest.json + gold.json per task
            └── system_scratch/  run artifacts, one dir per SUT/task (gitignored)

The KramaBench submodule still provides the Python machinery (`systems.*`,
`dataflow_agent.py`, its `.venv`) and the `data/` tree the agent reads through:
`Kramabench/data/longds` symlinks to `DataMind/longds/dataset/data/longds` here,
and the dataflow-agent repo root symlinks `data/` to `Kramabench/data`, so the
relative path `data/longds/...` resolves identically in this harness, in the
JVM services, and in the Python UDF workers.
"""
import sys
from pathlib import Path

LONGDS_ROOT = Path(__file__).resolve().parent          # benchmark/longds
BENCH_ROOT = LONGDS_ROOT.parent                        # benchmark/
REPO_ROOT = BENCH_ROOT.parent                          # dataflow-agent repo root
KB_ROOT = BENCH_ROOT / "Kramabench"                    # the KramaBench submodule

DATAMIND = LONGDS_ROOT / "DataMind" / "longds" / "dataset"
UPSTREAM_PROMPT = (
    LONGDS_ROOT / "DataMind" / "longds" / "runners" / "DSGym" / "scripts" / "prompt.py"
)
PREPARED = LONGDS_ROOT / "prepared"
SCRATCH = LONGDS_ROOT / "system_scratch"

#: Reached through KB_ROOT so the emitted inventory paths stay `data/longds/...`
DATA_REL_ROOT = "data/longds"


def add_import_paths() -> None:
    """Make `systems.*` / `dataflow_agent` (KramaBench) and this dir importable."""
    for p in (str(KB_ROOT), str(LONGDS_ROOT)):
        if p not in sys.path:
            sys.path.insert(0, p)
