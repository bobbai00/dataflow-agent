DA-Code subset support

plot_capture.py saves a real Matplotlib figure and the metadata needed by
DA-Code's image metric. Place a pinned, reference-free upstream image
inspector beside it as plot_inspector_upstream.py, retaining the original
Plotprocess.plot_process methods and removing the inspector's import-time
invocation. save_figure(fig, filename) writes the image, dabench/plot.json,
and dabench/result.npy from that figure. The same adapter is used by native
Dataflow Python and the smolagents executor. The pinned inspector's source
and gold answers are not bundled here.

The shared data-science guidance comes from SINGLE_TASK_ANALYSIS_PRINCIPLES
in agent-service/src/agent/prompts.ts, backed by
agent-service/src/agent/prompts/single-task-principles.md. Export it from
the repository root:

  bun -e 'import { SINGLE_TASK_ANALYSIS_PRINCIPLES } from "./agent-service/src/agent/prompts"; process.stdout.write(SINGLE_TASK_ANALYSIS_PRINCIPLES + "\n");'

Pass the exported text through CodeAgent(..., instructions=principles).
The native system prompt includes it already. Keep one source of truth
instead of maintaining a separate DA-Code prompt copy.

Offline capture checks, from the repository root:

  .venv/bin/python -m pytest -q benchmark/dacode/test_plot_capture.py

The bounded 2026-10-08 campaign is recorded under
reports/20261008-prompt-refactor-subset/. It contains eight file-based tasks,
four native data/flow evidence combinations, and a custom smolagents arm:
40 attempts, one per task and configuration. REPORT.txt explains results
and benchmark limitations; manifest.json records the frozen protocol and
content hashes; scores.json preserves compact per-attempt scores, usage,
cost, and validation. manual-audit.json records six reviewed mechanisms.
These committed summaries exclude raw conversations, provider request
files, credentials, input datasets, gold files, and machine-specific paths.
