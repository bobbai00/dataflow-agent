# Terra LongDS pilot: fixed small scope

Run exactly four solver sessions: one dataflow full-prompt session and one
DSGym Python session for each of these natural prefixes:

- `community/kaggle-survey-2021/task2`, Q1–Q19.
- `business/netflix_movies_and_tv_shows/task3`, Q1–Q19.

There is one repetition, 76 planned answers across both systems, and no
automatic expansion, additional model arm, or score-selected solver rerun.
The dependency/rollback comparisons at Q19 require the preceding questions;
the pilot does not seed correct historical answers. Stop after these four
sessions and review results before any further spending.

Both systems use `gpt-5.6-terra`, medium reasoning, a 32,000-token estimated
complete-input budget, 40 calls per turn, and 8,192 output tokens per call.
Use the same frozen estimator/scale as the preceding clean-input Luna pilot,
and separately audit observed provider input tokens. DSGym keeps its live
Python kernel and pays Terra for complete older-message compaction. Native
uses the full prompt, ordinary ReAct, thin task dependencies, task-local
historical retrieval, collected statistics and the same retrieval budgets.
Automatic flow evidence remains disabled.

Reuse the exact raw snapshot, prepared task text and successfully reproduced
reference gates from the clean-input Luna pilot after checking their hashes.
References and gold answers remain outside the raw data directories. This is
an informed diagnostic cohort, not a held-out benchmark or model leaderboard.

Freeze Terra accounting at $2/M fresh input, $0.20/M cached input, $2.50/M
reported cache writes and $12/M output. The primary cross-system cost applies
one shared fresh/cache/output policy without an extra cache-write surcharge,
includes summaries and unsuccessful work, and reports missing usage as unknown.
These are estimates; judging is reported separately. Applying the same
uniform policy to the preceding Luna request volumes would imply approximately
$5.39 total solver cost for these four Terra sessions. Actual call counts and
usage can differ, so this is a planning estimate rather than a spending cap.

Report per-case and aggregate official accuracy using the same saved LongDS
binary judge prompt and judge model, calls, paid summaries, complete-input
violations, strict answer validity and estimated cost. Inspect the first
semantic divergence on failed dependent questions. Preserve the frozen Q19
component rubric; unsupported answer layouts remain unscored, with any manual
alias mappings clearly separated from official judgments.

Artifacts: `/var/tmp/dataflow-terra-pilot-20261005`. Use a private agent
service at port 3070 and the existing shared engine services. Remove only
the agents, workflows, computing units and service owned by this pilot.
