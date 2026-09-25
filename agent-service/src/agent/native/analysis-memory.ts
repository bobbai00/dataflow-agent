/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import type { ModelMessage } from "ai";
import type { TaskEntry } from "./task-entries";

const INTRO =
  "# Analysis memory\nCompleted requests below are exact selected requests, not every prior result. Tables persist independently. Use dataflow inspect for exact current table or function definitions, observe for current values, and recall for archived requests, answers and change summaries. Do not infer a missing definition or past number.";
const words = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter(
      word =>
        !["the", "and", "for", "with", "this", "that", "from", "which", "what", "current", "report"].includes(word)
    )
  );

/** Bound even the archive index: a long session must not spend its whole memory
 * budget enumerating omitted task numbers. Requests themselves are never cut. */
function taskRanges(numbers: number[]): string {
  const ranges: string[] = [];
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    const range = start === sorted[i] ? String(start) : `${start}-${sorted[i]}`;
    if (ranges.join(", ").length + range.length > 950)
      return ranges.join(", ") + `; more omitted (latest archived task ${sorted.at(-1)})`;
    ranges.push(range);
  }
  return ranges.join(", ");
}

/** No LLM summary and no future metadata. Bound the total historical payload,
 * retain whole requests (never an unmarked truncated rule), and expose every
 * omitted task number for exact retrieval. State cards are selected separately
 * from requests so a large graph cannot evict the opening conventions. */
export function analysisMemory(
  entries: TaskEntry[],
  cards: string[],
  query: string,
  maxChars: number,
  definitions: Array<{ text: string; priority: number }> = []
): ModelMessage[] {
  const budget = Math.max(4000, maxChars);
  const tokens = words(query);
  const score = (text: string) => [...words(text)].reduce((n, word) => n + Number(tokens.has(word)), 0);
  const rankedCards = cards
    .map((text, i) => ({ text, i, score: score(text) + (/FAILED|ERROR/.test(text) ? 100 : 0) }))
    .sort((a, b) => b.score - a.score || b.i - a.i);
  let cardBudget = Math.min(8000, Math.floor(budget / 3));
  const selectedCards: string[] = [];
  for (const card of rankedCards) {
    if (card.text.length + 1 > cardBudget) continue;
    selectedCards.push(card.text);
    cardBudget -= card.text.length + 1;
  }
  const index =
    `# Current analysis tables\n${selectedCards.join("\n") || "No tables selected."}\n` +
    (cards.length > selectedCards.length
      ? `${cards.length - selectedCards.length} table cards omitted; inspect known names or recall the task that created them.\n`
      : "");
  const archivedReserve = 1200;
  const requestText = (entry: TaskEntry) => `# Completed task ${entry.task}: request\n${entry.request}\n`;
  const keyRequests = [...new Set([entries[0], ...entries.slice(-2)])].filter(Boolean);
  const requestReserve = Math.min(
    Math.floor(budget / 2),
    keyRequests.reduce((n, e) => n + requestText(e).length, 0)
  );
  const definitionHeading =
    "# Selected exact definitions at task start\nReuse these functions by name; inspect omitted definitions when needed.\n";
  let definitionBudget = Math.min(
    Math.floor(budget / 2),
    Math.max(0, budget - INTRO.length - index.length - archivedReserve - requestReserve - definitionHeading.length)
  );
  const selectedDefinitions: string[] = [];
  for (const definition of [...definitions].sort((a, b) => score(b.text) + b.priority - (score(a.text) + a.priority))) {
    if (definition.text.length + 2 > definitionBudget) continue;
    selectedDefinitions.push(definition.text);
    definitionBudget -= definition.text.length + 2;
  }
  const code = selectedDefinitions.length ? definitionHeading + selectedDefinitions.join("\n\n") + "\n" : "";
  let remaining = budget - INTRO.length - index.length - code.length - archivedReserve;
  const priorities = entries
    .map((entry, i) => ({
      entry,
      i,
      score: score(entry.request) + (i === 0 ? 100000 : i >= entries.length - 2 ? 10000 + i : 0),
    }))
    .sort((a, b) => b.score - a.score || b.i - a.i);
  const selected = new Map<number, string>();
  for (const { entry } of priorities) {
    const text = requestText(entry);
    if (text.length > remaining) continue;
    selected.set(entry.task, text);
    remaining -= text.length;
  }
  const archived = entries.filter(entry => !selected.has(entry.task)).map(entry => entry.task);
  const memory: ModelMessage[] = [{ role: "user", content: INTRO }];
  for (const entry of entries) {
    const content = selected.get(entry.task);
    if (content) memory.push({ role: "user", content, providerOptions: { texera: { taskHistory: true } } });
  }
  memory.push({
    role: "user",
    content:
      index +
      code +
      (archived.length
        ? `Archived requests: ${taskRanges(archived)}. Retrieve relevant omitted requirements with dataflow(recall=[task_number]).`
        : "All completed requests are included; archived change summaries, observations and answers remain available through recall."),
  });
  return memory;
}
