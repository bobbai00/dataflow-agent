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
import type { OperatorLink, OperatorPredicate, Point, WorkflowContent } from "../../types/workflow";

// Values mirror frontend joint-graph-wrapper.ts (`autoLayoutJoint`) so
// agent-generated and user-generated layouts visually match.
//
// A box is 240×96 with its id label above it (~30px; a selected operator adds
// the row counts by its ports) and its status pill below (~20px): `nodesep`
// keeps neighbouring rows clear of each other's labels and no more. `ranksep`
// gives every link a long run between ranks, so its curve and arrowhead read
// at a glance, also where several links enter a join. Network simplex
// balances side branches around the main path instead of stacking them.
const LAYOUT_CONFIG: dagre.GraphLabel = {
  nodesep: 56,
  edgesep: 20,
  ranksep: 150,
  ranker: "network-simplex",
  rankdir: "LR",
};

const NODE_WIDTH = 240;
const NODE_HEIGHT = 96;

/** Where the layout puts each operator (dagre's node centre), by operator id. */
export function layoutPositions(
  operators: readonly OperatorPredicate[],
  links: readonly OperatorLink[]
): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (operators.length === 0) return positions;

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
    if (node) positions.set(operator.operatorID, { x: node.x, y: node.y });
  }
  return positions;
}

export function autoLayoutWorkflow(workflowState: WorkflowState): void {
  const positions = layoutPositions(workflowState.getAllOperators(), workflowState.getAllLinks());
  for (const [operatorId, position] of positions) workflowState.updateOperatorPosition(operatorId, position);
}

/**
 * The workflow laid out as the agent lays out a dataflow now. The agent lays
 * out its whole dataflow after every edit, so where its operators sit follows
 * from the operators and links alone: a version stored under an earlier
 * layout (an archive, a trace) comes back looking like one made today.
 */
export function withCurrentLayout(content: WorkflowContent): WorkflowContent {
  if (!Array.isArray(content?.operators) || content.operators.length === 0) return content;
  const positions = layoutPositions(content.operators, Array.isArray(content.links) ? content.links : []);
  return { ...content, operatorPositions: Object.fromEntries(positions) };
}
