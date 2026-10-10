/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
const stable = (value: any): string =>
  JSON.stringify(value, (_key, child) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(
          Object.keys(child)
            .sort()
            .map(key => [key, child[key]])
        )
      : child
  );

/** Screening only: never changes a solver's budget, context or actions. */
export class ActionMonitor {
  private events: Array<{ key: string; read: boolean; state: string }> = [];
  private seen = new Set<string>();
  private repeatedReads = 0;
  observe(receipt: { action: any; status: string; output?: unknown }, state: string): string[] {
    const { reasoning: _reasoning, ...action } = receipt.action;
    const key = stable({ action, status: receipt.status, output: receipt.output, state });
    const read = action.type === "inspect" || action.type === "retrieve";
    this.repeatedReads = read && this.seen.has(key) ? this.repeatedReads + 1 : 0;
    this.seen.add(key);
    this.events.push({ key, read, state });
    const keys = this.events.map(e => e.key);
    const n = keys.length;
    const alerts: string[] = [];
    if (n >= 3 && keys[n - 1] === keys[n - 2] && keys[n - 2] === keys[n - 3]) alerts.push("three_identical_actions");
    if (n >= 6 && [0, 1, 2, 3].every(i => keys[n - 6 + i] === keys[n - 4 + i])) alerts.push("two_action_cycle");
    if (this.repeatedReads >= 5) alerts.push("repeated_reads_without_new_evidence");
    if (receipt.status === "error" && action.type === "edit" && n >= 2 && key === keys[n - 2])
      alerts.push("repeated_rejected_edit");
    if (
      receipt.status === "error" &&
      action.type === "retrieve" &&
      /stale|use execute|no current result/i.test(String(receipt.output))
    )
      alerts.push("unavailable_result_read");
    return alerts;
  }
}

/** Counts matching messages/characters. These are not cached-token estimates. */
export function compareRequests(previous: any, current: any) {
  const changed_fields = [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter(
    key => key !== "messages" && stable(previous[key]) !== stable(current[key])
  );
  const a = previous.messages ?? [],
    b = current.messages ?? [];
  let unchanged_messages = 0;
  while (
    unchanged_messages < Math.min(a.length, b.length) &&
    stable(a[unchanged_messages]) === stable(b[unchanged_messages])
  )
    unchanged_messages++;
  let common_characters_in_changed_message = 0;
  if (unchanged_messages < Math.min(a.length, b.length)) {
    const old = stable(a[unchanged_messages]),
      next = stable(b[unchanged_messages]);
    while (
      common_characters_in_changed_message < Math.min(old.length, next.length) &&
      old[common_characters_in_changed_message] === next[common_characters_in_changed_message]
    )
      common_characters_in_changed_message++;
  }
  return {
    changed_fields,
    unchanged_messages,
    first_changed_message: unchanged_messages < a.length ? unchanged_messages : null,
    common_characters_in_changed_message,
  };
}
