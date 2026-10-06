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

import { createHash } from "node:crypto";
import type { OperatorInfo, ResultVersion } from "../../types/execution";
import type { LogicalPlan, WorkflowContent } from "../../types/workflow";
import { mergeTableProfiles, type TableProfile } from "./profiles";

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map(key => [key, item[key]])
        )
      : item
  );
}
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export const producingExecution = (info: Pick<OperatorInfo, "materialization"> | undefined): string | null => {
  const id = info?.materialization?.executionId;
  return typeof id === "string" && /^\d{1,20}$/.test(id) ? id : null;
};

/** Match the submitted engine shape, not layout, display names or observe sets.
 * An unknown port remains -1 here: never turn a malformed link into port zero. */
export function workflowExecutionPlan(workflow: WorkflowContent): LogicalPlan {
  const ops = new Map(workflow.operators.filter(o => !o.isDisabled).map(o => [o.operatorID, o]));
  return {
    operators: [...ops.values()].map(op => ({
      ...op.operatorProperties,
      operatorID: op.operatorID,
      operatorType: op.operatorType,
      inputPorts: op.inputPorts,
      outputPorts: op.outputPorts,
    })),
    links: workflow.links.map(link => ({
      fromOpId: link.source.operatorID,
      fromPortId: {
        id: ops.get(link.source.operatorID)?.outputPorts.findIndex(p => p.portID === link.source.portID) ?? -1,
        internal: false,
      },
      toOpId: link.target.operatorID,
      toPortId: {
        id: ops.get(link.target.operatorID)?.inputPorts.findIndex(p => p.portID === link.target.portID) ?? -1,
        internal: false,
      },
    })),
  };
}

/** Request-side proof includes generated code and the entire incoming sub-DAG.
 * A backend cache key is opaque and is not a substitute for this comparison. */
export function executionFingerprints(
  plan: LogicalPlan
): Map<string, { definitionHash: string; subgraphHash: string }> {
  const ops = new Map(plan.operators.map(op => [op.operatorID, op]));
  const result = new Map<string, { definitionHash: string; subgraphHash: string }>();
  if (ops.size !== plan.operators.length) return result;
  const visiting = new Set<string>();
  function visit(id: string): string | undefined {
    if (result.has(id)) return result.get(id)!.subgraphHash;
    const op = ops.get(id);
    if (!op || visiting.has(id)) return undefined;
    visiting.add(id);
    const links = plan.links
      .filter(link => link.toOpId === id)
      .sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
    const inputs = links.map(link => ({ link, hash: visit(link.fromOpId) }));
    visiting.delete(id);
    if (inputs.some(({ link, hash }) => !hash || link.fromPortId.id < 0 || link.toPortId.id < 0)) return undefined;
    const definitionHash = digest(op);
    const subgraphHash = digest({ definitionHash, inputs });
    result.set(id, { definitionHash, subgraphHash });
    return subgraphHash;
  }
  for (const id of ops.keys()) visit(id);
  return result;
}

const workflowProofs = new WeakMap<
  WorkflowContent,
  { plan: LogicalPlan; fingerprints: ReturnType<typeof executionFingerprints> }
>();
function workflowProof(workflow: WorkflowContent) {
  const cached = workflowProofs.get(workflow);
  if (cached) return cached;
  const plan = workflowExecutionPlan(workflow);
  const proof = { plan, fingerprints: executionFingerprints(plan) };
  // Snapshot V2 workflows are deeply frozen. Do not memoize caller-owned mutable
  // workflows, or rehash the generated runtime for every result in a large batch.
  if (Object.isFrozen(workflow)) workflowProofs.set(workflow, proof);
  return proof;
}

/** Share the immutable snapshot proof across history, fork and catalog reads.
 * Mutable drafts deliberately bypass the memo so edits cannot leave stale hashes. */
export function workflowFingerprints(
  workflow: WorkflowContent
): ReadonlyMap<string, { definitionHash: string; subgraphHash: string }> {
  return workflowProof(workflow).fingerprints;
}

function sourceFingerprints(profile: TableProfile | undefined): ResultVersion["sourceFingerprints"] {
  const scan = profile?.native?.operations?.scan as { sources?: unknown } | undefined;
  if (!scan || !Array.isArray(scan.sources) || scan.sources.length > 256) return null;
  const sources: NonNullable<ResultVersion["sourceFingerprints"]> = [];
  for (const source of scan.sources) {
    if (
      !source ||
      typeof source.path !== "string" ||
      source.path.length > 4096 ||
      !Number.isSafeInteger(source.sizeBytes) ||
      source.sizeBytes < 0 ||
      typeof source.mtimeNs !== "string" ||
      !/^-?\d{1,30}$/.test(source.mtimeNs)
    )
      return null;
    sources.push({ path: source.path, sizeBytes: source.sizeBytes, mtimeNs: source.mtimeNs });
  }
  return sources;
}

