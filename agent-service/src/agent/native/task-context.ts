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
import type { ContextAssembler, ContextAssemblerInput } from "../llm-drivers/types";
import type { OperatorPredicate } from "../../types/workflow";
import type { TaskHistory } from "./task-history";
import { writtenInputs } from "./task-reference";
import { renderIndexTaskEntry, renderLiveIndex, renderStubTaskEntry, renderTaskEntry } from "./task-entries";
import type { TaskEntry } from "./task-entries";
import { analysisMemory } from "./analysis-memory";
import type { DefinitionRegistry } from "./definition-registry";

/** The heading of the catalog message. The catalog is the state a task starts
 * from, rendered once per task; what the task changes appears in its own
 * observations. */
export const TASK_CATALOG_HEADING = "# Operator catalog at the start of this task";

/** The operator as the model wrote it, on one line: its own program statement
 * (`name = op(...)`), which the model already reads fluently and which changes
 * only when the operator is redefined. A catalog line built from it is stable
 * across calls, which is what lets a prompt cache reuse it. */
export function operatorSignature(op: OperatorPredicate): string {
  const view = op.nativeOp;
  if (!view) return `${op.operatorID} = ${op.operatorType}`;
  // Without a written statement, name inputs as the model would write them.
  const statement = (view.source ?? `${op.operatorID} = ${view.type}(${writtenInputs(view).join(", ")})`)
    .replace(/\s+/g, " ")
    .trim();
  return statement.length <= 240 ? statement : statement.slice(0, 237) + "...";
}

/** Completed questions and answers preserve inherited requirements. The
 * catalog replaces completed action traces, not the active task's ReAct.
 * Complete definitions and observed evidence use the shared context assembler. */
export function taskCatalogMemory(input: ContextAssemblerInput, history?: TaskHistory): ModelMessage[] {
  const parts = taskCatalogParts(input, history);
  return [...parts.completed, parts.catalog];
}

/** The completed question/answer pairs and the operator catalog, kept apart
 * because they live differently in the prompt: the pairs only grow, the
 * catalog is rendered from the current graph and frozen for a whole task. */
export function taskCatalogParts(
  input: ContextAssemblerInput,
  history?: TaskHistory
): { completed: ModelMessage[]; catalog: ModelMessage } {
  const tasks = input.visibleSteps.filter(step => step.role === "user" && step.isBegin);
  const number = (messageId: string) =>
    input.turnNumberByMessageId?.get(messageId) ?? tasks.findIndex(step => step.messageId === messageId) + 1;
  const messages: ModelMessage[] = [];
  for (const task of tasks.slice(0, -1)) {
    messages.push({ role: "user", content: `# Task ${number(task.messageId)}\n${task.content}` });
    const answer = input.visibleSteps.findLast(s => s.messageId === task.messageId && s.role === "agent" && s.isEnd);
    if (answer?.content) messages.push({ role: "assistant", content: answer.content });
  }
  const head = input.visibleSteps.at(-1)?.id;
  const provenance = history?.provenance() ?? new Map();
  const catalog = input.workflowState
    .getAllOperators()
    .filter(op => !op.taskSource)
    .map(op => {
      const info = input.snapshotStorage.getOperatorResult(head, op.operatorID);
      const schema = info?.resultSchema?.map(f => `${f.name}:${f.type}`).join(",") ?? "unknown";
      const status = info?.error ? "current result unavailable" : (info?.state ?? "not executed");
      const event = provenance.get(op.operatorID);
      const saved = event
        ? `; created@${event.created}${event.edited.length ? ` edited@${event.edited.join(",")}` : ""}${
            event.gaps.length ? ` not saved@${event.gaps.join(",")}` : ""
          }`
        : "";
      return `${operatorSignature(op)}; schema=${schema}; ${status}${info?.totalRowCount !== undefined ? `; rows=${info.totalRowCount}` : ""}${saved}`;
    });
  // An operator that has left the graph keeps its retained outputs, so it stays
  // referenceable by task. Its line is final once it is gone.
  for (const [id, event] of provenance) {
    if (input.workflowState.getOperator(id)) continue;
    catalog.push(
      `${id} = no longer in the graph; created@${event.created}${
        event.edited.length ? ` edited@${event.edited.join(",")}` : ""
      }${event.gaps.length ? ` not saved@${event.gaps.join(",")}` : ""}; last saved@${event.lastSaved}`
    );
  }
  return {
    completed: messages,
    catalog: { role: "user", content: `${TASK_CATALOG_HEADING}\n${catalog.join("\n") || "Empty."}` },
  };
}

