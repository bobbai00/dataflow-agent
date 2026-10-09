"""LongDS experiment arms.

Deliberately NOT registered in `systems/__init__.py`: these are instantiated
directly by `run_longds.py`, and KramaBench's own harness must never pick them up
(they answer a multi-turn protocol it cannot drive). Keeping them here also means
adding a LongDS arm cannot disturb a KramaBench arm.

Baseline is the same knob set as the campaign's `_LunaAnchor` — DELTA, 1k result
chars, no stats, no code-in-snapshot — so LongDS numbers sit next to the gpt-5.6
KramaBench Anchor without a knob translation step. Two deliberate differences:

  * `max_steps=40` (LongDS's own per-turn cap) instead of 25. LakeQA showed the
    step cap binds first on harder benchmarks, and LongDS turn 1 has to build the
    whole analytical state from raw files.
  * `agent_service_endpoint` is :3001, the main checkout. `_LunaBase` defaults to
    :3004 (the code-lean worktree), which is not running.

`context_window_tokens=0` is the append-only condition: DELTA replays every
turn's events and nothing is trimmed by a token budget. It is already the default
— stated explicitly because for this benchmark it is a design choice, not an
inherited default.
"""
from systems.dataflow_system import DataflowSystem

#: The main-checkout agent-service. Verified serving from
#: dataflow-agent/agent-service (not a worktree) at the time these arms landed.
AGENT_SERVICE_ENDPOINT = "http://localhost:3001"


class LongDSBase(DataflowSystem):
    _MODEL = "gpt-5.6-luna"
    _CONTEXT_MODE = "delta"
    _RESULT_CHARS = 1000
    _STATS = False
    _CODE = False
    _MAX_STEPS = 40
    _NAME = "LongDSBase"
    #: Explicit data ladder level. None keeps the historical coupling
    #: (2 with _STATS, else 1). Set it to run e.g. data_level=2 (structural
    #: profile) WITHOUT the column-stats overlay — the two are separate knobs.
    _DATA_LEVEL: int | None = None

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("agent_service_endpoint", AGENT_SERVICE_ENDPOINT)
        super().__init__(
            model_type=self._MODEL,
            context_mode=self._CONTEXT_MODE,
            max_steps=self._MAX_STEPS,
            flow_level=1,
            data_level=self._DATA_LEVEL if self._DATA_LEVEL is not None else (2 if self._STATS else 1),
            column_stats=self._STATS,
            attempt_reflection=True,
            max_operator_result_char_limit=self._RESULT_CHARS,
            max_operator_result_cell_char_limit=3000,
            enable_code_in_snapshot=self._CODE,
            context_window_tokens=0,
            name=self._NAME,
            verbose=verbose,
            *args,
            **kwargs,
        )


class LongDSLunaDelta1k(LongDSBase):
    """The baseline: gpt-5.6-luna, DELTA, 1k, no stats, append-only history."""

    _NAME = "LongDSLunaDelta1k"


class LongDSLunaDelta1kSameEra(LongDSBase):
    """The baseline again, under a separate name, for a SAME-ERA control.

    Byte-identical config to `LongDSLunaDelta1k`. It exists only so today's
    baseline can be measured without overwriting the 2026-08-03 one — and it
    exists at all because the 2026-08-06 comparison was invalid without it.

    Every LongDS arm-vs-arm number before this was cross-vintage: the baseline
    ran 08-03, the recall arm 08-04 (four agent-service commits back, before the
    structured layout, the rich-set caps and operator retirement), the
    turn-recall arm 08-06 — across a full JVM restart, which HANDOFF 4.6 measures
    at ~2.3 points on its own and calls an era boundary never to compare across.
    A same-era control is the only way to attribute a difference to an arm rather
    than to the week.
    """

    _NAME = "LongDSLunaDelta1kSameEra"


