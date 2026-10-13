# LongDS: a compact ledger with task expansion

> Superseded on 2026-10-12 by [the focus design](longds-focus-design.md): the
> same directory and renderer, with the model choosing which earlier tasks
> the context shows in full instead of expanding them into receipts.

Proposal, 2026-10-12. Branch `feat/longds-answer` (local), measurements from the
Luna campaigns of 2026-10-11/12 in `/var/tmp/longds-catalog-luna-*` and
`/var/tmp/longds-ledger-luna-20261012`.

## 1. Background

LongDS Lite is eight sessions of 30–42 requests (271 in all) over one dataset
each. Every request builds on earlier ones: 96% of requests read a table an
earlier request made, the median reference reaches 11 requests back, and 69% of
references go to each session's three most-read tables. The dataflow agent
keeps one persistent graph per session; what we control is the context the
model sees at each request.

Arms run so far on gpt-5.6-luna (accuracy of 271, cost per pass of the eight
sessions; K=5 and smolagents are means of three reps):

| arm | context | accuracy | $/pass |
|---|---|---|---|
| transcript | the whole history verbatim | 118.5 | 1.28 |
| catalog | every earlier request as an entry (functions with source) | 113 | 1.31 |
| hybrid K=5 | entries, the 5–9 most recent requests verbatim | 114.3 | 1.17 |
| hybrid K=3 | as K=5 with a 3–5 window | 112 | 1.31 |
| K=7 + answer field | answer composed from tables in the computing call | 93 | 1.09 |
| built-ins catalog | every request an entry, built-in chains | not judged | 1.43 |
| ledger | one line per operator, no function source, answer operator | 100 | 0.99 |
| smolagents | script agent, full history | 124.0 | 1.04 |

Two facts about the provider shape every design. The prompt cache reuses the
longest earlier full prompt of the session that is a prefix of the new one;
anything rewritten in the middle makes everything after it fresh. Fresh input
costs ten times cached input ($0.2 vs $0.02 per million on Luna; the same ratio
on Sol).

## 2. Motivation: what the traces say

1. **Output is the largest cost everywhere.** 40% of K=5's cost, 51% of
   smolagents', 58% of the ledger's. Our code per request is already shorter
   than pandas (730–960 tokens against 1,028), and no context layout we have
   tried has moved it much. Input, mostly cached, is the smaller half.

2. **Cached input is nearly free, so "a smaller context" saves tokens, not
   money.** The ledger carries 15.7k tokens per call, 2.66 calls per request,
   42k cached tokens per request: the price of 4k fresh tokens. A context that
   is regenerated for each request (a selected view, a window that moves) pays
   fresh prices for everything it regenerates. K=5's window conversions are why
   its fresh input is twice smolagents'.

3. **Conventions live in the code.** The ledger run dropped function source
   from entries (signatures and columns only). On the 92 requests both ledger
   attempts completed, the attempt with source scored 43, the one without 31,
   K=5 44.3. By position, the no-source ledger scored 35% on requests 2–6
   against K=5's 69%, and 32% on requests 21+ against 26%: it loses exactly
   where K=5 still shows the earlier tasks verbatim, and it is the best of the
   three late in a session. Luna writes no docstrings, so a signature carries
   nothing of the rule.

4. **Accesses are sparse.** A request builds on a median of 2 earlier
   operators (≤5 in 96% of requests); the ancestor closure of what it reads
   averages 7.6 operators and reaches 14. The working set is small; the
   closure is not.

5. **The model looks things up when the context is compact**: 0.31 look-up
   calls per request in the ledger run, mostly `show function` on its own
   earlier functions and `show schema` on tables whose columns the entry left
   out. Each look-up is a full call (~18k input, ~$0.0006).

6. **Selection without a model call is good but not complete.** Replaying the
   ledger run with a selector built from persistence (what the previous
   request used), the three hub tables, the previous request's new tables and
   task-text matches covers 81% of a request's inputs at 5 operators (62% of
   requests fully), 92% at 8 (83%), 96% at 12 (93%). The model, which has every
   task text in front of it, can select by task: that is how the requests are
   phrased ("the leaders from task 5").