/** Characters per token of the budget's estimate, measured on LongDS model
 * inputs (3.0-3.8 for history of code, JSON and tables). */
export const BUDGET_CHARS_PER_TOKEN = 3.3;
/** Tokens of a call beyond its messages and system prompt: the tool schemas. */
export const TOOL_SCHEMA_TOKENS = 2500;
/** Share of the budget kept for the active task's own calls and observations. */
export const ACTIVE_SHARE = 0.3;
/** Share of the budget the definitions index may take. */
export const INDEX_SHARE = 0.2;

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / BUDGET_CHARS_PER_TOKEN);
}

/** Completed tasks within `allowance` tokens, in task order: every task starts
 * as one line, then the newest are widened to shortened entries and then to
 * their full entries while the allowance lasts; when even one line each does
 * not fit, the oldest are archived behind `recall` (one line names them). The
 * first task keeps its whole request whenever it is shown, since it states the
 * session's rules. */
export function budgetedEntryTexts(entries: TaskEntry[], full: string[], allowance: number): string[] {
  const tiers = entries.map((entry, i) => [
    i === 0 ? renderIndexTaskEntry(entry, true) : renderStubTaskEntry(entry),
    i === 0 ? renderIndexTaskEntry(entry, true) : renderIndexTaskEntry(entry),
    full[i],
  ]);
  const level = entries.map(() => 0);
  const shown = entries.map(() => true);
  const cost = (i: number) => (shown[i] ? estimateTokens(tiers[i][level[i]]) : 0);
  let used = entries.reduce((sum, _, i) => sum + cost(i), 0);
  // One line each does not fit: archive from the oldest, keeping the first task.
  for (let i = 1; i < entries.length && used > allowance; i++) {
    used -= cost(i);
    shown[i] = false;
  }
  for (const target of [1, 2])
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!shown[i] || level[i] >= target) continue;
      const extra = estimateTokens(tiers[i][target]) - estimateTokens(tiers[i][level[i]]);
      if (used + extra > allowance) continue;
      level[i] = target;
      used += extra;
    }
  const texts = entries.map((_, i) => (shown[i] ? tiers[i][level[i]] : undefined));
  const archived = entries.filter((_, i) => !shown[i]).map(entry => entry.task);
  const out = texts.filter((text): text is string => text !== undefined);
  if (archived.length)
    out.splice(
      1,
      0,
      `## Tasks ${archived.join(", ")}: archived for the context budget; recall a task number for its request, changes and answer.`
    );
  return out;
}

/** The active task's messages within what the budget leaves: the oldest tool
 * observations, all but the last two, are replaced by a note until the total
 * fits. The calls themselves stay, so the model sees what it ran. */
export function trimActiveMessages(messages: ModelMessage[], room: number): ModelMessage[] {
  let total = estimateTokens(messages);
  if (total <= room) return messages;
  const out = messages.map(message => ({ ...message }));
  const tools = out.map((message, i) => (message.role === "tool" ? i : -1)).filter(i => i >= 0);
  for (const i of tools.slice(0, -2)) {
    if (total <= room) break;
    const before = estimateTokens(out[i]);
    const content = Array.isArray(out[i].content) ? (out[i].content as any[]) : [];
    out[i] = {
      ...out[i],
      content: content.map(part =>
        part?.type === "tool-result"
          ? {
              ...part,
              output: {
                type: "text",
                value: "(observation omitted to fit the context budget; observe the table again if you need it)",
              },
            }
          : part
      ),
    } as ModelMessage;
    total -= before - estimateTokens(out[i]);
  }
  return out;
}

