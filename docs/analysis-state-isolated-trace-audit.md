<!--
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements. See the NOTICE file
distributed with this work for additional information
regarding copyright ownership. The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License. You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied. See the License for the
specific language governing permissions and limitations
under the License.
-->

This audit concerns only `LongDS_Isolated_20260924` runs. Earlier unrestricted
runs are excluded from accuracy evidence; see the
[reference-access audit](analysis-state-reference-access-audit.json). The
[score table](analysis-state-isolated-results.md) preserves the judge's labels.
The observations below explain mechanisms without changing those labels.
A [structured case audit](analysis-state-mechanism-audit.json) records artifact
hashes, paired costs, first divergences and proposed counterfactuals.

**Education BI, first pass: smaller context did not reduce cost.** Both native
arms score 28/30, but on different failures. Analysis-state costs $0.09271809
against entries' $0.07478731 (24.0% more), with 77 versus 63 model calls. At the
first call of turn 30, input is 14,415 versus 33,779 tokens. The completed-task
projection is 22,881 versus 91,372 characters. Bounded memory is working, but
extra calls and cache writes outweigh its input savings in this session.

| BI first-pass token category | Analysis-state | Entries |
| --- | ---: | ---: |
| Input | 1,091,284 | 1,403,904 |
| Cached reads | 899,912 | 1,295,188 |
| Cache writes | 191,141 | 108,527 |
| Output, including reasoning | 22,407 | 18,095 |

The candidate submits 47 dataflow calls against 33, including seven observe-only
calls against one. It uses inspection three times and reuses prior functions
without retransmitting them twice, but does not use parameter tables, forks,
historical reads, cross-turn shared-function corrections or cross-turn table
reassignments. Its final graph has 68 operators against 85. This demonstrates
bounded context and some reuse; it does not demonstrate that the new correction
and scenario mechanisms improve autonomous task accuracy.

The two arms' turn-7 numeric results exactly match the reference. Both present
descending values as JSON object properties; the judge demands an explicit
ordered ranking and assigns zero. Entries' other failure, turn 2, is a category
label mismatch: it expands `RSA` to `South Africa` and `Somali` to `Somalia`,
while the reference keeps the original labels. The public request asks for
standardized country names, so this verdict is sensitive to interpretation.
These are not evidence of forgotten state. The official-within-this-experiment
scores remain unchanged.

Analysis-state's other failure, turn 25, is answer serialization. Its raw reply
contains the computed rankings followed by the literal line
`Final Answer: <single-line JSON>`. The existing extractor correctly follows
its configured marker contract and therefore submits that placeholder to the
judge. The computation uses `18-25` where the reference says `<=25`; the raw
reply alone therefore should not be promoted to a passing score. The runtime
and extraction policy are frozen during this comparison.

Evidence: BI
[candidate turn 25](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-analysis_luna_t1/education__bi__task2/turns/t25/react_steps.json),
[candidate judgments](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-analysis_luna_t1/education__bi__task2/results_eval.json),
[entries judgments](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-entries_luna_t1/education__bi__task2/results_eval.json).

**Goodbooks, first pass: ingestion is a separate bottleneck.** Both native arms
exceed the 20-minute client deadline on turn 1. They choose to scan and
materialize the large source tables; both parse 981,756 rating rows, 999,912 tag
associations and 912,705 reading-intent rows. This occurs despite the candidate's
general guidance allowing a vectorized reusable loader that returns a useful
analysis grain. The runner stops and drains the timed-out turn before allowing
turn 2; there is no concurrent-turn overlap. These are valid system failures,
not setup exclusions. Their cost and failed answers remain in the comparison.
The corrected isolated Python baselines read and calculate on the same files.
This argues for measuring source/materialization execution separately from
history retrieval, and for testing how the agent chooses the representation.

Both Python controls also score 0/35, for different observable reasons. Plain
Python's first turn emits an answer claiming the environment returned no data,
without submitting any Python. The reusable-function control's first turn
claims it persisted a working set and points to a nonexistent `.pkl` file,
also without executing code. Later turns do execute successfully, so the first
claims are not evidence that the corrected kernel was unavailable. The two
protocols differ: these controls use the authors' XML-tagged Python interface,
whereas native dataflow uses function tools. This is a system-level comparison;
the matched native entries arm is the stronger control for the new mechanisms.
The raw data directories match their frozen inventories, have no added output
files, and the claimed pickle is not present.

