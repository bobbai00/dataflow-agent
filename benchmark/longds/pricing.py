"""Per-token prices for the gateway models, used only when `systems.cost_utils`
cannot price a model.

Why this exists. `cost_utils._prices()` consults `litellm.model_cost` first and a
small `_FALLBACK` table second; that fallback carries Claude models only. The
KramaBench venv does not have `litellm` installed, so on this machine EVERY
gpt-5.x arm priced to `None`, and `run_longds.py` turned that into `cost_usd:
0.0`. A LongDS run's headline claim is cost, so a whole campaign would have
reported $0.00 and looked free rather than unpriced.

The values below are litellm's own, read out of `litellm.model_cost` at
**litellm 1.96.2** (USD per token, OpenAI convention: `input` counts the whole
prompt including its cached part, and cost_utils subtracts the cached share
before multiplying). They are transcribed, not estimated — do not hand-edit a
number here without re-reading it from the same source, and prefer installing
litellm into the venv, which makes this table dead code.

`cost_utils._normalize` strips a `-high` / `-medium` / `-low` suffix before
lookup, so the medium-reasoning aliases in `bin/litellm-config.yaml`
(`gpt-5.2-medium`, `gpt-5-mini-medium`) price off their base entry here.
"""
from typing import Optional, Tuple

LITELLM_VERSION = "1.96.2"

#: model -> (input, output, cache_read, cache_creation) USD per token.
PRICES: dict[str, Tuple[float, float, float, float]] = {
    "gpt-5.6-luna": (2e-07, 1.2e-06, 2e-08, 2.5e-07),
    "gpt-5.6-terra": (2e-06, 1.2e-05, 2e-07, 2.5e-06),
    "gpt-5.6-sol": (5e-06, 3e-05, 5e-07, 6.25e-06),
    "gpt-5.6": (5e-06, 3e-05, 5e-07, 6.25e-06),
    "gpt-5.2": (1.75e-06, 1.4e-05, 1.75e-07, 2.1875e-06),
    "gpt-5.1": (1.25e-06, 1e-05, 1.25e-07, 1.5625e-06),
    "gpt-5": (1.25e-06, 1e-05, 1.25e-07, 1.5625e-06),
    "gpt-5-mini": (2.5e-07, 2e-06, 2.5e-08, 3.125e-07),
}

_SUFFIXES = ("-high", "-medium", "-low")


def _normalize(model: str) -> str:
    m = (model or "").strip()
    for suf in _SUFFIXES:
        if m.endswith(suf):
            m = m[: -len(suf)]
            break
    if "/" in m:
        m = m.split("/", 1)[1]
    return m


def cost_of(
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cached_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> Optional[float]:
    """USD for one call, or None when this table has no price either.

    Same arithmetic as `cost_utils.compute_cost` with `input_includes_cached`:
    the prompt count already contains the cached subset, so the uncached share
    is what is billed at the full input rate.
    """
    p = PRICES.get(_normalize(model)) or PRICES.get(model)
    if not p:
        return None
    in_c, out_c, cread_c, cwrite_c = p
    inp, out = int(input_tokens or 0), int(output_tokens or 0)
    cached, cwrite = int(cached_tokens or 0), int(cache_creation_tokens or 0)
    uncached = max(0, inp - cached - cwrite)
    return round(
        uncached * in_c + cached * cread_c + cwrite * cwrite_c + out * out_c, 6
    )
