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

/**
 * DECORATE-stage taxonomy (see claude/CONTEXT-DESIGN.md §5).
 *
 * The assembled context is built as DECORATE(SELECT(session)). This module owns
 * the DECORATE vocabulary: the two orthogonal facets an operator node exposes,
 * and the cheap→rich LEVEL ladder within each facet.
 *
 *   - Facet "flow": annotate the typed DAG / lineage structure of the node.
 *   - Facet "data": annotate the structured-table payload the node produced.
 *
 * Each lever (a "rung") is registered at a (facet, level). A LEVEL is the
 * cumulative set of rungs up to and including that level: data_level=2 enables
 * the L1 + L2 data rungs. One ordinal knob per facet replaces the prior ~15
 * independent booleans.
 *
 * Mode of action (the §6 analytical lens; carried for figures/analysis, not
 * for gating): "preemptive" rungs surface a derived fact BEFORE the error and
 * tend to move accuracy; "posthoc" rungs alarm AFTER an anomaly appears and
 * have tended to be flat.
 *
 * NOTE: this module is the single source of truth for the level→rungs mapping.
 * It does NOT yet own the physical render bodies — those are migrated out of
 * context-utils.ts incrementally (see claude/CODE-PLAN.md). Until a rung's body
 * is migrated, its `flag` names the existing option the assembler still reads;
 * `levelsToFlags()` translates an ordinal level back to that flag set so the
 * existing render path is driven by the new ordinal config with zero behavior
 * change.
 */

export type DecorateFacet = "flow" | "data";
export type DecorateLevel = 0 | 1 | 2 | 3;
export type ActionMode = "preemptive" | "posthoc";

/**
 * A single decoration rung. For now this is a *descriptor* (the catalog entry):
 * which facet/level it sits at, its mode of action, and the legacy option flag
 * that currently drives its render. As render bodies are migrated, an optional
 * `render`/`applies` pair will be added here implementing the Decorator
 * contract from CODE-PLAN; the catalog shape is forward-compatible with that.
 */
export interface RungDescriptor {
  /** stable id, e.g. "data.structural_profile" */
  id: string;
  facet: DecorateFacet;
  level: Exclude<DecorateLevel, 0>;
  mode: ActionMode;
  /** the AssembleContextOptions / FormatOperatorResultOptions boolean this rung
   *  currently maps to (the migration shim reads this). */
  flag: string;
  /** one-line human description for docs/figures. */
  note: string;
}
