<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# smolagents service

A multi-user web app around the smolagents `CodeAgent` (the benchmarks' script
baseline, pinned at smolagents 1.23): people register, upload data, and chat
with an agent that writes and runs Python. Every step of every answer is traced
to the user's account in SQLite.

```bash
# from the repository root, with the LiteLLM gateway on :4000 (bin/local-dev.sh)
cd smolagents-service && ../.venv/bin/python -m smolagents_service     # http://127.0.0.1:7860
```

Open the URL, create an account, add a CSV, ask a question. The **My traces**
tab shows your runs, their steps, a timeline of model calls and code executions,
and the exact context each model call was sent. `LITELLM_MASTER_KEY` comes from
the shell or the repo-root `.env`, as for `bin/local-dev.sh`.

**Chats.** The sidebar lists your chats, the most recently used first, and the
page opens on the latest. **＋ New chat** starts an empty one, with a new agent
and a new Python session; it joins the list with its first message, script or
notebook, named after it. Pick a chat in the list to go back to it: the chat
shows its history from the trace, and its agent and Python session continue it
(see Chats, and sessions that continue from the trace). Each chat has its own
memory and variables. While a run is in progress, the tab stays on its chat.

**Uploads.** Drop several files on the upload box at once, or pick several. Data
files are mentioned to the agent with your next message, the last script is
loaded into the code panel, and each notebook is imported into the chat once
every file of the drop is in place, so a notebook dropped with its data reads it.

