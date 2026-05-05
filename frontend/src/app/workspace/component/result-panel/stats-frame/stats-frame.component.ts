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

import { Component, Input, OnChanges, OnInit, SimpleChanges } from "@angular/core";
import { NgIf, NgFor } from "@angular/common";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { WorkflowStatusService } from "../../../service/workflow-status/workflow-status.service";

interface ColumnStat {
  column: string;
  rows: Array<{ key: string; value: string }>;
}

@UntilDestroy()
@Component({
  selector: "texera-stats-frame",
  templateUrl: "./stats-frame.component.html",
  styleUrls: ["./stats-frame.component.scss"],
  imports: [NgIf, NgFor],
})
export class StatsFrameComponent implements OnInit, OnChanges {
  @Input() operatorId?: string;

  columnStats: ColumnStat[] = [];

  constructor(private workflowStatusService: WorkflowStatusService) {}

  ngOnInit(): void {
    this.refresh();
    this.workflowStatusService
      .getStatusUpdateStream()
      .pipe(untilDestroyed(this))
      .subscribe(() => this.refresh());
  }

  ngOnChanges(_: SimpleChanges): void {
    this.refresh();
  }

  /**
   * Pull the current `resultStatistics` map for the highlighted operator,
   * parse each per-column JSON blob, and shape it for the template.
   *
   * `data_processor.py:_compute_column_stats` produces a flat blob per column;
   * downstream services may also wrap it as `{ data_type, statistics: {...} }`.
   * Both forms are handled.
   */
  private refresh(): void {
    if (!this.operatorId) {
      this.columnStats = [];
      return;
    }
    const status = this.workflowStatusService.getCurrentStatus()[this.operatorId];
    const raw = status?.resultStatistics;
    if (!raw || Object.keys(raw).length === 0) {
      this.columnStats = [];
      return;
    }

    const result: ColumnStat[] = [];
    for (const [column, json] of Object.entries(raw)) {
      let parsed: any;
      try {
        parsed = JSON.parse(json);
      } catch {
        continue;
      }
      const stats = parsed?.statistics ?? parsed ?? {};
      const rows: Array<{ key: string; value: string }> = [];
      for (const [k, v] of Object.entries(stats)) {
        if (v === undefined) continue;
        if (k === "top_10" && Array.isArray(v)) {
          const items = (v as Array<{ value: any; count: number }>)
            .slice(0, 10)
            .map(it => `${it.value} (${it.count})`)
            .join(", ");
          rows.push({ key: "top values", value: items });
        } else if (v === null) {
          rows.push({ key: k, value: "—" });
        } else if (typeof v === "object") {
          rows.push({ key: k, value: JSON.stringify(v) });
        } else if (typeof v === "number" && !Number.isInteger(v)) {
          rows.push({ key: k, value: Number(v.toPrecision(4)).toString() });
        } else {
          rows.push({ key: k, value: String(v) });
        }
      }
      result.push({ column, rows });
    }
    this.columnStats = result;
  }
}
