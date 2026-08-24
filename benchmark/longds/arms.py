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
import os

from systems.dataflow_system import DataflowSystem

#: The main-checkout agent-service. Verified serving from
#: dataflow-agent/agent-service (not a worktree) at the time these arms landed.
AGENT_SERVICE_ENDPOINT = "http://localhost:3001"

#: A second agent-service instance, sharing the same LiteLLM gateway, JVM
#: services and Amber engine as :3001 and differing only in which agent-service
#: build serves it. An arm names its endpoint rather than inheriting one,
#: because "which service answered" is part of an arm's provenance: run_longds
#: stamps the listening process's cwd and SHA into `config.json` from whatever
#: endpoint the arm reports.
AGENT_SERVICE_ENDPOINT_ALT = "http://localhost:3005"


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
    #: Which agent-service answers this arm. Overridden per arm when a campaign
    #: runs against a second instance; every historical arm keeps :3001.
    _ENDPOINT: str = AGENT_SERVICE_ENDPOINT

    def __init__(self, verbose: bool = False, *args, **kwargs):
        # `LONGDS_AGENT_ENDPOINT` lets one arm run against a different service
        # instance without a new class — the way independent reps run
        # CONCURRENTLY, one service per pool, instead of 15 agents sharing a
        # single-threaded Bun process. Provenance is unaffected: run_longds
        # stamps the cwd and SHA of whatever endpoint actually answered.
        kwargs.setdefault(
            "agent_service_endpoint",
            os.environ.get("LONGDS_AGENT_ENDPOINT") or self._ENDPOINT,
        )
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


# ---------------------------------------------------------------------------
# BUSINESS-DOMAIN campaign (2026-08-13): the 12 business tasks, 411 turns, the
# same layout A/B the sports + education campaigns ran, one rep each.
#
# Config is byte-identical to the established `luna-session-2k-d2` and
# `luna-versioned-2k-d2-v32-fix` arms — only the name and the endpoint differ.
# Separate names because a scratch dir is keyed by SUT: reusing the campaign
# names would mix a different task set into the established 309-turn numbers
# (the same reason the Ext arms exist). Both arms answer on :3005, so the
# comparison is same-era, same-service, same-build by construction.
class _LongDSBiz:
    """Mixin: pin the business-campaign arms to the second agent-service."""

    _ENDPOINT = AGENT_SERVICE_ENDPOINT_ALT


class LongDSLunaBizSession2kD2(_LongDSBiz, LongDSLunaSession2kD2):
    """BASELINE layout on the business tasks — `# Session`, full step replay per
    turn, `# Your Task` tail, no recall tool."""

    _NAME = "LongDSLunaBizSession2kD2"


class LongDSLunaBizVersioned2kD2V32Fix(_LongDSBiz, LongDSLunaVersioned2kD2V32Fix):
    """EXPERIMENT layout on the business tasks — v3.2 (versioned catalog +
    operator-level recall + the inherited-baseline diff) on the fixed
    environment: `execution_timeout_minutes=10` here, `xgboost`/`duckdb` in the
    UDF venv, and the missing-file error that names the real paths carrying a
    basename. Same observation channel as the session arm."""

    _NAME = "LongDSLunaBizVersioned2kD2V32Fix"


class LongDSLunaBizV32Cache(LongDSLunaBizVersioned2kD2V32Fix):
    """v3.2-fix + the two 2026-08-15 service mechanisms, one measurement arm:

      * `cacheAlignedContext` — context rendered once per turn, steps appended
        at byte-stable positions, so every request extends the previous one
        (the provider's only cache-hit shape; verified 85-99% cached/step live
        against the pinned ~7k of every earlier arm);
      * batch `recallState` (`refs: [...]`) — the versions a write consumes,
        pulled in ONE step instead of 2-3.

    Same knobs as `luna-biz-v32-fix` otherwise, so a same-task comparison
    reads the two mechanisms' cost/wall-clock effect directly. The service
    knob rides in `_EXTRA_AGENT_SETTINGS` (PATCHed by run_longds after agent
    creation), because the KramaBench ctor does not know it yet.
    """

    _NAME = "LongDSLunaBizV32Cache"
    _EXTRA_AGENT_SETTINGS = {"cacheAlignedContext": True}