**The chat shows each thing once.** While a step is being written it streams
into a "✍️ Step N" box. When it finishes, the box is replaced by the step's
reasoning in a sentence and one folded **🐍 Ran Python** block: the code, what
it printed, and the step's time and tokens. A step that only delivers the answer
adds nothing. The answer appears once at the end, with a line of the run's
totals. (smolagents' own renderer shows the code and the answer twice each.)

**Your own code.** Upload a `.py` file, or open **Run your own Python** under the
chat, and press **Run**. The code runs in this chat's Python session, beside the
agent's variables. Its output, charts and new variables appear in the chat. The
agent's memory gets a note: "the user ran this code; here is what it printed and
defined". So a follow-up like "using the by_city table from my script, …" works
on the variable itself. Uploads, scripts and anything code writes share one
`files` folder per user, so an existing script's relative paths to its data work.

**A notebook.** Upload an `.ipynb` file and the chat imports it as the agent's
own earlier work: the markdown before the first code cell is shown as the task,
each code cell runs in the chat's Python session and appears as a **🐍 Ran Python**
step (the markdown above it as the step's reasoning), and the markdown after the
last cell is shown as the answer. The agent's memory gets the same: a task, one
step per cell with what it printed and returned, the answer as the final step,
and a note that the work is its own (`--notebook-instructions` appends to that
note, for a study's rules, say). Upload the notebook's data files first, or in
the same drop; cells read them by relative path from the `files` folder. A notebook that reads a file
by name (`pd.read_csv("listings.csv")`) that is not there yet is not imported;
the upload status names the files to add.

The cells run like a Jupyter kernel's: in one namespace with the agent's code, so
a function a cell defines sees variables set by later cells and by the agent.
`%matplotlib inline` and `!pip ...` lines are skipped, and `display()` prints. As
with Jupyter's Run All, a cell that fails ends the import, since the cells after it
would only fail on what it did not define. The chat then says which cell failed
and why, and the agent's memory notes where the import stopped.

| Flag | Default | |
|---|---|---|
| `--port`, `--host` | 7860, 127.0.0.1 | |
| `--data-dir` | `logs/smolagents-service` | accounts and traces (`traces.db`), every user's files |
| `--model` | `claude-sonnet-5.5` | any model id the gateway serves |
| `--instructions` | | text appended to every agent's instructions, or `@PATH` to a file holding it |
| `--notebook-instructions` | | text the agent is told after a notebook is imported, or `@PATH` |
| `--concurrency` | 16 | agent runs in progress at once, across all users |
| `--max-sessions` | 32 | open chat sessions; each holds a worker process of ~0.1–0.3 GB |
| `--exec-timeout` | 300 | seconds one code execution may run before its worker is restarted |
| `--disconnect-grace` | 60 | seconds after a tab closes before its session and worker end |
| `--idle-minutes` | 60 | a session unused this long ends |
| `--sandbox` | `auto` | `seatbelt` on macOS, else `none`; see Isolation |
| `--secure-cookies` | off | set when served over HTTPS |
| `--seed` | | a seed definition: a notebook and its data files imported into every new account; see Seeding |

## How it fits together

```
browser ──► FastAPI ── /register /login /logout     accounts, httpOnly login cookie
               │       /api/...                     the caller's own traces as JSON
               └─────► /app  (Gradio, behind the login)
                         └─ one chat session per tab, on one of the user's chats:
                              CodeAgent ── TracedModel ──► LiteLLM gateway
                                  │
                                  └─ WorkerExecutor ──► worker process (sandboxed),
                                                        smolagents' LocalPythonExecutor
```

- `store.py` — SQLite (WAL): accounts (scrypt), logins, traces; every read filters on the caller's user id.
- `sessions.py` — per tab: a `CodeAgent`, its worker, its trace, on one chat. Ends when the tab moves to another chat, is gone past the grace period, or sits idle. The user's own runs join the agent's memory as a `UserCodeStep`.
- `executor.py` / `worker.py` — one Python process per chat for both the agent's code and the user's; figures come back as PNGs.
- `tracing.py` — records model calls (wrapping the model) and code executions; writes steps from a smolagents step callback.
- `render.py` / `ui.py` — the chat list, the chat (each step shown once), the code panel, and the trace pages.
- `app.py` — routes, the login wall, and the heartbeat watch that notices closed tabs.

A browser tab is on one chat at a time, and its session has one Python worker
process: every step of every message runs in it, the user's own code included.
Variables carry over from step to step and from message to message. Moving the
tab to another chat ends the session; the other chat gets a session of its own,
restored from the trace. Another tab, or a page reload, opens the latest chat in
a new session, restored the same way. The agent loop and the model calls run in
the server process; only code runs in the worker. A step that times out or
crashes the worker restarts it, without the earlier variables.

## Traces

All times are Unix epoch seconds. A **run** is one user message and the
agent's whole answer to it; a run has **steps**; a step has one **LLM call** and,
when the reply held code, one **Python execution**.

| Table | One row per | Times and measures |
|---|---|---|
| `chats` | conversation | `title` (from its first run), `created_at` |
| `runs` | user message, user code run, or notebook import | `chat_id`, `turn` within the chat, `kind` (agent, script or notebook), `started_at`, `ended_at`, `status` (ok, error, max_steps, cancelled), `final_answer` |
| `steps` | agent step | `started_at`, `ended_at` (smolagents' own step timing), token usage, model output, code, observations, error |
| `llm_calls` | model call | `started_at`, `first_token_at`, `ended_at`, tokens, `input_messages` (the full context sent), output |
| `python_execs` | code execution | `started_at`, `ended_at` (round trip), `worker_seconds` (inside the interpreter), `worker_pid`, logs, output, error |
| `artifacts` | figure or upload | file path under the owner's folder |
| `chat_sessions` | browser tab | open, close, and why it closed |
| `events` | account action | register, login, login_failed, logout, upload, session start and end |

Views `step_timing` (each step's `seconds`, `llm_seconds`, `python_seconds`)
and `run_summary` (steps, calls, time split and tokens per run) do the joins:

```sql
-- where each step's time went
SELECT u.username, r.turn, s.step_number, round(s.seconds, 2) AS s, round(s.llm_seconds, 2) AS llm,
       round(s.python_seconds, 2) AS python, round(s.seconds - s.llm_seconds - s.python_seconds, 3) AS other,
       s.input_tokens, s.output_tokens
FROM step_timing s JOIN runs r ON r.id = s.run_id JOIN users u ON u.id = s.user_id
ORDER BY s.started_at DESC LIMIT 20;
```

The same records, for the signed-in user only: `GET /api/chats`, `GET /api/runs`,
`GET /api/runs/{id}?context=true`, `DELETE /api/runs/{id}`, `GET /api/events`,
`GET /api/me`.

## Chats, and sessions that continue from the trace

A session on an earlier chat starts from the trace (`sessions.py`,
`restored_runs`): each of the chat's finished runs becomes the agent's memory
again (the task, each step with its code and observation, the answer; a notebook
import with the note that followed it; the user's own code as its step), the chat
shows the same history, and the runs' code runs once more in the new interpreter,
in the background, so the variables are back too. Code that failed runs again as
well, since what it assigned before the error stayed; code that lost the worker
(a timeout or a crash) does not, and nothing before it is replayed, since the
worker lost those variables the first time too. Nothing of that is traced as a
run; an `events` row of kind `restore` says how much came back. A reload, a new
tab, a new login or a switch back to the chat therefore continues it. Runs from
before chats existed became one chat per user, as every session then continued
from all of a user's runs.

With `--seed PATH`, every account is given a seed once (`seeding.py`): the
definition's `smolagents` section names a notebook and its data files, which are
copied into the new account's files and imported into a new chat right after
registration, traced as a `notebook` run under that user; the page opens on it.
Accounts made before the flag get it when they next open the page. The `seeds` table holds one row
per user (`status`, the import's `run_id`, timing, error); `GET /api/seed` reports
it and `POST /api/seed` asks for it again after a failure. The same definition
file seeds BobFlow's agent service (its `bobflow` section, `AGENT_SEED_FILE`), so
one file describes a study scenario for both systems:

```json
{"name": "scenario-2",
 "bobflow": {"workflowName": "…", "archive": "~/study/scenario-2/dataflow/archive.json", "model": "claude-haiku-5.5"},
 "smolagents": {"notebook": "~/study/scenario-2/notebook/analysis.ipynb",
                "files": ["~/study/scenario-2/data/listings.csv"]}}
```

`study/seeded_login.mjs BASE USER PASSWORD OUT` shows what a seeded participant
sees: the imported notebook on login, an answer to a question, and all of it
again after a reload.

## Isolation

- **Accounts.** Passwords are scrypt hashes; a login is a random token whose hash is stored with an expiry.
- **Records.** Every trace row carries its owner's id, and every read filters on it. Another user's run is a 404.
- **Agents.** Each tab has its own agent memory and its own interpreter process, so variables, figures and crashes stay with it.
- **Your own code** runs as plain Python only when a sandbox contains the worker. Without one (`--sandbox none`) it goes through smolagents' restricted interpreter, like the agent's code. Plain Python there would let any signed-in user run commands and read other users' files.
- **Files.** On macOS each worker runs under a `sandbox-exec` profile. The profile denies the whole data directory except the owner's folder, which shuts out other users' files and the trace database. It also denies the server's `.env` and outbound network. A worker's environment is built from scratch, so the gateway key never reaches model code.
- **Not covered.** On other platforms (`--sandbox none`) the workers are only separate processes and can read each other's files. A bubblewrap profile like `benchmark/retrieval/execution_isolation.py` would be the Linux counterpart. This is not hardened against a determined attacker: all workers run as one OS user, and there is no login rate limit. Keep it on localhost, or behind HTTPS with `--secure-cookies`.

## Tests

```bash
cd smolagents-service
../.venv/bin/python -m unittest discover -s tests -t .      # 33 tests, ~1.5 min, no LLM needed
```

They cover:
- accounts, logins and owner-scoped reads; runs from before chats becoming one chat per user
- the worker: state, figures, errors, timeouts, the user's own code (plain or restricted) sharing one namespace with the agent's like notebook cells, and the sandbox actually blocking reads (it fails when run without one)
- step-by-step trace timing against a scripted model, each part of a run shown once, a user's code joining the agent's context in the same process, and a chat restored with its variables (a failed run's too, none from before a lost worker)
- reading a notebook: IPython lines, and the files it reads
- over HTTP: the login wall, running code, importing a notebook dropped with its data (its cells run, join the agent's memory as its steps and are traced as one `notebook` run, and the agent carries on from them; one missing its data is refused, and a failing cell stops the import), new chats and switching between them (each with its own memory and variables; another user's chat refused), a closed tab ending its session, and 12 users chatting at once (about 4 s, against about 4 s for one run)
- moving files from the old `uploads/` and `workspace/` folders into `files/`

The user study's two scenarios run end to end against a live server from
`study/` (`scenario1_smolagents.mjs`: the three Olympic files, the two
questions of the task card and the facilitator's probe;
`scenario2_smolagents.mjs`: the Airbnb files, the notebook import, a question
and the fixing feedback), each printing what the agent answered and whether it
matches the study's answer key.

End to end against a running server and the real model:

```bash
node tests/e2e/concurrent_users.mjs http://127.0.0.1:7860 data.csv OUT_DIR 10     # Playwright from frontend/
node tests/e2e/script_flow.mjs http://127.0.0.1:7860 boston_demo.csv OUT_DIR
node tests/e2e/notebook_flow.mjs http://127.0.0.1:7860 OUT_DIR
node tests/e2e/chats_flow.mjs http://127.0.0.1:7860 OUT_DIR
../.venv/bin/python tests/e2e/check_traces.py ../logs/smolagents-service e2e_<stamp>_ 2
```

`script_flow.mjs`:
1. uploads the Boston demo CSV and a script that reads it by relative name
2. runs the script from the panel
3. asks the agent about the table the script built
4. checks the answer, that the agent used the script's variable instead of re-reading the file, and that both runs had one worker pid

`notebook_flow.mjs` uploads a notebook before its data (it must be refused), then
with it, and asks the agent to reuse the notebook's `top()` function, which reads
globals a later cell set, for another ranking. It checks the answer, that no
agent code hit a `NameError`, and that every run had one worker pid.

`chats_flow.mjs` registers (opening on the seeded chat when the server seeds),
starts a new chat, drops a notebook and its two data files in one drag, asks the
agent about the notebook's tables, starts a scratch chat, then goes back to each
chat. Each must show its own history and hold its own variables and no others,
and a reload must open the chat used last.

Each simulated person in `concurrent_users.mjs`:
1. registers and uploads the CSV
2. asks two questions, the second relying on the first
3. checks **My traces**: runs, steps, timeline and context
4. confirms that another person's run returns 404

The checker then verifies every timestamp nests (run ⊇ step ⊇ model call, then
execution), every record is owned by its run's user, and how many runs
overlapped. On 2026-10-21, with claude-sonnet-5.5 and the Boston demo CSV, all
ten passed in 26 s of wall time with ten runs in progress at once. Model calls
took about 95% of run time, code about 4%, the rest about 0.5%.
