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

interface CompletionStep {
  isEnd?: boolean;
  content?: string;
  toolResults?: Array<{ output: unknown }>;
}

/** A terminal error preserves evidence but cannot stand in for an Answer action. */
export function comparisonAnswer(steps: CompletionStep[], fallback?: string): { answer: string; completed: boolean } {
  const ended = [...steps].reverse().find(step => step.isEnd);
  let answered: string | undefined;
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const output = result.output as { kind?: string; answer?: unknown } | null;
      if (output?.kind === "dataflow-actions" && typeof output.answer === "string") answered = output.answer;
    }
  }
  return { answer: answered ?? ended?.content ?? fallback ?? "", completed: !!ended && answered !== undefined };
}
