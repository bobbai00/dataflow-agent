/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { TokenUsage } from "../../types/agent";
import { MissingAnswerActionError, type LLMDriver } from "./types";

export const TOKEN_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheCreationInputTokens",
  "reasoningTokens",
] as const;
export function sumTokenUsage(values: readonly TokenUsage[]): TokenUsage {
  return Object.fromEntries(
    TOKEN_USAGE_KEYS.map(key => {
      const known = values.flatMap(usage => (typeof usage[key] === "number" ? [usage[key]!] : []));
      return [key, known.length ? known.reduce((total, value) => total + value, 0) : values.length ? undefined : 0];
    })
  );
}

/** Completed callbacks survive driver failure. A successful segment's total
 * replaces its callbacks, so SDK totals and step events never charge twice. */
export class TurnUsageAccounting {
  private readonly segments: TokenUsage[] = [];
  beginSegment() {
    const index = this.segments.push({}) - 1;
    return {
      record: (usage?: TokenUsage) => {
        if (usage) this.segments[index] = sumTokenUsage([this.segments[index], usage]);
      },
      complete: (usage: TokenUsage) => {
        // Custom drivers may omit token classes from their aggregate. Preserve
        // known step counts for those classes instead of replacing them with 0.
        for (const key of TOKEN_USAGE_KEYS) {
          if (typeof usage[key] === "number") this.segments[index][key] = usage[key];
        }
      },
    };
  }
  get usage(): TokenUsage {
    return sumTokenUsage(this.segments);
  }
}

/** Keep lifecycle bookkeeping out of the agent's prompt/context callback. */
export function withTurnUsageAccounting(driver: LLMDriver, accounting: TurnUsageAccounting): LLMDriver {
  return {
    runTurn: async input => {
      const segment = accounting.beginSegment();
      try {
        const result = await driver.runTurn({
          ...input,
          onStepFinish: async step => {
            segment.record(step.usage);
            await input.onStepFinish(step);
          },
        });
        segment.complete(result.usage);
        return result;
      } catch (error) {
        if (error instanceof MissingAnswerActionError) segment.complete(error.partial.usage);
        throw error;
      }
    },
  };
}
