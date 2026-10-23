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

import dagre from "dagre";
import type { WorkflowState } from "../workflow-state";

// Values mirror frontend joint-graph-wrapper.ts (`autoLayoutJoint`) so
// agent-generated and user-generated layouts visually match.
//
// A box is 210×80 with its id label and row counts stacked above it (up to
// ~30px) and its status pill below (~20px): `nodesep` keeps neighbouring rows
// clear of each other's labels and no more, and `ranksep` leaves just enough
// room between ranks for the curved edges to bend. Network simplex balances
// side branches around the main path instead of stacking them.
const LAYOUT_CONFIG: dagre.GraphLabel = {
  nodesep: 56,
  edgesep: 20,
  ranksep: 80,
  ranker: "network-simplex",
  rankdir: "LR",
};

const NODE_WIDTH = 210;
const NODE_HEIGHT = 80;

export function autoLayoutWorkflow(workflowState: WorkflowState): void {
  const operators = workflowState.getAllOperators();
  const links = workflowState.getAllLinks();

  if (operators.length === 0) {
    return;
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph(LAYOUT_CONFIG);
  graph.setDefaultEdgeLabel(() => ({}));
  // Dagre uses object-keyed dictionaries internally. Keep user-authored IDs
  // such as __proto__ out of those dictionaries without restricting the graph.
  const layoutIds = new Map(operators.map((operator, index) => [operator.operatorID, `node_${index}`]));

  for (const operator of operators) {
    graph.setNode(layoutIds.get(operator.operatorID)!, {
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  }

  for (const link of links) {
    const source = layoutIds.get(link.source.operatorID);
    const target = layoutIds.get(link.target.operatorID);
    if (source !== undefined && target !== undefined) graph.setEdge(source, target);
  }

  dagre.layout(graph);

  for (const operator of operators) {
    const node = graph.node(layoutIds.get(operator.operatorID)!);
    if (node) {
      workflowState.updateOperatorPosition(operator.operatorID, {
        x: node.x,
        y: node.y,
      });
    }
  }
}