class LongDSLunaBizV32Verify(LongDSLunaBizV32Cache):
    """v32-cache + FOUNDATION VERIFY — the first mechanism aimed at the
    cascade root rather than the render.

    The business campaign measured 93-94% of wrong turns inheriting from an
    already-wrong upstream, median first error at turn 2-3, and the recurring
    first-error classes are population/denominator/scope choices made when the
    state is CREATED. `foundationVerify` adds one layout-agnostic prompt
    section: derive foundational quantities twice (against zero-cost
    relations), read the rendered row-count facts when numbers will be
    consumed later, and name the denominator of every reported share.

    Control is `luna-biz-v32-cache` — same build, same knobs, one flag. The
    metric that matters is WHERE the first error lands (cascade_split.py),
    not the mean score.
    """

    _NAME = "LongDSLunaBizV32Verify"
    _EXTRA_AGENT_SETTINGS = {"cacheAlignedContext": True, "foundationVerify": True}


class LongDSLunaBizV32Query(LongDSLunaBizV32Cache):
    """v32-cache + the QUERY TOOL: `queryResult(operatorId, expr)` — one
    read-only pandas expression over an operator's materialized rows, plus the
    two answer-surface rules the flip census measured (never answer from a
    truncated render; report whole rows).

    Built from the flip evidence: of the closely-read layout flips, two of five
    lost with CORRECT numbers (lean answer fields; a clipped render reported as
    complete), and the arm's extra writes are largely probes built to look at
    data (1.7x writes, 14.8 s engine execution each). The tool changes the
    ECONOMICS of looking and checking rather than adding prompt ritual —
    the four prompt-side verification nulls are why.

    Control is `luna-biz-v32-cache-r2`, same era, one flag apart.
    """

    _NAME = "LongDSLunaBizV32Query"
    _EXTRA_AGENT_SETTINGS = {"cacheAlignedContext": True, "enableQueryTool": True}


class LongDSLunaBizSessionCache(LongDSLunaBizSession2kD2):
    """The SESSION layout with cache-aligned packaging — the second half of the
    packaging verification.

    Packaging must be layout-independent: entry 0 is whatever the layout
    renders (`# Session` here, `# Catalog` on the versioned arms) and the
    per-step appends are identical machinery. An arm that cached well under one
    layout and not the other would mean the freeze had leaked into the
    renderer.
    """

    _NAME = "LongDSLunaBizSessionCache"
    _EXTRA_AGENT_SETTINGS = {"cacheAlignedContext": True}


class LongDSLunaBizV32CacheR2(LongDSLunaBizV32Cache):
    """Fresh control rep for the query experiment — a separate SUT name so the
    first rep's artifacts stay untouched, and the rep spread of the cache
    config gets measured for free."""

    _NAME = "LongDSLunaBizV32CacheR2"