class LongDSLunaDelta1kTaskLast(LongDSBase):
    """Baseline + the request moved under the history.

    Pure cache/attention change: same bytes, same order of everything else. The
    baseline put the newest request FIRST, so each new turn changed byte 13 of the
    prompt and invalidated the identical history below it (measured: consecutive
    turns shared 13 leading characters of a 233 KB prompt). Isolating it here
    means any accuracy difference is attributable to placement alone.
    """

    _NAME = "LongDSLunaDelta1kTaskLast"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("user_task_placement", "bottom")
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaRecall(LongDSBase):
    """The experiment: catalogue prior turns, let the model pull what it needs.

    Prior turns collapse into `# Prior Turns` (request / operators touched /
    answer) and the model recalls specifics through `recallState`. The request
    sits last so the catalogue and the current turn's events stay a stable prefix.

    The bet: LongDS failures are state failures, not retrieval failures, and a
    dataflow's state is addressable (named operators, per-turn revisions,
    materialized results), so the model can fetch the exact earlier definition
    rather than re-deriving it — which is where the numeric drift comes from.
    """

    _NAME = "LongDSLunaRecall"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("user_task_placement", "bottom")
        kwargs.setdefault("turn_history", "index")
        kwargs.setdefault("enable_recall_tool", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaTurnRecall(LongDSBase):
    """`LongDSLunaRecall` after the turn-addressing simplification (2026-08-06).

    Same knobs as `LongDSLunaRecall` — the changes are all service-side, so this
    exists to keep the two sets of results apart rather than to set anything
    differently. What changed under it:

      * No `# Session Brief`. A session is one conversation and turn 1 is
        catalogue entry 1, rendered like every other turn. Requests are now
        verbatim in the catalogue instead of clipped to a 260-char gist, which
        also fixes the answers: 73% of them were over that clip, so the
        catalogue was misreporting the agent's own prior results on three turns
        in four.
      * `recallState` is addressed by TURN only. The five-way `what` selector is
        gone; one call returns a turn's request, answer and operator delta, and
        the caller chooses the verbosity (`includeCode`, `includeResults`,
        `includeStats`, `maxResultChars`) instead of a fixed policy choosing for
        it. The char budget is clamped service-side, because a recalled block is
        re-sent on every remaining step of the turn.
      * No cap on how many of the turn's own operators render their code.

    (`indexThinObservations` is not set: full observations are the service
    default since the A/B that settled it — same accuracy, cheaper, faster.)
    """

    _NAME = "LongDSLunaTurnRecall"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("user_task_placement", "bottom")
        kwargs.setdefault("turn_history", "index")
        kwargs.setdefault("enable_recall_tool", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaTurnRecallCap40(LongDSBase):
    """The turn-recall arm under COUNT-based index retirement (the new default).

    Identical kwargs to `LongDSLunaTurnRecall`; it sets nothing, because the fix
    is the service default. Separate name only so its results sit beside the
    arm it replaces.

    The two probe arms this supersedes (`indexRecentTurns` 12 and 24) are gone
    along with the knob, so their findings live here. All same-era, 2026-08-06,
    deepseek-v4-pro judge; baseline is `LongDSLunaDelta1kSameEra`:

        task                ops   baseline   recentTurns=3   =12     =24
        passnyc              31      63.3%           40.0%  76.7%   73.3%
        water-potability     73      41.7%           33.3%  47.2%      -
        sustainable-energy  160      16.7%           11.1%  25.0%      -
        bi                    9      (n/a)           70.4%  70.4%      -
        rankings             20      (n/a)           19.0%  20.0%      -
        nfl                 277      31.0%            7.1%  FLOOD       -
        uber                381      (n/a)           13.9%  FLOOD       -

    Three things that table settles:

      * At 3 the index STARVES. On passnyc the model saw 4 result tables out of
        ~23 live operators from turn 5 on.
      * At 12 the same constant FLOODS a big DAG. NFL and uber reached 360-600 kB
        of context and spent turn after turn burning the entire 40-step budget to
        return an empty answer; both runs were abandoned.
      * 24 is slightly WORSE than 12 on passnyc (73.3 vs 76.7), so retirement is
        worth keeping — the index is what buys the cost reduction — and the old
        default was simply far too aggressive.

    A turn count cannot satisfy all of those at once, because 12 turns of a
    31-operator task and 12 turns of a 381-operator task are not the same amount
    of context. The replacement bounds the COUNT of detailed operators (default
    40) with the turn's own work exempt: small DAGs keep everything, large ones
    keep a bounded most-relevant slice.
    """

    _NAME = "LongDSLunaTurnRecallCap40"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("user_task_placement", "bottom")
        kwargs.setdefault("turn_history", "index")
        kwargs.setdefault("enable_recall_tool", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaTurnResume(LongDSBase):
    """The session as a version tree: the model picks the state it continues from.

    Adds `resumeFrom(turn)` next to `recallState`. `resumeFrom` MOVES — the
    dataflow becomes that turn's dataflow and new work branches from there;
    `recallState` still only READS. The index cap is OFF
    (`indexDetailedOperators: 0`), so the two size mechanisms can be told apart:
    whatever this arm saves has to come from choosing a smaller base, not from a
    render budget.

    Why a tree rather than a line, measured over the ten tasks:

      * 47% of turns' newest dependency is NOT the previous turn.
      * Half of all counterfactual turns are depended on again later, so those
        "what if" branches are not throwaway.
      * Resuming to the newest dependency instead of inheriting everything
        shrinks the DAG ~20-40% on the mean and ~30-50% at the peak
        (nfl 182 -> 143 mean, 335 -> 232 peak; passnyc 56 -> 35, 94 -> 48).

    No `merge`. On all 20 observed multi-turn recalls, resuming to the newest of
    the requested turns alone would have sufficed — because the agent creates
    new operators far more often than it revises old ones, which leaves history
    effectively append-only. That property is what makes single-parent checkout
    enough, and it is worth re-checking if operator sprawl is ever fixed.
    """

    _NAME = "LongDSLunaTurnResume"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("user_task_placement", "bottom")
        kwargs.setdefault("turn_history", "index")
        kwargs.setdefault("enable_recall_tool", True)
        kwargs.setdefault("enable_resume_tool", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaGrounded(LongDSBase):
    """cap40 + answer grounding + restore-via-recall. All general, all dataflow-native.

    Three additions over the cap40 configuration, none tuned to any task:

      * **Answer grounding** (`enable_answer_grounding`). A final answer's
        substantive numbers must trace to a materialized operator result or to
        state recalled this turn; on total failure the agent gets ONE feedback
        round. This checks a property only a dataflow has — results are
        addressable tables, so "did this answer come from the analysis?" is
        mechanically decidable. Target: the measured late-turn failure where
        answers restate an earlier turn (pilot turns 29/32/42 answered in ~1
        step), and the paper's finding that verification collapses late
        (steps/turn drop 4.3, Fig 6d).
      * **Restore-via-recall** (prompt). For "as it originally was" requests:
        recall the owning turn's code and rebuild it VERBATIM as new operators.
        Drift-free because the code is copied from the record, state-safe
        because nothing moves — the lesson of the resumeFrom experiment, where
        wrong-base checkouts destroyed state (passnyc 73.3% -> 23.3%).
      * **Conventions never expire** (prompt). Rules stated in any turn bind
        until changed; copy their constants from the catalogue, later statement
        wins. Target: the wrong-formula cascade's root (pilot turn 3 guessed a
        convention turn 1 had stated; 6 later turns inherited the drift).

    `index_detailed_operators=40` is set EXPLICITLY: the service default became
    0 (uncapped) during the resume evaluation, so relying on the default would
    silently change the comparison base.
    """

    _NAME = "LongDSLunaGrounded"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("user_task_placement", "bottom")
        kwargs.setdefault("turn_history", "index")
        kwargs.setdefault("enable_recall_tool", True)
        kwargs.setdefault("enable_answer_grounding", True)
        kwargs.setdefault("index_detailed_operators", 40)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaGroundedR2(LongDSLunaGrounded):
    """Replicate of `LongDSLunaGrounded` — same config, second seed.

    Exists because LongDS scores at n=1 are dominated by cascade variance: one
    micro-choice early (passnyc turn 12 counted 462 complete schools where a
    sibling run counted 472) rewrites every downstream turn. Two runs of the
    same config bound that noise; without the bound, arm deltas of +-20 points
    are unattributable.
    """

    _NAME = "LongDSLunaGroundedR2"


class LongDSLunaTurnRecallCap40R2(LongDSLunaTurnRecallCap40):
    """Replicate of `LongDSLunaTurnRecallCap40` — same config, second seed.

    NOTE: unlike the original cap40 run (which relied on the then-default of
    40), this sets the cap explicitly, because the service default is now 0.
    """

    _NAME = "LongDSLunaTurnRecallCap40R2"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("index_detailed_operators", 40)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaTelemetry(LongDSBase):
    """cap40 + execution telemetry: the Lineage fact and the coercion alarm.

    Both are computed by the worker unconditionally and merely rendered here;
    both are name-agnostic (row counts from the engine; pandas wrapped at the
    library level, keyed on value shape). Neither knows anything about any
    benchmark. They also ride along on `recallState` results, so a later turn
    diagnosing a drift sees the defect recorded on the old version.

    Target: the cascade lottery. The measured case — an inner join keeping 462
    of 472 rows at passnyc turn 12, thirteen downstream turns lost, a 37-point
    swing between identical runs. `Lineage: 472 rows in -> 462 rows out (97.9%)`
    puts that loss in front of the model at the step it can still fix it.

    NO answer grounding and NO new prompt text: one variable per arm.
    """

    _NAME = "LongDSLunaTelemetry"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("user_task_placement", "bottom")
        kwargs.setdefault("turn_history", "index")
        kwargs.setdefault("enable_recall_tool", True)
        kwargs.setdefault("index_detailed_operators", 40)
        kwargs.setdefault("row_lineage", True)
        kwargs.setdefault("coercion_facts", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaStats(LongDSBase):
    """cap40 + per-column statistics (data_level=2, column_stats).

    The other half of the comparison: stats describe THE DATA before code is
    written (min/max/nulls/distinct/histograms), telemetry describes WHAT AN
    OPERATOR DID after it ran. Validated on KramaBench (the mini structural-
    profile accuracy win; stats-at-5k for gpt-5.6); untested on LongDS.
    """

    _NAME = "LongDSLunaStats"
    _STATS = True

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("user_task_placement", "bottom")
        kwargs.setdefault("turn_history", "index")
        kwargs.setdefault("enable_recall_tool", True)
        kwargs.setdefault("index_detailed_operators", 40)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaTelemetryR2(LongDSLunaTelemetry):
    """Second seed of `LongDSLunaTelemetry` — replicates are the price of a claim."""

    _NAME = "LongDSLunaTelemetryR2"


class LongDSLunaStatsR2(LongDSLunaStats):
    """Second seed of `LongDSLunaStats`."""

    _NAME = "LongDSLunaStatsR2"


class LongDSLunaTurnRecallCap40R3(LongDSLunaTurnRecallCap40R2):
    """Third seed of the cap40 control (R1/R2 already hold passnyc)."""

    _NAME = "LongDSLunaTurnRecallCap40R3"


class LongDSLunaVersioned(LongDSBase):
    """VERSIONED MODE: one catalog over an immutable version DAG.

    The design that dissolves the state-vs-history duplication: no `# Dataflow`
    section (state renders once, in the turn entry that created it), the turn
    in progress is the last catalog entry, recall output persists as an
    ordinary observation, and every write names its versions — `upstreams`
    maps each input to the turn whose version it builds on, revisions carry
    `fromTurn`. "Current" exists only as the `Current operators` pointer table.

    Telemetry rides along (lineage facts in the delta entries and observations)
    since the delta IS the state record now. recallState stays for pulling old
    code/results. No cap — the render is append-only by construction, which is
    the principled replacement for one.
    """

    _NAME = "LongDSLunaVersioned"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("versioned_mode", True)
        kwargs.setdefault("enable_recall_tool", True)
        kwargs.setdefault("row_lineage", True)
        kwargs.setdefault("coercion_facts", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaVersionedR2(LongDSLunaVersioned):
    """Second seed of `LongDSLunaVersioned` — the t12 lottery demands replicates."""

    _NAME = "LongDSLunaVersionedR2"


class LongDSLunaVersionedRich(LongDSLunaVersioned):
    """Versioned catalog + a RICH observation channel (2026-08-08 campaign).

    Same catalog as `LongDSLunaVersioned` (versioned mode, recallState, lineage
    facts, coercion facts). What changes is what the model SEES when an operator
    runs, inside the current turn:

      * `_RESULT_CHARS = 2000` — sample rows up to 2k chars (baseline: 1k);
      * `_STATS = True` — data_level=2 + `column_stats`: schema, structural
        hints, and per-column statistics (numeric min/max/mean, string
        distinct/top, nulls) on every materialized result.

    The bet, from the t12 post-mortem: versioned mode went 3/3 into the
    turn-12 cascade trap most plausibly because dropping the state dump also
    dropped upstream VALUE evidence at the moment join decisions are made.
    This arm restores value evidence through the observation channel — the
    general mechanism — rather than through any task-specific fix.
    """

    _NAME = "LongDSLunaVersionedRich"
    _STATS = True
    _RESULT_CHARS = 2000


class LongDSLunaVersionedRichR2(LongDSLunaVersionedRich):
    """Second seed of `LongDSLunaVersionedRich`."""

    _NAME = "LongDSLunaVersionedRichR2"


class LongDSLunaVersionedRichR3(LongDSLunaVersionedRich):
    """Third seed of `LongDSLunaVersionedRich`."""

    _NAME = "LongDSLunaVersionedRichR3"


class LongDSLunaDelta1kE0808(LongDSBase):
    """The baseline a third time, for the 2026-08-08 era.

    Byte-identical config to `LongDSLunaDelta1k`/`...SameEra`. Exists because
    the engine restarted 2026-08-07 11:17 and agent-service 2026-08-08 00:57 —
    an era boundary (HANDOFF 4.6) — so neither earlier baseline is a valid
    control for runs started after it. Covers all ten tasks in one era.
    """

    _NAME = "LongDSLunaDelta1kE0808"


class _LongDSLayoutSmoke(LongDSBase):
    """Base for the 2026-08-08 layout-matrix smoke arms: rich ReAct knobs
    (2k samples, stats, lineage, coercion facts) so every observation channel
    is visible in the rendered context. Two-turn smoke runs only."""

    _RESULT_CHARS = 2000
    _STATS = True

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("row_lineage", True)
        kwargs.setdefault("coercion_facts", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaSmokeSessionDelta(_LongDSLayoutSmoke):
    """Session layout × DELTA: # Session of turn entries (Task/Steps/Final
    Answer) + # Your Task; full step replay inside each turn."""

    _NAME = "LongDSLunaSmokeSessionDelta"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("session_turns", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaSmokeSessionLatest(_LongDSLayoutSmoke):
    """Session layout × LATEST: finished turns show touched operators
    (as-of-turn-end), the current turn the full leaf snapshot.

    `_CODE = True` deliberately: DELTA carries code inline per event, so a
    code-blind LATEST cell would confound the layout A/B with a code axis."""

    _NAME = "LongDSLunaSmokeSessionLatest"
    _CONTEXT_MODE = "latest"
    _CODE = True

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("session_turns", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaSmokeVCatDelta(_LongDSLayoutSmoke):
    """Versioned catalog × DELTA — the shipped versioned mode plus the
    # Your Task tail (added with the session-layout work)."""

    _NAME = "LongDSLunaSmokeVCatDelta"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("versioned_mode", True)
        kwargs.setdefault("enable_recall_tool", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaSmokeVCatLatest(_LongDSLayoutSmoke):
    """Versioned catalog × LATEST (the new cell): catalog entries for finished
    turns; the current turn keeps thoughts/actions + recall pulls in its step
    log and collapses observations into a ### Dataflow leaf snapshot."""

    _NAME = "LongDSLunaSmokeVCatLatest"
    _CONTEXT_MODE = "latest"
    _CODE = True

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("versioned_mode", True)
        kwargs.setdefault("enable_recall_tool", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class _LongDS2kD2(LongDSBase):
    """Shared observation channel for the 2026-08-08 layout A/B: 2k sample
    chars, data_level=2 (schema + structural profile), NO column stats,
    lineage + coercion facts on. Both layouts get exactly this channel, so any
    difference is attributable to the layout alone."""

    _RESULT_CHARS = 2000
    _DATA_LEVEL = 2
    _STATS = False

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("row_lineage", True)
        kwargs.setdefault("coercion_facts", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaSession2kD2(_LongDS2kD2):
    """BASELINE layout: # Session — full step replay per turn, # Your Task
    tail. No recall tool: everything is already in the prompt; that is the
    point of this arm."""

    _NAME = "LongDSLunaSession2kD2"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("session_turns", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaSession2kD2R2(LongDSLunaSession2kD2):
    _NAME = "LongDSLunaSession2kD2R2"


class LongDSLunaSession2kD2R3(LongDSLunaSession2kD2):
    _NAME = "LongDSLunaSession2kD2R3"


# Fresh session anchors for the catalog-v2 campaign: each v2 rep runs paired
# with one of these in the same era, so v2-vs-session is direct and v2-vs-v1
# goes through the anchor (difference-in-differences cancels the era shift).
class LongDSLunaSession2kD2R4(LongDSLunaSession2kD2):
    _NAME = "LongDSLunaSession2kD2R4"


class LongDSLunaSession2kD2R5(LongDSLunaSession2kD2):
    _NAME = "LongDSLunaSession2kD2R5"


class LongDSLunaSession2kD2R6(LongDSLunaSession2kD2):
    _NAME = "LongDSLunaSession2kD2R6"


class LongDSLunaVersioned2kD2(_LongDS2kD2):
    """EXPERIMENT layout: # Catalog — state-once entries + recallState pull,
    # Your Task tail. Same observation channel as the session arm."""

    _NAME = "LongDSLunaVersioned2kD2"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("versioned_mode", True)
        kwargs.setdefault("enable_recall_tool", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaVersioned2kD2V2(LongDSLunaVersioned2kD2):
    """The catalog arm after the 2026-08-09 gap analysis — same knobs, four
    service-side changes (all general, none task-tuned):

      * foundations verification prompt (dual derivation + lineage check on
        quantities later turns inherit) — targets corr(early errors, later
        accuracy) = -0.62;
      * input-values channel: first cross-turn reference attaches that
        version's sample values to the write's observation — targets the
        +29% blind probe writes;
      * unambiguous version-ref cases proceed with a note instead of a
        rejection (stray `from` on create; same-turn self-revision) — kills
        ~80 wasted steps/3 runs and the rename-sprawl trigger;
      * catalog delta entries carry the structural profile line (grain/key,
        duplicates) under the D2 channel.
    """

    _NAME = "LongDSLunaVersioned2kD2V2"


class LongDSLunaVersioned2kD2V2R2(LongDSLunaVersioned2kD2V2):
    _NAME = "LongDSLunaVersioned2kD2V2R2"


class LongDSLunaVersioned2kD2V2R3(LongDSLunaVersioned2kD2V2):
    _NAME = "LongDSLunaVersioned2kD2V2R3"


class LongDSLunaVersioned2kD2V3(LongDSLunaVersioned2kD2V2):
    """v2 + OPERATOR-LEVEL recall (one variable changed from v2).

    `recallState` is re-addressed from turns to operator versions — the model
    passes the same `"opId (turn N)"` string it reads in the catalog and
    writes in `upstreams`, and gets back that ONE version's code, values and
    telemetry. Turn-level pulls were ~98% redundant (the catalog already
    carries every request verbatim and 98.3% of answers under its clip) and
    over-fetched whole turn deltas, which kept values invisible-by-default —
    recall showed zero accuracy benefit under it. The prompt teaches the
    natural discipline this enables: recall the versions you are about to
    build on, look at the numbers, THEN wire.
    """

    _NAME = "LongDSLunaVersioned2kD2V3"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("recall_operator_level", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaSession2kD2R7(LongDSLunaSession2kD2):
    """Session anchor for the v3 pair."""

    _NAME = "LongDSLunaSession2kD2R7"


class LongDSLunaVersioned2kD2V31(LongDSLunaVersioned2kD2V3):
    """v3.1 — SELECTIVE recall (prompt-only change from v3).

    v3 tied its anchor (32.03 vs 32.14) while solving passnyc t12 (472, gold,
    in a 462-era; task 36.7 -> 80.0) — but reflexive read-before-wire cost
    1121 recall calls and 5.5 steps/turn, taxing exactly the tasks that carry
    no inherited-state risk (github -13). The fragment now gates recall on
    VALUES-DECIDE-WHAT-YOU-BUILD (revision/rollback/comparison/foundation) and
    tells the model to wire directly otherwise, leaning on the write-time
    input-values attach as the safety net. Same knobs as v3; the fragment is
    the variable.
    """

    _NAME = "LongDSLunaVersioned2kD2V31"


class LongDSLunaVersioned2kD2V32(LongDSLunaVersioned2kD2V31):
    """v3.2 — v3.1 plus the inherited-baseline fix (commit ad5301b4a).

    The live turn's steps now diff against the previous turn's leaf snapshot
    instead of the empty root, so inherited operators stop being re-dumped in
    step 1. Measured share of prompt that dump occupied on NFL: 53% at turn 42
    (238 of 450 kB, 179 operators). Nothing else changes, so any difference is
    attributable to removing that duplication.
    """

    _NAME = "LongDSLunaVersioned2kD2V32"


class LongDSLunaVersioned2kD2V32R2(LongDSLunaVersioned2kD2V32):
    _NAME = "LongDSLunaVersioned2kD2V32R2"


class LongDSLunaVersioned2kD2V32R3(LongDSLunaVersioned2kD2V32):
    """Third rep. Reps exist because the aggregate is cascade-dominated: a task's
    score is set largely by where its FIRST wrong turn lands, so single-rep
    per-task numbers swing wildly (v3.1 saw 10-76 on world_university_rankings
    across three reps). Three reps is the minimum that separates a real effect
    from that lottery."""

    _NAME = "LongDSLunaVersioned2kD2V32R3"


class LongDSLunaVersioned2kD2V31R2(LongDSLunaVersioned2kD2V31):
    """v3.1 rep 2 — first CLEAN rep on the fixed build (version store +
    checkout + graph guards + failure surfacing, commits 9b0adadf8 /
    49d3ec7e0 / 079b6b39d)."""

    _NAME = "LongDSLunaVersioned2kD2V31R2"


class LongDSLunaVersioned2kD2V31R3(LongDSLunaVersioned2kD2V31):
    """v3.1 rep 3 — second clean rep on the fixed build."""

    _NAME = "LongDSLunaVersioned2kD2V31R3"


class LongDSLunaVersioned2kD2R2(LongDSLunaVersioned2kD2):
    _NAME = "LongDSLunaVersioned2kD2R2"


class LongDSLunaVersioned2kD2R3(LongDSLunaVersioned2kD2):
    _NAME = "LongDSLunaVersioned2kD2R3"


class LongDSLunaVersioned2kD2Principles(LongDSLunaVersioned2kD2V32):
    """v3.2 + EVIDENCE PRINCIPLES, on the fixed environment.

    Same three ideas the audit arm carried, but folded into the sections of the
    versioned fragment that already own them instead of appended as a block:

      * verify what you report, preferring relations that cost nothing (shares
        sum, subset bound, total equals parts, agreement with an earlier turn)
        over a second operator — and retire that operator when it is used;
      * know the operator version, column and row every reported number came
        from, and re-read the constraining sentences against what the operators
        actually do;
      * immutability keeps history, it does not make a mistake permanent — revise
        the operator built under a different reading rather than answering from it.

    The appended-block version (`V33`) scored 63.6 education against a 60.1
    baseline over two reps, spread +/-4.3 — suggestive, not established. It also
    invented vocabulary the system does not have ("audit block", "check line"),
    which the model filled in as a form: 100% coverage, 0.81 of numbers traced,
    and still 70% of turns wrong. This arm keeps the principles and drops the
    vocabulary, so a difference is attributable to the ideas rather than to the
    ritual.
    """

    _NAME = "LongDSLunaVersioned2kD2Principles"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("spec_audit", True)
        kwargs.setdefault("execution_timeout_minutes", 10)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaVersioned2kD2V32Fix(LongDSLunaVersioned2kD2V32):
    """v3.2, unchanged prompt, on the FIXED environment. Isolates what the
    environment was costing every arm, with no prompt variable in the way:

      * `xgboost` and `duckdb` installed in the UDF venv. education__bi__task1
        turn 24 names five model families INCLUDING XGBoost, so that turn (and
        turn 27, which asks about "the best tree-based model") was unwinnable for
        every arm ever run — 195 `No module named 'xgboost'` observations.
      * A missing-file error now names the real paths carrying that basename.
        march_madness ships 42 basenames in more than one directory, and the
        copies DIFFER, so a wrong guess got no signal: 730 path failures, one turn
        burning 41 steps on 5 wrong paths with the right ones in its context.
      * `execution_timeout_minutes=10`. The 4-minute default aborted executions
        the harness was happy to wait 30 minutes for.
    """

    _NAME = "LongDSLunaVersioned2kD2V32Fix"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("execution_timeout_minutes", 10)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaVersioned2kD2JoinFact(LongDSLunaVersioned2kD2V32Fix):
    """v3.2-fix + the JOIN RETENTION fact in the observation.

    march_madness scores 3.1 in every arm ever run — session, v3.1, v3.2, v3.3,
    fixed environment, principles. The cause is one line of turn 1: three inputs
    of 354/353/353 rows join to 210, and no arm noticed, so every later turn
    answered over 210 of 353 teams. The gold denominators (353 aligned, 66 passing
    the screens) are unreachable from there.

    The row counts were already printed on the `Inputs:` line. The `Lineage:`
    line could not surface the loss because it divides by the SUM of the inputs
    (1060), which makes a broken join look like an ordinary filter. So the
    observation now states retention against the SMALLEST input — the binding
    constraint for an inner join — and only when rows were actually lost.

    Renderer-side, so it needs no prompt text and applies to every layout.
    """

    _NAME = "LongDSLunaVersioned2kD2JoinFact"


class LongDSLunaVersioned2kD2DataFacts(LongDSLunaVersioned2kD2V32Fix):
    """v3.2-fix + BOTH silent-loss facts in the observation.

    One class of mistake, two forms. A join drops the rows whose key did not
    agree; a coercion drops the values it could not parse. Neither is visible:
    the row counts sit on the Inputs line unremarked, and the platform's coercion
    telemetry covers only conversions IT performs, never the
    `pd.to_numeric(..., errors="coerce")` inside the operator's own code.

    Measured: the join form cost march_madness every turn in six arms (3.1 in all
    of them; 16.1 once stated). The coercion form appears at 40% of first-error
    turns across the campaign. Both facts are computed from telemetry already
    collected, stated where the model is already reading, and silent when nothing
    was lost — no prompt text, so they apply to every layout and every arm.
    """

    _NAME = "LongDSLunaVersioned2kD2DataFacts"


class LongDSLunaVersioned2kD2DataFactsR2(LongDSLunaVersioned2kD2DataFacts):
    """Rep 2. The fixed side of the headline was one rep per task, so its spread
    was unmeasured: swapping which rep supplied march_madness alone moved the
    overall number 49.6 -> 50.2. Three reps on both sides makes the comparison
    say something."""

    _NAME = "LongDSLunaVersioned2kD2DataFactsR2"


class LongDSLunaVersioned2kD2DataFactsR3(LongDSLunaVersioned2kD2DataFacts):
    _NAME = "LongDSLunaVersioned2kD2DataFactsR3"


class LongDSLunaVersioned2kD2V33(LongDSLunaVersioned2kD2V32):
    """v3.3 — v3.2 plus the SPEC AUDIT (prompt-only, `spec_audit`).

    Built from a census of the 309-turn campaign, both layouts, 6 reps:

      * 89.4% of wrong turns declare a dependency on an already-wrong turn, and
        only 4.5% are a task's FIRST error — accuracy is set by ~59 first-error
        events whose median turn is 2.
      * Reading those 59: the answer was ~90% right and lost on ONE clause of the
        task text. Recurring classes — aggregate scoped to the rows on screen
        instead of all qualifying rows; a sample reported for the wrong
        population; a signed offset reported as its magnitude; a share over the
        wrong denominator; a percentage on the wrong scale.
      * The 24 turns where the layouts differ by >=2/3 split 12/12 between them:
        layout is accuracy-neutral, so an accuracy mechanism cannot be a layout
        change. This one is not — the audit fragment is layout-agnostic.

    So v3.3 adds a filled checklist between the work and the answer: one line per
    requested quantity, traced to an `opId (turn N)` + column, and one per binding
    clause, quoted verbatim from the task text. The trace requirement is what
    makes it more than self-congratulation, and it leans on the catalog's cheap
    `recallState` to check an inherited operator's code against a restated rule.
    """

    _NAME = "LongDSLunaVersioned2kD2V33"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("spec_audit", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaVersioned2kD2V33R2(LongDSLunaVersioned2kD2V33):
    _NAME = "LongDSLunaVersioned2kD2V33R2"


class LongDSLunaVersioned2kD2V33R3(LongDSLunaVersioned2kD2V33):
    _NAME = "LongDSLunaVersioned2kD2V33R3"


# ---------------------------------------------------------------------------
# Domain-expansion pool (2026-08-10): the eight education + sports tasks the
# 10-task campaign never covered. Config is byte-identical to the campaign's
# session baseline and v3.2 arm — only the name differs, so the established
# 309-turn numbers keep their own scratch dirs and are not retro-changed by a
# larger task set, while the new pool is still directly comparable arm-to-arm
# (both layouts run in the same era over the same tasks).
class LongDSLunaSession2kD2Ext1(LongDSLunaSession2kD2):
    _NAME = "LongDSLunaSession2kD2Ext1"


class LongDSLunaSession2kD2Ext2(LongDSLunaSession2kD2):
    _NAME = "LongDSLunaSession2kD2Ext2"


class LongDSLunaSession2kD2Ext3(LongDSLunaSession2kD2):
    _NAME = "LongDSLunaSession2kD2Ext3"


class LongDSLunaVersioned2kD2V32Ext1(LongDSLunaVersioned2kD2V32):
    _NAME = "LongDSLunaVersioned2kD2V32Ext1"


class LongDSLunaVersioned2kD2V32Ext2(LongDSLunaVersioned2kD2V32):
    _NAME = "LongDSLunaVersioned2kD2V32Ext2"


class LongDSLunaVersioned2kD2V32Ext3(LongDSLunaVersioned2kD2V32):
    _NAME = "LongDSLunaVersioned2kD2V32Ext3"


class LongDSHaikuDelta1k(LongDSBase):
    """The baseline knob set on claude-haiku-4.5 — the cheapest gateway model.

    The luna arms name `gpt-5.6-luna`, which the local LiteLLM only serves with
    an OpenAI key; this arm exists so the dataflow-agent repo's smoke runs
    (bin/bench.sh) exercise the identical turn loop on the cheapest reachable
    model.
    """

    _MODEL = "claude-haiku-4.5"
    _NAME = "LongDSHaikuDelta1k"


class LongDSHaikuVersioned2kD2V32(LongDSBase):
    """haiku-4.5 on the v3.2 catalog stack — the smoke counterpart of
    `luna-versioned-2k-d2-v32`: versioned catalog + operator-level recall,
    2k samples, data_level=2 with column stats, lineage and coercion facts."""

    _MODEL = "claude-haiku-4.5"
    _NAME = "LongDSHaikuVersioned2kD2V32"
    _RESULT_CHARS = 2000
    _STATS = True

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("versioned_mode", True)
        kwargs.setdefault("enable_recall_tool", True)
        kwargs.setdefault("recall_operator_level", True)
        kwargs.setdefault("row_lineage", True)
        kwargs.setdefault("coercion_facts", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSHaikuSessionDelta(LongDSLunaSmokeSessionDelta):
    """Session layout on claude-haiku-4.5 — `# Session` of turn entries
    (Task / Steps / Final Answer) plus a `# Your Task` tail. Byte-identical
    knobs to the luna layout-smoke cell, model swapped so the dataflow-agent
    repo can exercise the layout on the cheapest reachable model."""

    _MODEL = "claude-haiku-4.5"
    _NAME = "LongDSHaikuSessionDelta"


class LongDSHaikuVersionedDelta(LongDSLunaSmokeVCatDelta):
    """Versioned-catalog layout on claude-haiku-4.5 — one `# Catalog` over the
    immutable version DAG, `recallState` on. Same knobs as the luna cell."""

    _MODEL = "claude-haiku-4.5"
    _NAME = "LongDSHaikuVersionedDelta"



class LongDSLunaNativeRuleDelta(DataflowSystem):
    """Typed operators, one tool per operator (agent_mode=native), result
    selection rule, DELTA transcript. Same 2k / stats / d2 knobs as the
    KramaBench NativeTools arms; 25 steps per turn; 10-min engine timeout."""

    _NAME = "LongDSLunaNativeRuleDelta"
    _CONTEXT_MODE = "delta"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("agent_service_endpoint", AGENT_SERVICE_ENDPOINT)
        super().__init__(
            model_type="gpt-5.6-luna",
            agent_mode="native",
            context_mode=self._CONTEXT_MODE,
            max_steps=25,
            flow_level=1,
            data_level=2,
            column_stats=True,
            attempt_reflection=True,
            max_operator_result_char_limit=2000,
            max_operator_result_cell_char_limit=3000,
            enable_code_in_snapshot=True,
            result_selection="rule",
            execution_timeout_minutes=10,
            context_window_tokens=0,
            name=self._NAME,
            verbose=verbose,
            *args,
            **kwargs,
        )


class LongDSLunaNativeRuleLatest(LongDSLunaNativeRuleDelta):
    """Same as LongDSLunaNativeRuleDelta with the LATEST snapshot context."""

    _NAME = "LongDSLunaNativeRuleLatest"
    _CONTEXT_MODE = "latest"


class LongDSLunaNativeCatalog(LongDSLunaNativeRuleDelta):
    """Native operators under the catalog layout (versioned mode: one frozen
    entry per finished turn, recallState pull, operator-level recall)."""

    _NAME = "LongDSLunaNativeCatalog"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("versioned_mode", True)
        kwargs.setdefault("enable_recall_tool", True)
        kwargs.setdefault("recall_operator_level", True)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaNativeSession(LongDSLunaNativeRuleDelta):
    """Native operators under the session layout (full step replay per turn,
    `# Your Task` tail)."""

    _NAME = "LongDSLunaNativeSession"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("session_turns", True)
        super().__init__(verbose=verbose, *args, **kwargs)


from pathlib import Path
import sys

# The observation-format arm lives beside the benchmarks; append (never
# prepend) its directory so it cannot shadow other modules, and keep every
# other arm usable if it fails to import.
sys.path.append(str(Path(__file__).resolve().parent.parent))
try:
    from observation_format_smoke import LongDSObservationFormatLuna
except ImportError as _error:  # pragma: no cover - depends on the local checkout
    LongDSObservationFormatLuna = None
    print(f"note: luna-observation-format unavailable: {_error}", file=sys.stderr)

ARMS = {
    **({"luna-observation-format": LongDSObservationFormatLuna} if LongDSObservationFormatLuna else {}),
    "luna-native-rule-delta": LongDSLunaNativeRuleDelta,
    "luna-native-rule-latest": LongDSLunaNativeRuleLatest,
    "luna-native-catalog": LongDSLunaNativeCatalog,
    "luna-native-session": LongDSLunaNativeSession,
    "haiku-delta-1k": LongDSHaikuDelta1k,
    "haiku-v32": LongDSHaikuVersioned2kD2V32,
    "haiku-session": LongDSHaikuSessionDelta,
    "haiku-versioned": LongDSHaikuVersionedDelta,
    "luna-delta-1k": LongDSLunaDelta1k,
    "luna-delta-1k-sameera": LongDSLunaDelta1kSameEra,
    "luna-task-last": LongDSLunaDelta1kTaskLast,
    "luna-recall": LongDSLunaRecall,
    "luna-turn-recall": LongDSLunaTurnRecall,
    "luna-turn-recall-cap40": LongDSLunaTurnRecallCap40,
    "luna-turn-resume": LongDSLunaTurnResume,
    "luna-grounded": LongDSLunaGrounded,
    "luna-grounded-r2": LongDSLunaGroundedR2,
    "luna-cap40-r2": LongDSLunaTurnRecallCap40R2,
    "luna-telemetry": LongDSLunaTelemetry,
    "luna-stats": LongDSLunaStats,
    "luna-telemetry-r2": LongDSLunaTelemetryR2,
    "luna-stats-r2": LongDSLunaStatsR2,
    "luna-cap40-r3": LongDSLunaTurnRecallCap40R3,
    "luna-versioned": LongDSLunaVersioned,
    "luna-versioned-r2": LongDSLunaVersionedR2,
    "luna-versioned-rich": LongDSLunaVersionedRich,
    "luna-versioned-rich-r2": LongDSLunaVersionedRichR2,
    "luna-versioned-rich-r3": LongDSLunaVersionedRichR3,
    "luna-delta-1k-e0808": LongDSLunaDelta1kE0808,
    "luna-smoke-session-delta": LongDSLunaSmokeSessionDelta,
    "luna-smoke-session-latest": LongDSLunaSmokeSessionLatest,
    "luna-smoke-vcat-delta": LongDSLunaSmokeVCatDelta,
    "luna-smoke-vcat-latest": LongDSLunaSmokeVCatLatest,
    "luna-session-2k-d2": LongDSLunaSession2kD2,
    "luna-session-2k-d2-r2": LongDSLunaSession2kD2R2,
    "luna-session-2k-d2-r3": LongDSLunaSession2kD2R3,
    "luna-session-2k-d2-r4": LongDSLunaSession2kD2R4,
    "luna-session-2k-d2-r5": LongDSLunaSession2kD2R5,
    "luna-session-2k-d2-r6": LongDSLunaSession2kD2R6,
    "luna-versioned-2k-d2": LongDSLunaVersioned2kD2,
    "luna-versioned-2k-d2-r2": LongDSLunaVersioned2kD2R2,
    "luna-versioned-2k-d2-r3": LongDSLunaVersioned2kD2R3,
    "luna-versioned-2k-d2-v2": LongDSLunaVersioned2kD2V2,
    "luna-versioned-2k-d2-v2-r2": LongDSLunaVersioned2kD2V2R2,
    "luna-versioned-2k-d2-v2-r3": LongDSLunaVersioned2kD2V2R3,
    "luna-versioned-2k-d2-v3": LongDSLunaVersioned2kD2V3,
    "luna-session-2k-d2-r7": LongDSLunaSession2kD2R7,
    "luna-versioned-2k-d2-v31": LongDSLunaVersioned2kD2V31,
    "luna-versioned-2k-d2-v31-r2": LongDSLunaVersioned2kD2V31R2,
    "luna-versioned-2k-d2-v32": LongDSLunaVersioned2kD2V32,
    "luna-versioned-2k-d2-v32-r2": LongDSLunaVersioned2kD2V32R2,
    "luna-versioned-2k-d2-v32-r3": LongDSLunaVersioned2kD2V32R3,
    "luna-versioned-2k-d2-v31-r3": LongDSLunaVersioned2kD2V31R3,
    "luna-versioned-2k-d2-v32-fix": LongDSLunaVersioned2kD2V32Fix,
    "luna-versioned-2k-d2-principles": LongDSLunaVersioned2kD2Principles,
    "luna-versioned-2k-d2-joinfact": LongDSLunaVersioned2kD2JoinFact,
    "luna-versioned-2k-d2-datafacts": LongDSLunaVersioned2kD2DataFacts,
    "luna-versioned-2k-d2-datafacts-r2": LongDSLunaVersioned2kD2DataFactsR2,
    "luna-versioned-2k-d2-datafacts-r3": LongDSLunaVersioned2kD2DataFactsR3,
    "luna-versioned-2k-d2-v33": LongDSLunaVersioned2kD2V33,
    "luna-versioned-2k-d2-v33-r2": LongDSLunaVersioned2kD2V33R2,
    "luna-versioned-2k-d2-v33-r3": LongDSLunaVersioned2kD2V33R3,
    "luna-session-2k-d2-ext1": LongDSLunaSession2kD2Ext1,
    "luna-session-2k-d2-ext2": LongDSLunaSession2kD2Ext2,
    "luna-session-2k-d2-ext3": LongDSLunaSession2kD2Ext3,
    "luna-versioned-2k-d2-v32-ext1": LongDSLunaVersioned2kD2V32Ext1,
    "luna-versioned-2k-d2-v32-ext2": LongDSLunaVersioned2kD2V32Ext2,
    "luna-versioned-2k-d2-v32-ext3": LongDSLunaVersioned2kD2V32Ext3,
}