/** Compose task memory with the configured synchronous or async assembler.
 * There is one driver, one prompt, one execution path and one observation
 * renderer. Switching context changes only what completed work is replayed.
 *
 * With task history, completed tasks are their entries: written once at the
 * task boundary and never changed, so the prompt of call N+1 is the prompt of
 * call N plus new messages, the one shape a provider's prompt cache credits.
 * Each entry message is flagged for the transport, which places its cache
 * boundaries on the last two. The live index after them is rendered once per
 * task, and what the task changes reaches the model through its own
 * observations. Without history, completed tasks collapse to their
 * request/answer pairs and the frozen catalog. */
export function withTaskCatalog(
  assemble: ContextAssembler,
  history?: TaskHistory,
  registry?: DefinitionRegistry
): ContextAssembler {
  let frozen: { messageId: string; message: ModelMessage } | undefined;
  let analysisFrozen: { messageId: string; memory: ModelMessage[] } | undefined;
  // With a context budget: the entries as fitted at the start of the task,
  // kept for the whole task so its calls share a prompt prefix.
  let budgeted: { messageId: string; texts: string[]; index: ModelMessage } | undefined;
  // The budget is on the provider's count: each call's estimate is kept under
  // the step it answered, and the provider's input count for the latest call
  // over that estimate converts the budget into the estimate's units.
  const sent = new Map<string, number>();
  let scale = 1;
  return input => {
    if (!input.settings.nativeTaskContext) return assemble(input);
    const current = input.visibleSteps.findLast(step => step.role === "user" && step.isBegin);
    if (!current) return assemble(input);
    const budget = input.settings.nativeContextBudgetTokens;
    if (budget) {
      const last = input.visibleSteps.findLast(step => step.role === "agent" && step.usage?.inputTokens);
      const estimate = last?.parentId ? sent.get(last.parentId) : undefined;
      if (last?.usage?.inputTokens && estimate) scale = Math.min(1.5, Math.max(0.5, last.usage.inputTokens / estimate));
    }
    const units = budget ? Math.floor(budget / scale) : 0;
    const entries = input.settings.nativeTaskHistory && history ? history.entries() : undefined;
    let memory: ModelMessage[];
    if (entries && input.settings.nativeAnalysisState && !input.settings.nativeTaskEfficiency) {
      if (analysisFrozen?.messageId !== current.messageId) {
        const head = input.visibleSteps.at(-1)?.id;
        const provenance = history?.provenance();
        const cards = input.workflowState
          .getAllOperators()
          .filter(op => !op.taskSource)
          .map(op => {
            const info = input.snapshotStorage.getOperatorResult(head, op.operatorID);
            const event = provenance?.get(op.operatorID);
            const view = op.nativeOp;
            const functions = Object.keys(view?.functions ?? {});
            const cols = info?.resultSchema?.map(c => c.name) ?? [];
            return (
              `${operatorSignature(op)}; ${info?.error ? "FAILED" : (info?.state ?? "not executed")}` +
              `; rows=${info?.totalRowCount ?? "?"}; cols=${cols.slice(0, 16).join(",")}${cols.length > 16 ? ` (+${cols.length - 16})` : ""}` +
              (functions.length ? `; functions=${functions.join(",")}` : "") +
              (view?.analysisBranch ? `; branch=${view.analysisBranch.root}` : "") +
              (event ? `; created@${event.created} changed@${event.edited.join(",") || event.created}` : "")
            );
          });
        const definitions = new Map<string, { text: string; priority: number }>();
        const latestTask = entries.at(-1)?.task ?? 0;
        for (const op of input.workflowState.getAllOperators()) {
          if (op.taskSource) continue;
          const event = provenance?.get(op.operatorID);
          const changed = Math.max(event?.created ?? 0, ...(event?.edited ?? []));
          const branch = op.nativeOp?.analysisBranch?.root;
          for (const [name, source] of Object.entries(op.nativeOp?.functions ?? {})) {
            const scope = branch ? `Independent branch ${branch}` : "Shared";
            const key = `${scope}\0${name}\0${source}`;
            const priority = Math.max(definitions.get(key)?.priority ?? 0, changed >= latestTask - 2 ? 15 : 0);
            definitions.set(key, { text: `${scope} function ${name}:\n${source}`, priority });
          }
        }
        analysisFrozen = {
          messageId: current.messageId,
          memory: analysisMemory(entries, cards, current.content, input.settings.nativeTaskMemoryChars ?? 24000, [
            ...definitions.values(),
          ]),
        };
      }
      memory = analysisFrozen.memory;
    } else if (entries) {
      const head = input.visibleSteps.at(-1)?.id;
      if (frozen?.messageId !== current.messageId) {
        const results = new Map(
          input.workflowState
            .getAllOperators()
            .map(op => [op.operatorID, input.snapshotStorage.getOperatorResult(head, op.operatorID)] as const)
            .filter((pair): pair is readonly [string, NonNullable<(typeof pair)[1]>] => pair[1] !== undefined)
        );
        // With the definition registry, the task starts from the graph read as
        // versioned definitions, not from a list of operators.
        const useRegistry = input.settings.nativeDefinitionRegistry === true && !!registry;
        frozen = {
          messageId: current.messageId,
          message: {
            role: "user",
            content: useRegistry
              ? registry!.render(input.workflowState, results, history)
              : renderLiveIndex(input.workflowState, results, history, registry ?? undefined),
          },
        };
      }
      const signatures =
        input.settings.nativeDefinitionRegistry === true &&
        input.settings.nativeDefinitionSignatures === true &&
        !!registry;
      const full = entries.map(entry => renderTaskEntry(entry, input.settings.nativeTaskEfficiency, { signatures }));
      if (budget) {
        if (budgeted?.messageId !== current.messageId) {
          const fixed = estimateTokens(input.settings.systemPrompt ?? "") + TOOL_SCHEMA_TOKENS;
          const indexText = String(frozen.message.content);
          const indexLimit = Math.floor(units * INDEX_SHARE * BUDGET_CHARS_PER_TOKEN);
          const index: ModelMessage = {
            role: "user",
            content:
              indexText.length <= indexLimit
                ? indexText
                : `${indexText.slice(0, indexLimit)}\n… (index shortened for the context budget; inspect a name for its definition)`,
          };
          const allowance = units - fixed - estimateTokens(index.content) - Math.floor(units * ACTIVE_SHARE);
          budgeted = { messageId: current.messageId, texts: budgetedEntryTexts(entries, full, Math.max(0, allowance)), index };
        }
        memory = [
          ...budgeted.texts.map(
            (content): ModelMessage => ({ role: "user", content, providerOptions: { texera: { taskHistory: true } } })
          ),
          budgeted.index,
        ];
      } else
        memory = [
          ...full.map(
            (content): ModelMessage => ({
              role: "user",
              content,
              providerOptions: { texera: { taskHistory: true } },
            })
          ),
          frozen.message,
        ];
    } else {
      const parts = taskCatalogParts(input, undefined);
      if (frozen?.messageId !== current.messageId) frozen = { messageId: current.messageId, message: parts.catalog };
      memory = [...parts.completed, frozen.message];
    }
    const active = assemble({
      ...input,
      visibleSteps: input.visibleSteps.filter(step => step.messageId === current.messageId),
      offBranchTurns: [],
    });
    const fixed = estimateTokens(input.settings.systemPrompt ?? "") + TOOL_SCHEMA_TOKENS;
    const room = budget ? units - fixed - estimateTokens(memory) : Infinity;
    const order = (messages: ModelMessage[]) => {
      if (!budget) return [...memory, ...messages];
      const call = [...memory, ...trimActiveMessages(messages, room)];
      const head = input.visibleSteps.at(-1)?.id;
      if (head) sent.set(head, fixed + estimateTokens(call));
      return call;
    };
    return active instanceof Promise ? active.then(order) : order(active);
  };
}
