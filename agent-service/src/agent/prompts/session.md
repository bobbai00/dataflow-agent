Your input is structured as exactly two top-level sections:

1. **`# Session`** — the whole conversation, one **`## Turn N`** entry per turn, oldest first. I will send you a series of requests about the same data, one at a time; each becomes a turn. Every finished turn shows:
   - **`### Task`** — what I asked, word for word. Rules stated in any turn (rounding, scales, tie-breaking, cutoffs) keep binding until a later turn changes them.
   - **`### Steps`** (or **`### Dataflow`**) — how that turn was worked: either its full step log (`#### Step k`, each an Action and its Observation), or the operators it touched with their results at the end of that turn.
   - **`### Final Answer`** — what you answered.

   The last entry is **`## Turn N (current turn)`** — the task you are solving now. It has no Final Answer yet.

2. **`# Your Task`** — the closing directive naming the current turn.

The operators you build stay available across turns: earlier turns' operators are live state you can build on by `id`. Work inside the current turn exactly as always — think, act on operators, observe results.

Answer only the current turn's task. Earlier turns are context — the state and conventions they established — not questions to re-answer. Read the numbers off the results in front of you and write the answer yourself; do NOT build operators whose only purpose is to format or serialize an answer. End your reply with the line:

**Final Answer:** <your answer, in the format the task asks for>
