# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Script ReAct: smolagents' CodeAgent as the benchmarks run it, self-contained (smolagents and the standard library).

It runs inside the bubblewrap sandbox (child.py imports it by its bare name `code_agent`), in LongDS sessions and in the
overhead experiments' replays. What a model sees: smolagents' own system prompt with CUSTOM_INSTRUCTIONS, no tools
besides final_answer, the authorized imports and `open`. This is KramaBench's code_agent.py (fork revision 50aeacc)
reduced to the setting every paper run used.
"""
import time
from dataclasses import dataclass
from typing import Optional

from smolagents import CodeAgent
from smolagents.memory import ActionStep, PlanningStep
from smolagents.models import OpenAIServerModel
from smolagents.utils import AgentMaxStepsError

CUSTOM_INSTRUCTIONS = """
## Data Science Task Guidelines

You are solving data-centric tasks by writing Python code. Follow these principles:

### Core Principles

1. **One step = One operation**: Each code block should do ONE thing (load, filter, join, aggregate, etc.). Never write large code blocks with multiple transformations.

2. **Decompose complex logic**: Break down complex analysis into small, verifiable steps. Each step should produce an intermediate result you can inspect.

3. **Build incrementally**: Use variables to store intermediate results. Build on previous steps rather than rewriting everything.

4. **Print to verify**: Use print() liberally to inspect intermediate results, data shapes, column names, and rows before proceeding.

5. **Explore before transforming**: Examine data structure when needed. You can use df.head(), df.columns, df.dtypes, or print the full data - choose what's appropriate for the situation.

### Handling Messy Data Files

Real-world data files are often malformed — they may have wrong delimiters, missing or misplaced headers, metadata/comment rows above the data, or multiple tables in one file. Before loading a file with `pd.read_csv()`, inspect the raw content first:

```python
with open('file.csv', 'r') as f:
    lines = [f.readline() for _ in range(5)]
for i, line in enumerate(lines, 1):
    print(f"Line {i}: {line.strip()}")
```

If you discover issues (e.g., semicolon delimiters, comment rows, missing headers), adjust the loading parameters (`sep=`, `header=`, `skiprows=`) and re-load. After loading, always examine the result.

### Key Reminders

