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

/** Rule-based context selector — public surface. */
export {
  selectParams,
  buildOverride,
  SelectorConfigSchema,
  DEFAULT_SELECTOR_CONFIG,
  parseSelectorConfig,
} from "./selector";
export type { SelectorConfig } from "./selector";
export { extractFeatures } from "./features";
export type { OperatorFeatures, TrajectoryFeatures, SelectorFeatures, OperatorRole } from "./features";
export { FrontierDecayConfigSchema, applyFrontierDecay, parseFrontierDecayConfig } from "./frontier-decay";
export type { FrontierDecayConfig } from "./frontier-decay";
export { ProbeRetirementConfigSchema, applyProbeRetirement, parseProbeRetirementConfig } from "./probe-retirement";
export type { ProbeRetirementConfig } from "./probe-retirement";
export { RolePolicyConfigSchema, applyRolePolicy, parseRolePolicyConfig } from "./role-policy";
export type { RolePolicyConfig } from "./role-policy";
