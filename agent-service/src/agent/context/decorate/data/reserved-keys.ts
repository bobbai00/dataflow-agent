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
 * Reserved `columnStats` keys the amber worker uses to ship operator-level
 * diagnostics (not real columns — filtered from schema/stats rendering). The
 * worker is the single producer (see data_processor.py, coercion_telemetry.py);
 * the data-facet decorators are the consumers.
 */
export const COERCION_TELEMETRY_KEY = "__coercion_telemetry__";
export const TABLE_HINTS_KEY = "__table_hints__";
/** A7: multi-file load provenance — the file list the operator's glob actually
 *  matched (`files read: 53 [ALABAMA.csv, …]`). A FACT, not a column. */
export const FILE_IO_KEY = "__file_io__";
// `__join_telemetry__` is a RETIRED producer key (the join-telemetry lever was
// removed). Kept in the filter set as a bare literal so any stale / old-deploy
// stats that still carry it are dropped from the schema render instead of
// leaking as a fake column — defensive hygiene, not a live signal.
export const RESERVED_STATS_KEYS = new Set(["__join_telemetry__", COERCION_TELEMETRY_KEY, TABLE_HINTS_KEY, FILE_IO_KEY]);