The plain control later emits a concrete ranking with different seed identities;
the guided control reaches some expected seed identities but different numeric
values and cannot reconstruct the final stability summary. Successful code
execution therefore does not imply a correct analytical foundation or preserved
state. The first-pass zero scores are retained, with no attempt to relabel them
as setup failures.

Evidence: Goodbooks
[candidate turn 1](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-analysis_luna_t1/business__goodbooks_10k__task1/turns/t01/react_steps.json),
[entries turn 1](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-entries_luna_t1/business__goodbooks_10k__task1/turns/t01/react_steps.json).

**Water quality, first pass: a measured gain with substantial retrieval cost.**
Analysis-state scores 13/36 versus entries' 9/36, costing $0.37491311 versus
$0.251 (rounded). It makes 169 model calls, including 41 inspection calls and
39 recall calls. No fork, parameter-table assignment or cross-turn shared
correction is submitted. At turn 36 alone, five recall calls retrieve 13 old
tasks before two code calls consolidate the final comparison. The bounded
projection has shifted substantial work into explicit retrieval.

A [declaration-coverage audit](analysis-state-retrieval-audit.json) checks this
across all six first-pass candidate sessions. Of 163 structured inspections
returning functions available in the previous turn's workflow, 149 return at
least one function whose declaration is absent from selected task-start memory.
That accounts for 410 of 537 returned function occurrences; repeated inspections
are counted separately. In Water the corresponding counts are 34/38 calls and
103/148 function occurrences. This is a concrete limit of the bounded selection,
but not a measurement of absence from the entire prompt: a definition can also
appear in the active trace. Declaration names do not establish body equality,
and table bindings or revision metadata can independently justify inspection.
Test selection quality together with cache writes and retrieval calls, rather
than crediting the memory-character reduction alone.

Two of the four score differences are weak evidence of an analytical advantage.
At turn 15, the judge accepts `100_tree_random_forest` for the candidate but
rejects entries' equivalent `random_forest_100` against reference `RF`. At turn
2, both identify the correct feature and class; entries additionally reports an
absolute offset where the reference stores a signed offset, and is penalized
for it. The question asks which feature-class fill is farthest. Keep these
verdicts visible, but do not credit all four differences to improved state.

Turn 16 provides a concrete semantic difference. The candidate inspects the
existing severity and missingness definitions, then computes the absolute gap
in target rate between blank and nonblank rows. Entries instead computes the
gap in blank rate between target classes: it reverses the conditioning variable.
It also uses the larger screened population for the decile comparison, whereas
the candidate explicitly restricts membership to the established narrowed panel.
The resulting answers are 299 rows / 98.6622% overlap (candidate and reference)
versus 315 / 96.8254% (entries). These two differences coexist; this audit does
not isolate a causal effect of inspection alone.

At turn 24, the candidate reopens the latest utility comparison and uses the
persisted feature-selection table to construct its predictor list. Entries
reconstructs a list in new Python code using different earlier components and
then repairs a duplicate-column merge. Candidate identifies the expected
`augmented_risk_high` group; entries identifies `high_pressure_potable`.
This is consistent with the value of explicit component outputs and exact
inspection, but a correct group name does not certify every computed rate.

Evidence: water
[candidate turn 16](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-analysis_luna_t1/geoscience__water-potability__task3/turns/t16/react_steps.json),
[entries turn 16](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-entries_luna_t1/geoscience__water-potability__task3/turns/t16/react_steps.json),
[candidate turn 24](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-analysis_luna_t1/geoscience__water-potability__task3/turns/t24/react_steps.json),
[entries turn 24](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-entries_luna_t1/geoscience__water-potability__task3/turns/t24/react_steps.json),
[candidate turn 36](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-analysis_luna_t1/geoscience__water-potability__task3/turns/t36/react_steps.json).

**Los Angeles, first pass: a source-parsing error survives the whole
analysis.** Analysis-state scores 4/36 versus entries' 10/36 and costs
$0.385890 versus $0.345869. Its initial parser requires exactly one
space after `Class Code:` before a nonspace value, using
`Class Code: ([^\s]+)`. Most actual headers contain several spaces. It therefore
reports 649 missing class codes out of 683 postings; the reference has two.
A read-only intervention changing only that whitespace match is recorded in
[the extraction replay](analysis-state-la-class-code-replay.json), including
source and trace hashes. This is a deterministic parser diagnosis, not a claim
that all later answers become correct after that one repair.

