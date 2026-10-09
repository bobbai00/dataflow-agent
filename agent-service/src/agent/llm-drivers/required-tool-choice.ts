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
/** Some gateways split commentary and a tool call into separate choices for
 * one completion. The SDK reads only choices[0]. When tools are required,
 * recover only a single unambiguous tool-bearing choice; never merge choices. */
export function requiredToolChoiceRecovery(request: any, response: any): number | undefined {
  if (request?.tool_choice !== "required" || request.stream || (request.n ?? 1) !== 1) return;
  const choices = response?.choices;
  if (!Array.isArray(choices) || choices.length < 2 || choices[0]?.message?.tool_calls?.length) return;
  const candidates = choices.flatMap((choice: any, index: number) =>
    Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length ? [index] : []
  );
  if (candidates.length !== 1) return;
  const index = candidates[0];
  const choice = choices[index];
  const names = new Set((request.tools ?? []).map((tool: any) => tool.function?.name));
  if (
    choice.finish_reason !== "tool_calls" ||
    choice.message.role !== "assistant" ||
    !choice.message.tool_calls.every(
      (call: any) =>
        call.type === "function" && names.has(call.function?.name) && typeof call.function?.arguments === "string"
    )
  )
    return;
  return index;
}

/** Put raw wire capture inside this wrapper so saved responses stay exact. */
export function withRequiredToolChoice(fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body =
      typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : undefined;
    let request: any;
    try {
      request = body ? JSON.parse(body) : undefined;
    } catch {}
    const response = await fetchImpl(input, init);
    if (!response.ok || request?.tool_choice !== "required" || request.stream) return response;
    let value: any;
    try {
      value = await response.clone().json();
    } catch {
      return response;
    }
    const index = requiredToolChoiceRecovery(request, value);
    if (index === undefined) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("x-texera-selected-choice", String(index));
    // Keep usage for the entire paid response, including the discarded prose.
    return Response.json({ ...value, choices: [value.choices[index]] }, { status: response.status, headers });
  }) as typeof fetch;
}
