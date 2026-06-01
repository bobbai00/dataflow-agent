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

import type { OperatorDecorator, OperatorDecorateCtx } from "../decorator";

/**
 * Flow-L3 (post-hoc). A `DataLoading` operator whose output reaches NO
 * downstream operator (a dead/forgotten load — pure typed-DAG reachability)
 * gets a `Graph check ⚠` line telling the agent to wire it in or drop it.
 * Current snapshot only; conservative — only when the DAG has other operators
 * (so it doesn't fire on the trivial single-load start state). Uniquely
 * enabled by the dataflow graph: a free-form script has no graph to audit.
 */
export const graphAudit: OperatorDecorator = {
  id: "flow.graph_audit",
  facet: "flow",
  level: 3,
  mode: "posthoc",
  placement: "post-block",
  applies(ctx: OperatorDecorateCtx): boolean {
    if (!ctx.isCurrent || ctx.op.operatorType !== "DataLoading") return false;
    const totalOps = ctx.snapshot.workflow.operators.length;
    if (totalOps <= 1) return false;
    const sinks = ctx.workflowState.getDownstreamSinks(ctx.op.operatorID);
    const feedsNothing = sinks.length === 0 || (sinks.length === 1 && sinks[0] === ctx.op.operatorID);
    return feedsNothing;
  },
  render(): string[] {
    return [
      "Graph check ⚠: this loaded data is not consumed by any downstream operator — " +
        "wire it into the pipeline that produces the answer, or it contributes nothing to the result.",
    ];
  },
};