Turn 2 still answers the requested leading roles correctly, despite the broken
class-code extraction. Later class-level scores differ after collapsing repeated
announcements. This illustrates why a passing answer cannot certify the complete
working state. Shared definitions can propagate a discovered correction, but
the agent first needs to detect the suspect extraction and choose to correct it.
The new memory representation alone does not establish that behavior. Entries'
parser captures the whole class-code line and then strips it, avoiding the
candidate's single-space/nonspace failure on most files, though it still reports
six missing codes rather than two. Neither initial parser is fully correct.

Evidence: Los Angeles
[candidate turn 1](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-analysis_luna_t1/social_good__data_science_for_good_city_of_los_angeles__task1/turns/t01/react_steps.json),
[candidate judgments](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-analysis_luna_t1/social_good__data_science_for_good_city_of_los_angeles__task1/results_eval.json).

All six first-pass pairs are complete. Recovery trials are reported separately;
the task-macro accuracy and cost comparison below uses the frozen first pass.

The completed survey pair illustrates both directions of the tradeoff. The
candidate scores 19/30 and entries 27/30 under the uniform wall budget; the
candidate attempted 28 and answered 27 questions before expiry. Two questions
were never submitted. Entries finished all 30 in 16.3 minutes. These are bounded
session results, not equal numbers of completed turns.

- **Candidate-only, turn 15:** entries misidentified `lc_user_types.csv` as an
  organizational planning distribution, combined 69 and 44, and reported 113%.
  The public `introduction.md` contains the actual four planning categories
  (41, 10, 28, 21), which the candidate eventually found and combined to 51%.
  Its ten calls cost $0.01945839 versus four calls/$0.00582775. Five recall calls
  searched old tasks for a source that was already in the initial inventory;
  one exceeded the three-task limit and was rejected. Finding the right public
  source explains the accuracy difference; this is not evidence that extensive
  history retrieval was necessary.
- **Entries-only, turn 18:** both arms correctly computed role intensity in
  turn 13. The candidate persisted only the top five results and nested the
  experience-anchor calculation inside that function. When it needed the full
  distribution in turn 18, it rebuilt the formula and reversed `adopter_share -
  all_share` to `all_share - adopter_share`. Its mean became 3.9136 rather than
  2.7385. Entries kept the complete role-intensity table and reused it; it also
  corrected an initially wrong top-five industry input to the complete industry
  table. The first consequential representation difference is visible in turn
  13, and the formula drift is explicit in turn 18. A full reusable component
  table plus a separate presentation limit would avoid this particular rebuild.
  Shared-function support cannot protect a computation the agent duplicates
  under a different name.
- **Both pass, entries cheaper, turn 9:** candidate costs $0.01379457/7 calls
  versus $0.00384390/2 calls. It first exceeded the recall limit, then guessed
  Q20 as industry, received an error, and searched two ranges of survey fields
  before correcting to Q24. Entries loaded the relevant fields directly with
  the already established Q24 identity. Both report the same counts and rates.
  Repeated discovery and error recovery explain this cost gap.
- **Both pass, candidate cheaper, turn 16:** candidate costs $0.005270 versus
  entries $0.00862235. Entries first gave a zero-input loader an input parameter,
  corrected that arity error, then fetched one row omitted from the result
  sample. This is an execution/observation difference, not sufficient evidence
  for a general context advantage.

The water turn-20 judge passes require caution: both answers say the earlier
rate is lower, which matches the requested comparison, but both also supply
rates that differ from the reference (candidate 26.0000/28.8889; entries
28.0000/43.1818; reference 18.0000/31.8182). The candidate spent eight calls and
$0.01685845 versus two calls/$0.00648041. Treat this as agreement on the requested
Boolean comparison, not validated numerical equivalence of the full analyses.

