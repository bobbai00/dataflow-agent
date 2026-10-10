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

export function buildLongDSPrompt(
  manifest: { files: string[] },
  turn: { turn_id: number; context: string; question: string },
  first: boolean
): string {
  const question = `[Task ${turn.turn_id}]\n${turn.context}\nQuestion: ${turn.question}`;
  if (!first) return question;
  const persistence =
    "Operators remain available across requests in one dataflow. Name them meaningfully. After editing definitions or edges, explicitly execute before retrieving current results. Retrieval never executes.";
  const answerContract =
    "Put a single-line JSON object in answer.content containing exactly the quantities requested. Follow the task's rounding and scale rules. Submit Answer as the sole action in its batch after observing the evidence.";
  return `You are an expert data scientist working through a long analysis with me. I will send you a series of requests, one at a time, about the same data.\n\nData files available (use these paths verbatim; never modify input files):\n${manifest.files.map(f => ` - ${f}`).join("\n")}\n\n${persistence}\nDo not use plotting libraries. Use text summaries and statistics. Use code for every calculation. Answer when you have evidence.\n\n${answerContract}\n\n${question}`;
}