ARMS = {
    "luna-biz-session": LongDSLunaBizSession2kD2,
    "luna-biz-v32-fix": LongDSLunaBizVersioned2kD2V32Fix,
    "luna-biz-v32-cache": LongDSLunaBizV32Cache,
    "luna-biz-v32-verify": LongDSLunaBizV32Verify,
    "luna-biz-v32-query": LongDSLunaBizV32Query,
    "luna-biz-v32-cache-r2": LongDSLunaBizV32CacheR2,
    "luna-biz-session-cache": LongDSLunaBizSessionCache,
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


# ---------------------------------------------------------------------------
# TOP-10 campaign (2026-08-19): the ten longest runnable tasks in the
# benchmark (both kiva tasks substituted — a measured engine data-scale limit,
# not an arm property), session vs versioned-v3.2-fix, THREE reps per arm.
# The n=3 discipline is the v7 lesson: single runs measure the config times
# one cascade-lottery draw; three reps is the minimum that separates them.
# Rep 1 runs the legacy render (byte-identical knobs to the business
# campaign pair). Reps 2-3 run with cacheAlignedContext ON — a mid-campaign
# user decision (2026-08-19) that doubles as the v2 packaging's accuracy
# validation: r1 is the legacy anchor, and an r1-vs-r2/r3 accuracy cliff
# indicts the packaging. Rep-to-rep spread is confounded with packaging by
# construction; arm-vs-arm WITHIN each round stays clean.
class LongDSLunaTop10Session(LongDSLunaBizSession2kD2):
    """Session baseline for the top-10 campaign, with ONE environment change
    from the business campaign's session arm: `execution_timeout_minutes=10`
    (the v3.2-fix value) instead of the 4-minute default. On this task set the
    default BINDS — cdp's turn 1 materializes an 869k-row feather through the
    engine and every execution died at exactly 240 s (measured: 486 s steps =
    2 ops x the cap), which would have handicapped the session arm against a
    versioned arm that already carries 10 minutes. Equalized so the layout
    comparison stays about layout."""

    _NAME = "LongDSLunaTop10Session"

    def __init__(self, verbose: bool = False, *args, **kwargs):
        kwargs.setdefault("execution_timeout_minutes", 10)
        super().__init__(verbose=verbose, *args, **kwargs)


class LongDSLunaTop10SessionR2(LongDSLunaTop10Session):
    _NAME = "LongDSLunaTop10SessionR2"
    _EXTRA_AGENT_SETTINGS = {"cacheAlignedContext": True}


class LongDSLunaTop10SessionR3(LongDSLunaTop10Session):
    _NAME = "LongDSLunaTop10SessionR3"
    _EXTRA_AGENT_SETTINGS = {"cacheAlignedContext": True}


class LongDSLunaTop10V32(LongDSLunaBizVersioned2kD2V32Fix):
    _NAME = "LongDSLunaTop10V32"


class LongDSLunaTop10V32R2(LongDSLunaTop10V32):
    _NAME = "LongDSLunaTop10V32R2"
    _EXTRA_AGENT_SETTINGS = {"cacheAlignedContext": True}


class LongDSLunaTop10V32R3(LongDSLunaTop10V32):
    """Rep 3 of the versioned arm, WITH the two trace-grounded fixes from the
    round-2 flip analysis (user decision 2026-08-19: fix first, then run r3
    v32-only):

      * `upstreamValueEcho` — a write wiring an unrecalled cross-turn version
        gets that version's sample rows auto-attached to its observation
        (the nfl-t3 class: nine blind revisions, wrong denominator, ~30
        dependent turns lost);
      * `answerShapeRule` — mirror source column names, flat structure, whole
        rows (the acea2-t1 class: byte-identical numbers scored 0 under
        renamed/nested fields).

    NOTE r3-v32 is therefore NOT a pure replicate of r2-v32: it measures the
    fix pack. Session-r3 was intentionally skipped (same decision)."""

    _NAME = "LongDSLunaTop10V32R3"
    _EXTRA_AGENT_SETTINGS = {
        "cacheAlignedContext": True,
        "upstreamValueEcho": True,
        "answerShapeRule": True,
    }


class LongDSLunaSub5V33(LongDSLunaTop10V32):
    """v3.3 iteration arm on the 5-task signal subset (kaggle t3, nfl t1,
    acea2, acea3, wids1 — the tasks with the largest ses<->v32 accuracy
    diffs over rounds 1-2; the other five top-10 tasks score at the floor in
    every arm and carry no iteration signal).

    Composition, from the r2 loss anatomy (2026-08-20):

      * `cacheAlignedContext` — the cost mechanism, unchanged from r2/r3;
      * `answerShapeRule` — verified on target (acea2 t1 flipped 0->1 in r3);
      * `catalogDetail: "code"` — NEW. Each finished catalog entry renders its
        operator versions' code. Targets the dominant loss class of the
        versioned layout: convention re-derivation (nfl t3 denominator
        cascade = 14 turns; acea2 t6 feature-prep drift; kaggle t18
        population drift), which session arms avoid by reading prior code
        inline in their step history. Under cache-aligned packaging the extra
        entry bytes are byte-stable, i.e. mostly cached-token priced.

    Deliberately WITHOUT `upstreamValueEcho`: unproven after r3 (trailed r2
    on all early-judged tasks; the losses traced to cascade draws, but the
    mechanism bought nothing measurable), and one variable at a time."""

    _NAME = "LongDSLunaSub5V33"
    _EXTRA_AGENT_SETTINGS = {
        "cacheAlignedContext": True,
        "answerShapeRule": True,
        "catalogDetail": "code",
    }


class LongDSLunaSub5V33R2(LongDSLunaSub5V33):
    _NAME = "LongDSLunaSub5V33R2"


class LongDSLunaSub5V33R3(LongDSLunaSub5V33):
    _NAME = "LongDSLunaSub5V33R3"


ARMS.update({
    "luna-top10-session": LongDSLunaTop10Session,
    "luna-top10-session-r2": LongDSLunaTop10SessionR2,
    "luna-top10-session-r3": LongDSLunaTop10SessionR3,
    "luna-top10-v32": LongDSLunaTop10V32,
    "luna-top10-v32-r2": LongDSLunaTop10V32R2,
    "luna-top10-v32-r3": LongDSLunaTop10V32R3,
    "luna-sub5-v33": LongDSLunaSub5V33,
    "luna-sub5-v33-r2": LongDSLunaSub5V33R2,
    "luna-sub5-v33-r3": LongDSLunaSub5V33R3,
})


class LongDSLunaSub5V34(LongDSLunaSub5V33):
    """v3.4 — v33 plus the VALUE PROBE rule + the queryResult tool that makes
    it followable.

    Trace-grounded on the v33 3-rep campaign's one reproducible loss block:
    kaggle t23-28+31 failed in two independent v33 reps because the model
    typed the salary-band midpoint dict from memory with `$` on every key,
    while the data carries `$` on one band only — ~every row mapped to NaN,
    silently. The session run probed the actual band strings first
    (`salary_band_values`) and scored. Same blindness class as nfl t3.

    `valueProbeRule` (prompt): literals that must match data values are
    copied from a one-call `queryResult` look at the actual values, and a
    mapping's coverage is checked once after it runs. `enableQueryTool` makes
    both checks one cheap call instead of a probe operator."""

    _NAME = "LongDSLunaSub5V34"
    _EXTRA_AGENT_SETTINGS = {
        "cacheAlignedContext": True,
        "answerShapeRule": True,
        "catalogDetail": "code",
        "enableQueryTool": True,
        "valueProbeRule": True,
    }


class LongDSLunaSub5V34R2(LongDSLunaSub5V34):
    _NAME = "LongDSLunaSub5V34R2"


class LongDSLunaSub5V34R3(LongDSLunaSub5V34):
    _NAME = "LongDSLunaSub5V34R3"


ARMS.update({
    "luna-sub5-v34": LongDSLunaSub5V34,
    "luna-sub5-v34-r2": LongDSLunaSub5V34R2,
    "luna-sub5-v34-r3": LongDSLunaSub5V34R3,
})


class LongDSLunaSub5V35(LongDSLunaSub5V34):
    """v3.5 — push the value inventories INTO the catalog, demote the probe.

    User direction after the v34-r1 query census (990 queryResult calls over 5
    tasks, ~60% precomputable: value inventories, size checks, browsing reads,
    schema navigation): catalog entries are byte-stable and cache-priced under
    cacheAlignedContext, so push the information once instead of paying a
    runtime probe per use.

      * `catalogDetail: "values"` — each entry adds the worker's FULL-TABLE
        per-column stats block (distinct-value histograms with counts, nulls,
        ranges; wide tables capped) on top of the version's code;
      * `valueProbeRule` keeps its literal discipline but swaps to the demoted
        variant: copy spellings off the entry's stats block; spend queryResult
        only on clipped inventories and genuinely dynamic reads (ranked top-N,
        filtered rows, post-mapping coverage)."""

    _NAME = "LongDSLunaSub5V35"
    _EXTRA_AGENT_SETTINGS = {
        "cacheAlignedContext": True,
        "answerShapeRule": True,
        "catalogDetail": "values",
        "enableQueryTool": True,
        "valueProbeRule": True,
    }


class LongDSLunaSub5V35R2(LongDSLunaSub5V35):
    _NAME = "LongDSLunaSub5V35R2"


class LongDSLunaSub5V35R3(LongDSLunaSub5V35):
    _NAME = "LongDSLunaSub5V35R3"


class LongDSLunaSub5V35R4(LongDSLunaSub5V35):
    """Third rep of v35 ON THE FIXED SERVICE BUILD.

    Rep 1 ran against an agent-service started 15:32, before the 15:46
    queryResult truthfulness fix (`[PARTIAL]` scope header + safe builtins)
    landed; reps 2-3 ran against services started 17:02, after it. The probe
    census shows the split cleanly — 210 probe calls/run in rep 1 versus 52 in
    reps 2-3 — so rep 1 is NOT a replicate of reps 2-3 and this arm supplies
    the third same-build rep. Rep 1 is kept as the measurement of what the
    silent-partial-read probe cost."""

    _NAME = "LongDSLunaSub5V35R4"


ARMS.update({
    "luna-sub5-v35": LongDSLunaSub5V35,
    "luna-sub5-v35-r2": LongDSLunaSub5V35R2,
    "luna-sub5-v35-r3": LongDSLunaSub5V35R3,
    "luna-sub5-v35-r4": LongDSLunaSub5V35R4,
})


class LongDSLunaSub5V36(LongDSLunaSub5V35):
    """v3.6 — identical knobs to v35, plus the two queryResult BUG FIXES the
    probe census turned up. The catalog still renders the full stats block per
    entry (a trimmed variant was tried and reverted: the stats are wanted).

      * `[PARTIAL]` scope header — the service holds only the rows that fit the
        per-operator char budget, so a probe over kaggle's 297-column raw table
        ran over ONE held row of 21,879 while its own prompt told the model to
        use it INSTEAD of a clipped render. `value_counts()` over that row
        looked exactly like the real inventory. 12% of v34's probes were
        aggregates over such a prefix.
      * safe-builtins whitelist — 54 of v34's 177 failed probes were
        `NameError` on `any`/`len`/`sorted`, ordinary pandas idiom; the model
        read the failure as its own syntax error and retried dead variants.
        Probe error rate fell 17% -> 2% once available.

    The census also priced probing honestly: probe OUTPUT is only ~2% of billed
    context, but probes took 43% of v34's agent steps, and a step re-sends the
    whole frozen context — that, not the probe payload, is what moved cost per
    run from $0.66 to $0.88."""

    _NAME = "LongDSLunaSub5V36"


class LongDSLunaSub5V36R2(LongDSLunaSub5V36):
    _NAME = "LongDSLunaSub5V36R2"


class LongDSLunaSub5V36R3(LongDSLunaSub5V36):
    _NAME = "LongDSLunaSub5V36R3"


ARMS.update({
    "luna-sub5-v36": LongDSLunaSub5V36,
    "luna-sub5-v36-r2": LongDSLunaSub5V36R2,
    "luna-sub5-v36-r3": LongDSLunaSub5V36R3,
})


class LongDSLunaSub5V37(LongDSLunaSub5V36):
    """v3.7 — PUSH ONLY: catalog stats stay, the probe tool goes.

    `recallState` is unchanged (it has been on in every versioned arm), and the
    catalog still carries each version's code and full stats block. What is
    removed is `queryResult`: the census says the pull is a bad trade once the
    push exists —

      * probes took 43% of agent steps in v34 and 21% in v35, and every step
        re-sends the whole frozen context, so a probe costs about a context
        re-send rather than its own payload (which is ~2% of billed context);
      * only 28% of probe outputs had a value that provably reappeared in later
        code or the answer;
      * the classes the catalog now covers — value inventories, size and
        cardinality checks, schema navigation — were a third of all probes;
      * what remains genuinely dynamic (a true top-N beyond a clipped render,
        a specific row set) an operator can compute, which is also how every
        pre-v34 arm did it.

    `valueProbeRule` stays ON and swaps to its no-tool variant: spellings come
    off the entry's stats block, older versions from `recallState`, and a
    mapping's coverage is read off the resulting operator's own null counts.
    This is the arm that answers whether the flexible probe was ever paying for
    itself, or whether pushing the same facts into a byte-stable entry is
    strictly better."""

    _NAME = "LongDSLunaSub5V37"
    _EXTRA_AGENT_SETTINGS = {
        "cacheAlignedContext": True,
        "answerShapeRule": True,
        "catalogDetail": "values",
        "enableQueryTool": False,
        "valueProbeRule": True,
    }


class LongDSLunaSub5V37R2(LongDSLunaSub5V37):
    _NAME = "LongDSLunaSub5V37R2"


class LongDSLunaSub5V37R3(LongDSLunaSub5V37):
    _NAME = "LongDSLunaSub5V37R3"


ARMS.update({
    "luna-sub5-v37": LongDSLunaSub5V37,
    "luna-sub5-v37-r2": LongDSLunaSub5V37R2,
    "luna-sub5-v37-r3": LongDSLunaSub5V37R3,
})


class LongDSLunaSub5V38(LongDSLunaSub5V36):
    """v3.8 — the middle setting: keep the probe, CAP it at 5 calls per turn.

    v36 (probe, ceiling 15) and v37 (no probe) each win half the subset: v36
    holds acea3 at 94-100 across five reps where v37 sits at 70-76 twice, and
    v37 takes wids1 by ~20 points and runs ~15% cheaper with 0.8 fewer steps
    per turn. The probe is therefore load-bearing on some turns and pure step
    inflation on others, which is a BUDGET question rather than an on/off one.

    Where the cap comes from: over four 5-task reps, 396 probing turns issued
    2,018 probes; turns using more than five calls were 31% of probing turns
    but 40% of all probes, and that tail is dominated by row-browsing. A
    ceiling of 5 keeps ~60% of probe volume and leaves ~69% of probing turns
    completely untouched — including acea3's early foundation turns, which is
    where its probes actually land.

    `queryCallsPerTurn` is a real setting rather than a constant so v36 keeps
    its ceiling of 15 and stays a valid control."""

    _NAME = "LongDSLunaSub5V38"
    _EXTRA_AGENT_SETTINGS = {
        "cacheAlignedContext": True,
        "answerShapeRule": True,
        "catalogDetail": "values",
        "enableQueryTool": True,
        "valueProbeRule": True,
        "queryCallsPerTurn": 5,
    }


class LongDSLunaSub5V38R2(LongDSLunaSub5V38):
    _NAME = "LongDSLunaSub5V38R2"


class LongDSLunaSub5V38R3(LongDSLunaSub5V38):
    _NAME = "LongDSLunaSub5V38R3"


ARMS.update({
    "luna-sub5-v38": LongDSLunaSub5V38,
    "luna-sub5-v38-r2": LongDSLunaSub5V38R2,
    "luna-sub5-v38-r3": LongDSLunaSub5V38R3,
})

# ---------------------------------------------------------------------------
# BUSINESS + SPORTS campaign (2026-08-21). The two hardest domains of the
# benchmark, three reps each of the two arms that survived the top-10 work:
# the session baseline and v3.7 (versioned catalog + values + no probe).
#
# Separate SUT names from the top-10 arms on purpose: the task sets differ, so
# mixing them into one scratch directory would make "the 3-rep mean" ambiguous.
# The knobs are identical to their top-10 counterparts, so a per-task number is
# directly comparable across campaigns.
# ---------------------------------------------------------------------------


class LongDSLunaBSSession(LongDSLunaTop10Session):
    """Session baseline, cache-aligned — same knobs as LongDSLunaTop10SessionR2."""

    _NAME = "LongDSLunaBSSession"
    _EXTRA_AGENT_SETTINGS = {"cacheAlignedContext": True}


class LongDSLunaBSSessionR2(LongDSLunaBSSession):
    _NAME = "LongDSLunaBSSessionR2"


class LongDSLunaBSSessionR3(LongDSLunaBSSession):
    _NAME = "LongDSLunaBSSessionR3"


class LongDSLunaBSV37(LongDSLunaSub5V37):
    """v3.7 on business + sports. Knobs identical to LongDSLunaSub5V37:
    cache-aligned packaging, answer-shape rule, catalog entries carrying code
    and full column stats, the literal-discipline rule in its no-tool variant,
    and queryResult OFF (the flag stays, so it can be turned back on)."""

    _NAME = "LongDSLunaBSV37"


class LongDSLunaBSV37R2(LongDSLunaBSV37):
    _NAME = "LongDSLunaBSV37R2"


class LongDSLunaBSV37R3(LongDSLunaBSV37):
    _NAME = "LongDSLunaBSV37R3"


class LongDSLunaBSQO(LongDSLunaTop10Session):
    """QUESTION-ONLY on business + sports — the stripped extreme of the layout
    spectrum (question-only <- versioned catalog <- full session). Past turns
    render as their question text only: no steps, no dataflows, no answers.
    The agent re-derives everything each turn from the raw files; the question
    history exists solely so cross-turn references stay resolvable.

    Inherits the session lineage so every non-layout knob (model, result chars,
    data level, execution timeout, delta ReAct) matches the session baseline
    exactly; `questionOnlyTurns` takes precedence over the inherited
    session_turns flag inside the renderer, so the only difference between this
    arm and the session arm IS the layout. Cache-aligned like both other arms.
    """

    _NAME = "LongDSLunaBSQO"
    _EXTRA_AGENT_SETTINGS = {"cacheAlignedContext": True, "questionOnlyTurns": True}


class LongDSLunaBSQOR2(LongDSLunaBSQO):
    _NAME = "LongDSLunaBSQOR2"


class LongDSLunaBSQOR3(LongDSLunaBSQO):
    _NAME = "LongDSLunaBSQOR3"


class LongDSLunaBSV37F(LongDSLunaBSV37):
    """v3.7 on the catalog-example service build (reported as V37 — the
    considered V37 after the rollback autopsy). Knobs identical to
    LongDSLunaBSV37; the difference is the service's versioned-mode prompt now
    carries the catalog field guide + a worked multi-turn example: wire the
    defining (opId, turn) version (recallState first) or copy its selection
    logic verbatim instead of re-deriving conventions from paraphrase, and
    treat version pins as last-rebuilt, not currently-in-effect. Separate SUT
    name so the pre-fix grid survives for the before/after comparison."""

    _NAME = "LongDSLunaBSV37F"
    # Knobs identical to LongDSLunaBSV37 (inherited): the fix is not a setting —
    # the catalog example rides versionedMode in the service build this arm
    # runs against. The separate SUT name is what separates before from after.


class LongDSLunaBSV37FR2(LongDSLunaBSV37F):
    """NOT a pure replicate: rep-2 slot doubles as the SAMPLE-ROWS probe (user
    request, 2026-08-22) — same knobs as V37F plus catalogSampleRowsRatio=0.5:
    each finished catalog entry carries 50% of the version's in-memory rows,
    first-half/last-half like the ReAct render, char-capped. Errored versions
    render code + error instead. Compare against r1/r3 (rows off) to price the
    rows; the clean V37F mean is r1+r3."""

    _NAME = "LongDSLunaBSV37FR2"
    _EXTRA_AGENT_SETTINGS = dict(LongDSLunaBSV37._EXTRA_AGENT_SETTINGS, catalogSampleRowsRatio=0.5)


class LongDSLunaBSV37FR3(LongDSLunaBSV37F):
    _NAME = "LongDSLunaBSV37FR3"


# ---------------------------------------------------------------------------
# TWO-ENDS campaign (2026-08-22): the 5 longest tasks (nfl 42, wids 40, cdp 39,
# acea2 38, acea3 37) and the 5 shortest (github 15, univ-rankings 21/23,
# kaggle-survey-2021 25, LearnPlatform 25), three arms:
#   session — full history baseline;
#   qo      — question-only extreme;
#   v38     — the catalog as a verified extension cache: gradual entries
#             (catalogFreshTurns=5), 50% sample rows on fresh entries, thin
#             stats, recallState demoted to exceptional by the rewritten
#             catalog-example.md, plus the extension rule.
# ---------------------------------------------------------------------------


class LongDSLunaTESession(LongDSLunaBSSession):
    _NAME = "LongDSLunaTESession"


class LongDSLunaTESessionR2(LongDSLunaTESession):
    _NAME = "LongDSLunaTESessionR2"


class LongDSLunaTESessionR3(LongDSLunaTESession):
    _NAME = "LongDSLunaTESessionR3"


class LongDSLunaTEQO(LongDSLunaBSQO):
    _NAME = "LongDSLunaTEQO"


class LongDSLunaTEQOR2(LongDSLunaTEQO):
    _NAME = "LongDSLunaTEQOR2"


class LongDSLunaTEQOR3(LongDSLunaTEQO):
    _NAME = "LongDSLunaTEQOR3"


class LongDSLunaTEV38(LongDSLunaBSV37):
    """V38: v37 knobs + gradual catalog (fresh window 5) + 50% sample rows on
    fresh entries + the quote-from-entry prompt with optional recall and the
    extension rule (catalog-example.md as of this commit)."""

    _NAME = "LongDSLunaTEV38"
    _EXTRA_AGENT_SETTINGS = dict(
        LongDSLunaBSV37._EXTRA_AGENT_SETTINGS,
        catalogSampleRowsRatio=0.5,
        catalogFreshTurns=5,
    )


class LongDSLunaTEV38R2(LongDSLunaTEV38):
    _NAME = "LongDSLunaTEV38R2"


class LongDSLunaTEV38R3(LongDSLunaTEV38):
    _NAME = "LongDSLunaTEV38R3"


class LongDSLunaTEV39(LongDSLunaTEV38):
    """V39 = V38 + the terminal `answer` tool with a required `conventions`
    field: the turn ends by handing in the answer plus the interpretive
    choices it settled (ranking direction, percentile grain, set definitions,
    tie-breaks, seeds), which the catalog pins as a never-aging
    `### Conventions` line in the entry. Targets the measured convention
    re-instantiation drift (nfl t2 gate, acea per-entity rolls) — the one
    slice of session-style reasoning the catalog was missing."""

    _NAME = "LongDSLunaTEV39"
    _EXTRA_AGENT_SETTINGS = dict(LongDSLunaTEV38._EXTRA_AGENT_SETTINGS, enableAnswerTool=True)


class LongDSLunaTEV40(LongDSLunaTEV39):
    """V40 "lean latest-dataflow catalog": finished entries carry ONLY
    Task / Solution / Answer (no dataflow deltas, code, stats or sample rows);
    the workflow renders once as `# Dataflow (latest)` — one shared dataflow,
    references always mean the latest version, matching the engine's actual
    overwrite semantics. History is reachable only through
    recallState("opId (turn N)") with as-of resolution; version-pinned wiring
    (upstreams/from refs) is gone from the write tool. The answer tool asks
    for the turn's settled `decisions` (rendered as the entry's Solution
    line). Targets the measured pathologies of the version-DAG rendering:
    stale head pins, referent confusion, rollback re-derivation."""

    _NAME = "LongDSLunaTEV40"
    _EXTRA_AGENT_SETTINGS = dict(
        LongDSLunaTEV39._EXTRA_AGENT_SETTINGS,
        catalogLatestDataflow=True,
        # Entry payload knobs are moot (lean entries render none of it) and the
        # value-probe rule described catalog stats blocks that no longer exist.
        valueProbeRule=False,
    )


class LongDSLunaTEV40D(LongDSLunaTEV40):
    """V40D = v40 lean chassis + code-bearing Dataflow delta per entry (no
    stats/rows) + the copy-forward rule + `# Dataflow (built from previous
    turns)` index. Same agent settings as v40 — the D build differs only in
    agent-service source (renderer + fragments), so it gets its own SUT dir
    to keep rep-1's pure-lean ablation data intact."""

    _NAME = "LongDSLunaTEV40D"


class LongDSLunaTEV40DR2(LongDSLunaTEV40D):
    _NAME = "LongDSLunaTEV40DR2"


class LongDSLunaTEV40DR3(LongDSLunaTEV40D):
    _NAME = "LongDSLunaTEV40DR3"


class LongDSLunaTEV40R2(LongDSLunaTEV40):
    _NAME = "LongDSLunaTEV40R2"


class LongDSLunaTEV40R3(LongDSLunaTEV40):
    _NAME = "LongDSLunaTEV40R3"


# --- Engine-cache verification probes (2026-08-23) -------------------------
# Same knobs as the TE arms, fresh SUT dirs. Used to verify cross-turn engine
# result caching (operator_port_cache) end-to-end per context mode after the
# idle-teardown cache-wipe fix in WorkflowService.clearExecutionResources.


class LongDSLunaCacheSession(LongDSLunaTESession):
    _NAME = "LongDSLunaCacheSession"


class LongDSLunaCacheQO(LongDSLunaTEQO):
    _NAME = "LongDSLunaCacheQO"


class LongDSLunaCacheV38(LongDSLunaTEV38):
    _NAME = "LongDSLunaCacheV38"


class LongDSLunaTEV39R2(LongDSLunaTEV39):
    _NAME = "LongDSLunaTEV39R2"


class LongDSLunaTEV39R3(LongDSLunaTEV39):
    _NAME = "LongDSLunaTEV39R3"


ARMS.update({
    "luna-bs-session": LongDSLunaBSSession,
    "luna-bs-session-r2": LongDSLunaBSSessionR2,
    "luna-bs-session-r3": LongDSLunaBSSessionR3,
    "luna-bs-v37": LongDSLunaBSV37,
    "luna-bs-v37-r2": LongDSLunaBSV37R2,
    "luna-bs-v37-r3": LongDSLunaBSV37R3,
    "luna-bs-qo": LongDSLunaBSQO,
    "luna-bs-qo-r2": LongDSLunaBSQOR2,
    "luna-bs-qo-r3": LongDSLunaBSQOR3,
    "luna-bs-v37f": LongDSLunaBSV37F,
    "luna-bs-v37f-r2": LongDSLunaBSV37FR2,
    "luna-bs-v37f-r3": LongDSLunaBSV37FR3,
    "luna-te-session": LongDSLunaTESession,
    "luna-te-session-r2": LongDSLunaTESessionR2,
    "luna-te-session-r3": LongDSLunaTESessionR3,
    "luna-te-qo": LongDSLunaTEQO,
    "luna-te-qo-r2": LongDSLunaTEQOR2,
    "luna-te-qo-r3": LongDSLunaTEQOR3,
    "luna-te-v38": LongDSLunaTEV38,
    "luna-te-v38-r2": LongDSLunaTEV38R2,
    "luna-te-v38-r3": LongDSLunaTEV38R3,
    "luna-te-v39": LongDSLunaTEV39,
    "luna-te-v39-r2": LongDSLunaTEV39R2,
    "luna-te-v39-r3": LongDSLunaTEV39R3,
    "luna-te-v40": LongDSLunaTEV40,
    "luna-te-v40d": LongDSLunaTEV40D,
    "luna-te-v40d-r2": LongDSLunaTEV40DR2,
    "luna-te-v40d-r3": LongDSLunaTEV40DR3,
    "luna-te-v40-r2": LongDSLunaTEV40R2,
    "luna-te-v40-r3": LongDSLunaTEV40R3,
    "luna-cache-session": LongDSLunaCacheSession,
    "luna-cache-qo": LongDSLunaCacheQO,
    "luna-cache-v38": LongDSLunaCacheV38,
})