A plain-Python survey recovery (trial 2) initially ended after 14 answers when
its agent subprocess received SIGTERM during a large CSV print in turn 15. The
log reached 987,133,960 bytes. The signal sender and cause were initially unknown.
A later coordinated termination also stopped 17 other Python recovery attempts,
both unfinished native NFL first passes, the agent service and its engine.
Accordingly, all unexpected SIGTERM attempts are now consistently archived
under `LongDS_IsolationInterrupted_20260924` and excluded from accuracy, including
that earlier survey attempt. They are restarted from scratch without selecting
on score. Captured spending and any existing judgments remain in the ledger.
The deliberate one-hour budget stops remain valid failures.

A second coordinated termination near 16:00 UTC interrupted six native
recovery attempts. Their completed-turn traces and captured spending are
preserved under the same ineligible prefix; none is promoted to a completed
recovery or scored as a model failure. The 56 completed, fully judged sessions
survived this restart. The signal source was initially unknown.

A third SIGTERM reached the supervised campaign controller near 16:43 UTC;
its wrapper then shut down the experiment's services. Five unfinished sessions
are preserved under `LongDS_IsolationInterrupted3_20260924`. The NFL control
had completed all 42 answers before shutdown and is retained (16/42). At that
point, 58 sessions were fully scored and fourteen planned recovery sessions
remained incomplete; the complete first pass is unchanged. Rollouts were paused until the
system journal identified `earlyoom.service` as the source of all three
coordinated events. Low available RAM and swap triggered its SIGTERM policy;
its preference for Python selected the evaluation controllers. These were
deployment resource failures, not evidence of interference by another tenant.

The fourteen missing sessions resumed from the verified frozen R3 checkout
after unused services were retired. They now run in three-session waves inside
a 20 GiB memory-limited system service, with admission thresholds and idle-agent
recycling. Both frozen-runtime engine preflights passed. This changes resource
contention, not model prompts or the one-hour session policy. Keep all 31
interrupted attempts and their spending visible: the completed-session accuracy
comparison is conditional on surviving the deployment resource limits. See the
[resource audit](analysis-state-resource-audit.json),
[campaign status](analysis-state-campaign-status.json) and
[complete research spending ledger](analysis-state-research-spend.md).

The first idle restart in the dedicated service then exposed a controller
configuration error: its engine-only Python wrapper was applied to the agent
parser. The three second-wave sessions emitted tool calls but never created
operators or recorded tool results. The driver dropped the SDK exceptions and
the renderer supplied generic `ok` observations. All three attempts, including
the completed Los Angeles control's unusable 0/36, are archived as setup
exclusions under `LongDS_IsolationDispatch_20260924`. Their spending remains in
the ledger. The corrected controller uses the normal agent interpreter and
passes an engine isolation preflight after every idle restart. The
[dispatch audit](analysis-state-dispatch-audit.json) confirms real results in the
first tool-bearing turn of all 25 previously completed native sessions. The frozen source
and primary scores are unchanged; a separate driver regression fix is applied
only to the final worktree.

The completed NFL recoveries reinforce the mechanism caveat. Analysis-state
scores 15/42 and 17/42 in trials 2 and 3, versus 9/42 in the first pass, but
neither recovery submits a fork or an explicit historical-table reference.
Trial 3 still makes 70 inspection calls and 44 recall calls across 234 model
calls, costing $0.53435. Its matched entries trial scores 16/42 at $0.53547.
These scores therefore do not demonstrate a benefit from actually using the
new branching capability. The per-trial counts and artifact paths are retained
in the [mechanism audit](analysis-state-mechanism-audit.json).


The replacement NFL first passes expose two distinct foundation mistakes. In
turn 1, the candidate sorts and ranks the peak-speed published list using
`mean_kick`, although the list's measure is `90p_kick`. In turn 2, the entries
control computes the higher-is-better mean and peak percentiles with
`rank(ascending=False) / n`, reversing the explicit opening convention. Its
pressure-accounting calculation is correct at this point. The candidate uses
the correct percentile direction but inherits the earlier published-rank error.

A [deterministic replay](analysis-state-nfl-foundation-replay.json) executes the
submitted turn-2 dependency graphs in a filesystem containing only the raw data
and a private scratch directory, with networking disabled. Changing only the
candidate's two peak-list ordering columns corrects Trent Williams' speed signal
from 0.9946 to 0.9986 and Rashod Hill's from 0.9499 to 0.9579. Changing only the
control's two speed-percentile directions replaces its five wrong leaders with
Brandon Shell, Christian Darrisaw, Trent Williams, Rashod Hill and Ronnie Stanley,
with all five speed signals matching the reference to four decimal places.
Pressure-accounting output is identical before and after each intervention.
This isolates the turn-2 effects; later turns were not replayed, and no score is
promoted to success. It supports checking the intended measure and percentile
monotonicity at foundation boundaries, not a claim that retrieval alone repairs
the full session.