- Always use print() to show intermediate results before proceeding
- Keep each code block focused on ONE transformation
- Store intermediate results in variables for reuse
- When debugging, add more print() statements to narrow down the issue
- Be aware of columns from messy files: When column names are generic (`Unnamed: 0`, `0`, `1`, ...) or look like domain-specific data values rather than field descriptions (e.g., a place name, a date, a measurement value appearing as a column header), the file was not loaded correctly. This means the real header row was missed and a data row was used as the header instead. Do NOT guess column meanings — inspect the raw file content, find the actual structure of the table, and re-load with the correct parameters (e.g., change the delimiter with `sep=`, set `header=` to the correct row number or `None`, or use `skiprows=` to skip metadata lines).
- Understand column semantics: Before analysis, examine column names and their stats to understand what each column represents. Columns may carry semantic meaning that affects how data should be filtered or interpreted — respect these signals and apply appropriate preprocessing before computing results.
- Normalize before grouping or joining: String keys may contain naming variants such as special character delimiters, encoding differences, or duplicate entries across files. Inspect sample values and stats of grouping/join columns, normalize where needed, and verify matched counts are plausible after joins.
- Dedupe before counting or aggregating concatenated data: This applies even when no join is involved. When rows are concatenated from multiple files or sections, the same entity may appear more than once (an entity that belongs to several groups appears in each group's file). Verify the entity key's distinct count against the row count; deduplicate on the entity key before any count or sum.
- Duplicate column names after re-headering: When a sheet has a merged super-header row above a repeated per-section header row, promoting the header row produces duplicate column names — one group per section. Do not drop duplicate-named columns; that silently discards entire sections. Rename them positionally using the super-header (section) names, then select the sections the question requires.
- Wrong numerical range edge cases: Watch for inclusive vs exclusive boundaries in filters (`>=` vs `>`), null/NaN rows silently dropped by aggregations, duplicate rows inflating counts or sums, and premature aggregation that loses row-level detail needed later. When a result is close but not exact, trace back through each step to find which one introduced the discrepancy.
- Unit and format consistency: Ensure the final result matches the expected units and format (e.g., percentage vs proportion, dollars vs cents). Convert explicitly in a dedicated step rather than assuming.
- Late rounding: Apply rounding only in the final step. Rounding intermediate results compounds errors across multiple steps.
- Plausibility checks on intermediate results: After selecting a column or computing a value, verify the magnitude makes sense for what it represents. If values seem implausible (e.g., orders of magnitude off from what the question implies), re-examine your column selection and data loading before proceeding.
- Load all relevant data files then choosing the correct subset of data to process: When the question requires comparing across groups, load all relevant files first, then determine the correct subset.`;
"""

REASONING_EFFORT_SUFFIXES = ("-high", "-medium", "-low")
# OpenAI reasoning models reject a non-default `temperature` (only 1 is allowed) and `stop`, and bill reasoning tokens
# inside `completion_tokens`. gpt-6* models are reasoning models too (OpenAI rejects `stop` and non-default
# temperatures for gpt-6.1-sol).
_REASONING_MODEL_PREFIXES = ("gpt-5", "o1", "o3", "o4", "gpt-6")


def _is_reasoning_model(model_id: str) -> bool:
    m = (model_id or "").split("/")[-1]
    return any(m.startswith(p) for p in _REASONING_MODEL_PREFIXES)


def _parse_model_and_reasoning_effort(model_type: str) -> tuple:
    """Parse a model name like 'gemini-4-argon-medium' into ('gemini-4-argon', 'medium')."""
    for suffix in REASONING_EFFORT_SUFFIXES:
        if model_type.endswith(suffix):
            return model_type[: -len(suffix)], suffix.lstrip("-")
    return model_type, None


class UsageTrackingOpenAIModel(OpenAIServerModel):
    """OpenAIServerModel that accumulates the per-call token-class breakdown that smolagents' RunResult.token_usage
    drops (cache-read, cache-write and reasoning tokens) by reading the raw OpenAI response on every generate() call."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.reset_usage()

    @property
    def supports_stop_parameter(self) -> bool:
        # smolagents' built-in regex misses dotted reasoning ids (e.g. "gpt-5.4"), so it would send `stop` and get a
        # 400. All reasoning models reject `stop`; force it off and let smolagents trim stop sequences client-side.
        if _is_reasoning_model(self.model_id or ""):
            return False
        from smolagents.models import supports_stop_parameter as _ssp
        return _ssp(self.model_id or "")

    def reset_usage(self):
        self.usage_acc = {"input": 0, "output": 0, "cached": 0, "cache_creation": 0, "reasoning": 0, "calls": 0}

    def _track(self, msg):
        try:
            usage = getattr(getattr(msg, "raw", None), "usage", None)
            if usage is None:
                return
            self.usage_acc["calls"] += 1
            self.usage_acc["input"] += int(getattr(usage, "prompt_tokens", 0) or 0)
            self.usage_acc["output"] += int(getattr(usage, "completion_tokens", 0) or 0)
            ptd = getattr(usage, "prompt_tokens_details", None)
            if ptd is not None:
                self.usage_acc["cached"] += int(getattr(ptd, "cached_tokens", 0) or 0)
                # litellm's extension; Anthropic bills cache writes at 1.25x input.
                self.usage_acc["cache_creation"] += int(getattr(ptd, "cache_creation_tokens", 0) or 0)
            ctd = getattr(usage, "completion_tokens_details", None)
            if ctd is not None:
                self.usage_acc["reasoning"] += int(getattr(ctd, "reasoning_tokens", 0) or 0)
        except Exception:  # noqa: BLE001 - accounting never fails a step
            pass

    def generate(self, *args, **kwargs):
        msg = super().generate(*args, **kwargs)
        self._track(msg)
        return msg


AUTHORIZED_IMPORTS = [
    # Data science essentials (with submodules)
    "numpy.*",      # numpy.linalg, numpy.random, numpy.fft, etc.
    "pandas.*",     # pandas.api, pandas.io, etc.
    "scipy.*",      # scipy.stats, scipy.optimize, scipy.interpolate, etc.
    "sklearn.*",    # sklearn.model_selection, sklearn.preprocessing, sklearn.metrics, etc.
    "matplotlib.*", # matplotlib.pyplot, matplotlib.figure, etc.
    "openpyxl.*",   # for reading .xlsx Excel files via pandas

    # HTML parsing (for pd.read_html)
    "lxml.*",       # lxml.html, lxml.etree - fast HTML/XML parser
    "bs4.*",        # BeautifulSoup for HTML parsing

    # Geospatial data (for .gpkg GeoPackage files)
    "geopandas.*",  # extends pandas for geospatial data
    "fiona.*",      # reads/writes geospatial data formats
    "shapely.*",    # geometric operations
    "pyproj.*",     # coordinate transformations

    # Scientific data formats
    "cdflib.*",     # NASA Common Data Format (.cdf files)

    # Standard library - common
    "json", "csv", "os", "glob", "math", "statistics", "random", "re",
    "datetime", "itertools", "time", "unicodedata", "queue", "stat",
    "textwrap", "string", "io", "pathlib", "functools", "operator",

    # Standard library - with submodules
    "collections.*",  # collections.abc
    "xml.*",          # xml.etree, xml.dom, xml.sax
    "urllib.*",       # urllib.parse, urllib.request
    "html.*",         # html.parser

    # Path handling (used internally by os.path, pandas, etc.)
    "posixpath", "ntpath", "genericpath",

    # Additional useful libraries
    "typing", "copy", "decimal", "fractions", "struct",
    "hashlib", "base64", "logging", "warnings", "bisect", "heapq",
]


@dataclass
class CodeAgentResult:
    """Result from running the code agent."""
    response: str
    reasoning_trace: list
    elapsed_seconds: float
    error: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    reasoning_tokens: int = 0
    cached_tokens: int = 0
    cache_creation_tokens: int = 0
    cost_usd: float = 0.0
    num_steps: int = 0
    # smolagents' RunResult.state: "success" when the agent called final_answer(), "max_steps_error" when the step
    # limit ended the run.
    state: str = ""


def extract_reasoning_trace(agent: CodeAgent) -> list[dict]:
    """Extract reasoning trace from agent memory."""
    trace = []
    if not hasattr(agent, "memory") or not agent.memory:
        return trace

    try:
        steps = agent.memory.get_full_steps()
        for idx, step in enumerate(steps):
            # Skip task entries
            if isinstance(step, dict) and "task" in step and "step_number" not in step:
                continue

            entry = {"step": step.get("step_number", idx + 1) if isinstance(step, dict) else idx + 1}

            # Extract relevant fields
            def get(key):
                return step.get(key) if isinstance(step, dict) else getattr(step, key, None)

            if get("model_output"):
                entry["model_output"] = str(get("model_output"))[:1000]
            if get("code_action"):
                entry["code"] = str(get("code_action"))[:2000]
            if get("action_output"):
                entry["output"] = str(get("action_output"))[:500]
            if get("observations"):
                entry["observations"] = str(get("observations"))[:500]
            if get("error"):
                entry["error"] = str(get("error"))
            if get("is_final_answer"):
                entry["is_final_answer"] = True

            if len(entry) > 1:
                trace.append(entry)
    except Exception:
        pass

    return trace


class CodeAgentWrapper:
    """smolagents' CodeAgent with the benchmarks' setting."""

    def __init__(self, model_type, api_base, api_key, max_steps=25, verbosity_level=1, use_custom_prompt=True,
                 max_print_outputs_length=5000, authorized_imports=None):
        self.model_type, self.api_base, self.api_key = model_type, api_base, api_key
        self.max_steps, self.verbosity_level = max_steps, verbosity_level
        self.use_custom_prompt, self.max_print_outputs_length = use_custom_prompt, max_print_outputs_length
        self.authorized_imports = authorized_imports or AUTHORIZED_IMPORTS
        self._agent: Optional[CodeAgent] = None
        self._model: Optional[OpenAIServerModel] = None

    def setup(self) -> "CodeAgentWrapper":
        model_id, reasoning_effort = _parse_model_and_reasoning_effort(self.model_type)
        model_kwargs = {}
        if reasoning_effort:
            model_kwargs["reasoning_effort"] = reasoning_effort
        # Non-reasoning models keep the historical temperature.
        if not _is_reasoning_model(model_id):
            model_kwargs["temperature"] = 0.2
        self._model = UsageTrackingOpenAIModel(model_id=model_id, api_base=self.api_base, api_key=self.api_key,
                                               **model_kwargs)
        agent_kwargs = {
            "tools": [],
            "model": self._model,
            "additional_authorized_imports": self.authorized_imports,
            "max_steps": self.max_steps,
            "verbosity_level": self.verbosity_level,
            "executor_kwargs": {"additional_functions": {"open": open}},
            "use_structured_outputs_internally": False,
        }
        if self.max_print_outputs_length is not None:
            agent_kwargs["max_print_outputs_length"] = self.max_print_outputs_length
        if self.use_custom_prompt:
            agent_kwargs["instructions"] = CUSTOM_INSTRUCTIONS
        self._agent = CodeAgent(**agent_kwargs)
        return self

    def run(self, prompt: str) -> CodeAgentResult:
        if not self._agent:
            raise RuntimeError("Agent not set up. Call setup() first.")
        error, response, state = None, "", ""
        input_tokens = output_tokens = total_tokens = num_steps = 0
        elapsed = 0.0
        try:
            # Not return_full_result=True: that exports the whole memory, which fails when a step holds a cyclic object
            # (an openpyxl worksheet, for instance) and loses an answer the agent already gave.
            started = time.time()
            output = self._agent.run(prompt)
            elapsed = time.time() - started
            # A falsy answer such as 0 is still an answer.
            response = "" if output is None else str(output)
            steps = self._agent.memory.steps
            reached_limit = bool(steps) and isinstance(getattr(steps[-1], "error", None), AgentMaxStepsError)
            state = "max_steps_error" if reached_limit else "success"
            usages = [step.token_usage for step in steps if isinstance(step, (ActionStep, PlanningStep))]
            if usages and all(usage is not None for usage in usages):
                input_tokens = sum(usage.input_tokens for usage in usages)
                output_tokens = sum(usage.output_tokens for usage in usages)
                total_tokens = input_tokens + output_tokens
            num_steps = len(steps)
        except (Exception, SystemExit) as e:
            # Model code sometimes raises SystemExit (sys.exit()); smolagents' `except Exception` lets it escape. One
            # bad task fails cleanly instead of ending the process.
            error = f"SystemExit: {e}" if isinstance(e, SystemExit) else str(e)
        trace = extract_reasoning_trace(self._agent)
        if num_steps == 0 and trace:
            num_steps = len(trace)
        # The per-class breakdown smolagents' aggregate token_usage omits; its input/output when smolagents had none.
        acc = getattr(self._model, "usage_acc", {}) or {}
        if not input_tokens and acc.get("input"):
            input_tokens = int(acc["input"])
        if not output_tokens and acc.get("output"):
            output_tokens = int(acc["output"])
        if not total_tokens:
            total_tokens = input_tokens + output_tokens
        return CodeAgentResult(
            response=response, reasoning_trace=trace, elapsed_seconds=elapsed, error=error,
            input_tokens=input_tokens, output_tokens=output_tokens, total_tokens=total_tokens,
            reasoning_tokens=int(acc.get("reasoning", 0) or 0), cached_tokens=int(acc.get("cached", 0) or 0),
            cache_creation_tokens=int(acc.get("cache_creation", 0) or 0), num_steps=num_steps, state=state)