7. **The answer operator is withdrawn.** It removed the reply call (27.5% of
   K=5's cost, pure transcription) and 81% of requests answered blind without
   losing accuracy to blindness, but the design is not wanted; replies stay
   text.

## 3. Solution

Keep the context append-only, keep every rule's code in it, and let the model
pull the full state of the tasks it builds on, by task number, into the
current request.

### 3.1 Layout

```
[system prompt]
[U1][E1] … [U(r−1)][E(r−1)]   task texts and ledger entries: append-only, cached
[U(r)]                        the current request
[call 1][receipt 1] …         this request's calls; an `expand` receipt lands here
```

`U(k)` is task k's text as sent. `E(k)` is the entry written once when task k
ends: the functions it registered or changed, with signature, docstring and
source; one line per operator it set, with rows and columns (relative to its
input's where shorter); `built on: task 1, 2`; `deleted`; and its answer. When
task r ends its calls are dropped and `E(r)` is appended after `U(r)`, so every
prompt extends an earlier one. Entries are ~250 tokens plus source.

### 3.2 Expansion

Two statements in the dataflow tool:

```
expand task 3, 7            the state tasks 3 and 7 left, in full
expand protection_picture   one operator, with its chain inside its own task
```

The receipt section `## expand task 3` holds:

```
request: "<task 3's text, verbatim>"
functions registered here: <signature, docstring, source>
operators set here, in dependency order:
- `set protection_picture: build_protection_picture(combined_player_view)`
    reads: `combined_player_view` (task 2, 86 rows × 24 columns)
    result: 86 rows × 30 columns; columns: player str, team str, … (≤24, then +N more)
    sample: 3 rows | full table when ≤12 rows
- `set task3_report: …`
answer: <the reply, verbatim>
reads from earlier tasks: `combined_player_view` (task 2) — expand task 2 for its rule
read by later tasks: `protection_picture` → task 4 (`protection_refined`), task 8 (`refined_scored`)
```

Rendering rules:

1. **Boundary, not closure.** An input from another task is one line: id,
   origin task, shape. Loading the ancestor closure would triple the expansion.
2. **Expanded together → cross-referenced.** When task 7 reads task 3's table
   and both are expanded, task 7's line says `(task 3, above)`.
3. **Current state, history noted.** The graph holds every table's current
   definition. If a boundary table was set again later, the line says
   `set again in task 9: <definition>; task 3's results predate that`. The
   snapshots carry the revisions.
4. **Forward lineage.** `read by later tasks` says where the analysis went
   next, which is what decides whether this task or a later one holds the
   current stage.
5. **Populations, bounded.** Answer tables and tables of ≤12 rows in full;
   others three sample rows and the shape; one task ≤ ~3k tokens, one call ≤
   ~8k, then `clipped: expand fewer tasks`.
6. **Receipts, not rewrites.** The expansion is a tool result of the call that
   asked for it: cached for the rest of the request, absent from the next
   request's prefix. Nothing earlier changes.

### 3.3 Prompt

The statements list gains `expand`; section 5 (working across requests) says:
to build on an earlier task's rule or table, expand that task, in the same call
as the work when the choice is clear and in a first call when it is not; the
ledger's `built on` lines show which tasks lead where. Replies stay text,
written after `show result`.

### 3.4 What stays from the ledger work

Entries with columns on every line; edit-time column checks (every missing
column of a call's edits reported together before anything runs); the hint
that a `NameError` on a table's name means "pass it as an input"; the
built-ins-when-one-line prompt.

### 3.5 Implementation

- `native/turn-syntax.ts`: `expand task <n>[, <m>]` and `expand <id>[, …]`.
- `tools/dataflow-action-runtime.ts`: an inspect target `task`: the operators
  each task set (the entry's edit order, from the snapshots), the functions it
  registered (namespace diff between the task's start and end snapshots), its
  text and reply, current views and results, consumers for the forward lineage.
- `native/turn-receipt.ts`: the section above, reusing `describeOperator`,
  `operatorBlock` and `renderRecords`.
- `request-catalog.ts`: the `built on` line.
- Settings: none new; the arm is `catalogSource: "docstring"` (source for
  undocumented functions) with `catalogRecent: 0`.

About a day, with tests on the catalog test harness.

## 4. Experiment

Luna, the eight sessions, one rep, judged with the benchmark's judge:

| arm | context |
|---|---|
| ledger + expand | entries with source, `expand`, text replies |
| ledger with source | the same without `expand` (the control for the statement) |
| hybrid K=5 | existing three reps |
| smolagents | existing three reps |

Measured per arm: accuracy; cost split into fresh, cached and output; calls
per request; expansions per request and how far back they reach; look-up calls
(`show function`, `show schema`, `show result` of earlier tables); Python
tokens per request as the rebuild measure; requests that set or read an
operator from a task they did not expand.

Success is accuracy at K=5's mean (114, reps 104–127) at or below K=5's cost
minus 10% ($1.05). The ledger with source without `expand` ran at −5% on the
80 requests it covered, before the column and answer-cell fixes.

## 5. Expected outcome and risks

- Input: about the ledger's, −40% against K=5. Expansions add fresh tokens
  (~2k per use) and remove look-up calls (~$0.0006 each); near a wash.
- Output: the open question. If seeing a task's full state cuts rebuilding
  (NFL Q25: 6,131 characters of Python rebuilding an earlier analysis), output
  falls; nothing so far shows that it will.
- Accuracy: at least the ledger-with-source's, because nothing is hidden; above
  it where a task was rebuilt wrongly for want of its earlier rule.
- Risks: the model does not expand (answer statements were used 0 times
  until forced; expansion must be taught in section 5 and shown in its
  example); expansions too large for long tasks (the caps); the semantic miss —
  the wrong stage of a rule (Netflix Q31) — which the forward-lineage line
  reduces but cannot remove.

## 6. Alternatives considered

- **An automatic working view per request** (the study's design: index +
  detailed selection of ≤5, regenerated from the graph): right as a memory
  model, but a regenerated view is fresh every request and costs as much as
  the whole cached ledger, and automatic selection misses 17% of requests at
  8 operators. Kept as a follow-up: the same renderer can emit a view at
  request start if `expand` shows the model wants it.
- **A selection phase** (the model names tasks first, then works in a reduced
  context): −10 to −30% input tokens ignoring the cache, but an extra call with
  its own output and reasoning, and a wrong pick hides what the model needs.
  Fewer tokens, more dollars under prefix caching; worth testing only where
  tokens are the cost.