NFL turn 1 also illustrates judge sensitivity: the control reports the correct
80% and 90% match fractions and 344 ledger rows, but receives zero because it
omits the explicit 8/10 and 9/10 counts. The question asks how much of each list
matched; the fixed judge demands the reference's numerator and denominator
fields. Those counts are present in the generated `workspace_summary`, so this
particular failure is answer coverage rather than an incorrect join. Its score
is preserved. This observation does not explain the subsequent substantive
percentile and population errors.


The candidate does use the new fork tool at NFL turn 30. One call creates three
linked branches, changing the severity input and then connecting the new player
scores to the two team calculations. The three original definitions are unchanged
between turns 29 and 30. The tool copies 10,348 function characters using 680
characters of new code plus 524 characters of fork arguments, with no tool error.
Across the whole turn, the candidate writes 4,516 program characters against the
control's 8,203, but takes seven model calls against five and costs $0.02917
against $0.02141. Both answers fail. This is evidence that automatic copying and
binding work in an autonomous run; it is not evidence of a cheaper or correct
counterfactual answer. No table/function name collision occurs in these forks.

Across all six first-pass sessions, model spending decomposes as follows at the
recorded repository rates. Output includes reasoning tokens once. The candidate
saves cached-read cost but pays substantially more for cache writes and output.

| First-pass model cost component | Python | Entries | Candidate |
| --- | ---: | ---: | ---: |
| Uncached input | $0.00096 | $0.00032 | $0.00053 |
| Cached reads | $0.29025 | $0.52861 | $0.37418 |
| Cache writes | $0.09953 | $0.38277 | $0.84723 |
| Output | $0.37827 | $0.44961 | $0.61525 |
| Total | $0.76901 | $1.36132 | $1.83719 |

The candidate makes 875 model calls versus the entries control's 534. The
first-pass accuracy difference is -2.59 percentage points on the task macro,
and the cost increase is 34.96%. Its cost is 2.39 times plain Python, exceeding
the now user-confirmed 1.25-times ceiling (the same threshold initially used
provisionally). Keep the feature opt-in; the additional
recovery trials do not replace these primary measurements.

The first-pass result also fails to establish a gain across the four annotated
state patterns. The following percentages average the within-pattern accuracy
of each of the six tasks. Pattern labels overlap and are not chronological
quarters; some task-pattern cells contain very few questions. They are
descriptive breakdowns, not independent samples or evidence of a context-length
effect. Counts are retained in each run's `by_pattern` result.

| State pattern | Entries task macro | Candidate task macro |
| --- | ---: | ---: |
| Initial | 39.3% | 39.9% |
| Update | 43.8% | 35.3% |
| Counterfactual | 43.3% | 27.2% |
| Rollback | 42.5% | 35.3% |

The next experiments should target the observed causes, with new run prefixes
and additional task families chosen before inspecting their answers:

1. **Check foundations before extending them.** Preserve the full component
   population, keys, units, denominator and source coverage as explicit outputs.
   Test checks derived from public requests and raw examples: whether score
   components sum to the score, ranking direction agrees with the stated rule,
   and a parser's largely empty output agrees with source text. The replayed
   LA and NFL corrections justify these diagnostics; they do not establish an
   autonomous accuracy gain.
2. **Measure reuse without the representation-discovery problem.** Give both
   dataflow and persistent Python the same checked functions and inputs, then
   ask for a correction, temporary scenario, historical composition and
   explanation. Measure unchanged defaults, exact values, calls and spending.
   The current whole-session results combine building the representation with
   using it; the low uptake of parameters and corrections leaves their
   conditional value unresolved.
3. **Separate authoring, memory and execution costs.** Compare the same component
   functions through Python function tools and native expressions. Test a
   stable completed-context prefix against the current selected-memory policy,
   counting cache writes and retrieval calls. Independently test bulk table
   execution or loader aggregation at the required analysis grain: Goodbooks
   exposes raw-row materialization as a bottleneck that prompt compaction does
   not remove. None of these proposed ablations is a measured result here.