/** The caller has already cloned the response. Return undefined for a provably
 * stale/wrong request. Missing optional evidence instead leaves valid data intact.
 * All input bindings use the materializations returned by that SAME request. */
export function bindResultVersion(
  workflow: WorkflowContent,
  operatorId: string,
  info: OperatorInfo,
  current: ReadonlyMap<string, OperatorInfo>,
  expectedWorkflowId?: number,
  historicalResults: () => Iterable<OperatorInfo> = () => []
): OperatorInfo | undefined {
  delete info.resultVersion;
  delete info.tableProfile;
  const op = workflow.operators.find(o => o.operatorID === operatorId);
  const native = op?.nativeOp;
  if (!native) return info;
  const context = info.executionContext;
  const previous = current.get(operatorId);
  const proof = workflowProof(workflow);
  const expected = proof.fingerprints.get(operatorId);
  if (context && expectedWorkflowId !== undefined && context.workflowId !== expectedWorkflowId) return undefined;
  if (context?.definitionHash && context.definitionHash !== expected?.definitionHash) return undefined;
  if (context?.subgraphHash && context.subgraphHash !== expected?.subgraphHash) return undefined;
  if (
    context &&
    previous?.executionContext &&
    /^\d{1,20}$/.test(context.executionId) &&
    /^\d{1,20}$/.test(previous.executionContext.executionId) &&
    BigInt(context.executionId) < BigInt(previous.executionContext.executionId)
  )
    return undefined;
  if (info.error || !Array.isArray(info.result)) return info;

  const omissions: string[] = [];
  const contextValid =
    context &&
    Number.isSafeInteger(context.workflowId) &&
    context.workflowId >= 0 &&
    /^\d{1,20}$/.test(context.executionId);
  if (
    !contextValid ||
    !expected ||
    context.definitionHash !== expected.definitionHash ||
    context.subgraphHash !== expected.subgraphHash
  )
    omissions.push("request_identity_missing");
  const executionId = producingExecution(info);
  if (!executionId) omissions.push("producing_execution_unknown");
  if (info.materialization?.outputPort !== 0) omissions.push("output_port_unknown");
  if (!native.revision || !/^[a-f0-9]{16}$/.test(native.revision)) omissions.push("operator_revision_unknown");

  const physicalInputs = [...new Set(native.inputs)];
  const wiring = proof.plan.links.filter(link => link.toOpId === operatorId);
  const wiringValid =
    physicalInputs.length === wiring.length &&
    physicalInputs.every((id, index) =>
      wiring.some(link => link.toPortId.id === index && link.fromOpId === id && link.fromPortId.id === 0)
    );
  if (!wiringValid) omissions.push("native_input_wiring_mismatch");
  const inputs: ResultVersion["inputs"] = [];
  for (const [inputIndex, inputId] of native.inputs.entries()) {
    const input = current.get(inputId);
    const binding = context?.inputs?.find(
      i => i.operatorId === inputId && i.inputPort === physicalInputs.indexOf(inputId) && i.outputPort === 0
    );
    // A materialized current input disproves a delayed response's old input.
    if (
      wiringValid &&
      binding?.executionId &&
      producingExecution(input) &&
      binding.executionId !== producingExecution(input) &&
      input?.executionContext &&
      contextValid &&
      /^\d{1,20}$/.test(input.executionContext.executionId) &&
      BigInt(context.executionId) <= BigInt(input.executionContext.executionId)
    )
      return undefined;
    const valid =
      wiringValid &&
      binding?.executionId &&
      input?.resultVersion?.complete &&
      !input.error &&
      input.resultVersion.workflowId === context?.workflowId &&
      input.resultVersion.executionId === binding.executionId;
    if (!valid) omissions.push("input_result_version_unknown");
    inputs.push({
      inputIndex,
      operatorId: inputId,
      outputPort: 0,
      resultVersion: valid ? input.resultVersion!.id : null,
    });
  }

  const profileExpected = { operatorId, operatorRevision: native.revision ?? "", expectedWorkers: info.numWorkers };
  let profile: TableProfile | undefined;
  const checkedProfile = (candidate: TableProfile): TableProfile => {
    let checked = candidate;
    // Empty/all-null object columns carry no value from which pandas can infer
    // a scalar type. The materialized table's typed schema is authoritative here;
    // this refines a type only, never fabricates a value/range/distinct metric.
    for (const [index, field] of candidate.schema.entries()) {
      const stored = info.resultSchema?.[index];
      const column = candidate.columns[field.name];
      if (
        field.type === "unknown" &&
        column?.nonnullCount === 0 &&
        stored?.name === field.name &&
        ["str", "int64", "float64", "bool", "datetime"].includes(stored.type)
      ) {
        field.type = stored.type as typeof field.type;
        column.type = field.type;
        if (!candidate.omissions.includes("schema_from_materialization"))
          candidate.omissions.push("schema_from_materialization");
      }
    }
    const invalidate = (reason: string) => {
      checked = {
        ...mergeTableProfiles(undefined, profileExpected),
        cost: candidate.cost,
        omissions: [...new Set([...checked.omissions, reason])],
      };
    };
    if (candidate.rowCount !== null && info.totalRowCount !== undefined && candidate.rowCount !== info.totalRowCount)
      invalidate("profile_result_count_mismatch");
    if (
      candidate.schemaComplete &&
      info.resultSchema &&
      canonical(candidate.schema.map(({ name, type }) => ({ name, type }))) !==
        canonical(info.resultSchema.map(({ name, type }) => ({ name, type })))
    )
      invalidate("profile_result_schema_mismatch");
    if (
      candidate.native &&
      (candidate.native.operatorType !== native.type ||
        canonical(candidate.native.inputOperators) !== canonical(native.inputs))
    )
      invalidate("profile_native_contract_mismatch");
    return checked;
  };
  if (native.profileCollection) {
    profile = checkedProfile(
      mergeTableProfiles(info.materialization?.cached ? undefined : info.resultMetadata, profileExpected)
    );
    profile.omissions = [...new Set([...profile.omissions, ...(info.metadataOmissions ?? [])])];
  }

  const matches = (candidate: OperatorInfo | undefined) => {
    const old = candidate?.resultVersion;
    return (
      info.materialization?.cached &&
      old?.complete &&
      omissions.length === 0 &&
      old.operatorId === operatorId &&
      old.workflowId === context!.workflowId &&
      old.operatorRevision === native.revision &&
      old.definitionHash === expected!.definitionHash &&
      old.subgraphHash === expected!.subgraphHash &&
      old.executionId === executionId &&
      old.outputPort === info.materialization.outputPort &&
      canonical(old.inputs) === canonical(inputs)
    );
  };
  let prior = previous;
  // A failed revision removes the current success, but a later repair may hit
  // that original engine cache entry. Only a complete, exactly matching pinned
  // historical proof can restore its metadata; never look up today's source text.
  if (info.materialization?.cached && !matches(prior)) {
    for (const candidate of historicalResults()) {
      if (matches(candidate)) {
        prior = candidate;
        break;
      }
    }
  }
  const old = prior?.resultVersion;
  const reusable = matches(prior);
  // Cached output did not consume today's new input versions. Without a matching
  // stored proof its original input-version relationship remains unknown.
  if (info.materialization?.cached && native.inputs.length && !reusable) {
    omissions.push("cached_input_versions_unknown");
    for (const input of inputs) input.resultVersion = null;
  }
  const identity = {
    workflowId: contextValid ? context.workflowId : null,
    operatorId,
    operatorRevision: native.revision ?? null,
    definitionHash: expected?.definitionHash ?? null,
    subgraphHash: expected?.subgraphHash ?? null,
    outputPort: info.materialization?.outputPort ?? null,
    executionId,
    inputs,
    sourceFingerprints: reusable ? old!.sourceFingerprints : sourceFingerprints(profile),
  };
  info.resultVersion = {
    version: 1,
    id: digest({ ...identity, ...(executionId ? {} : { retrieval: context?.executionId ?? null }) }),
    ...identity,
    complete: omissions.length === 0,
    omissions: [...new Set(omissions)],
  };
  if (native.profileCollection && reusable && prior?.tableProfile?.resultVersion === old!.id)
    profile = checkedProfile(structuredClone(prior.tableProfile));
  if (profile) {
    if (!info.resultVersion.complete)
      profile = {
        ...mergeTableProfiles(undefined, profileExpected),
        cost: profile.cost,
        omissions: [...new Set([...profile.omissions, ...omissions])],
      };
    info.tableProfile = { ...profile, resultVersion: info.resultVersion.id };
  }
  return info;
}

/** Results can arrive in any JSON property order. Persist input proofs first;
 * this orders observations only, without altering the shared tool scheduler. */
export function orderedResultIds(operators: Record<string, OperatorInfo>): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id) || !Object.hasOwn(operators, id)) return;
    visited.add(id);
    for (const input of operators[id]?.executionContext?.inputs ?? []) visit(input.operatorId);
    order.push(id);
  };
  for (const id of Object.keys(operators)) visit(id);
  return order;
}

export function freezeSnapshotValue<T>(value: T): T {
  const freeze = (value: any) => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(value);
  return value;
}
