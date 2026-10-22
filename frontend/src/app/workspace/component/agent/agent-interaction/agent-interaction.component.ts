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

import {
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
  SimpleChanges,
} from "@angular/core";
import { DomSanitizer, SafeHtml } from "@angular/platform-browser";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { merge, Subscription } from "rxjs";
import { AgentService, OperatorResultSummary, UserActionResponse } from "../../../service/agent/agent.service";
import { AgentState } from "../../../service/agent/agent-types";
import {
  isNativeOperator,
  nativeOperatorIcon,
  nativeOperatorSummary,
  nativeOperatorTypeName,
} from "../../../service/agent/native-operator";
import { NativeOperatorDefinition, OperatorPredicate } from "../../../types/workflow-common.interface";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import { NotificationService } from "../../../../common/service/notification/notification.service";
import { NgIf, NgFor, NgSwitch, NgSwitchCase, NgTemplateOutlet } from "@angular/common";
import {
  agentErrorText,
  NativeOperatorEditorComponent,
} from "../native-operator-editor/native-operator-editor.component";
import {
  NzTheadComponent,
  NzTrDirective,
  NzTableCellDirective,
  NzThMeasureDirective,
  NzTbodyComponent,
} from "ng-zorro-antd/table";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzSpaceCompactItemDirective } from "ng-zorro-antd/space";
import { NzSelectComponent, NzOptionComponent } from "ng-zorro-antd/select";
import { FormsModule } from "@angular/forms";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { NzInputDirective, NzAutosizeDirective } from "ng-zorro-antd/input";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";

/**
 * AgentInteractionComponent provides a compact interface for users to send feedback
 * or messages to agents regarding a specific operator.
 * It consists of an agent dropdown and a text input area.
 *
 * For an operator the dataflow agent defined natively it is the operator's panel:
 * what the operator is, and Run, Edit and Feedback. A run or an edit goes to the
 * agent, which records it as the user's action and reads it at its next turn.
 */
@UntilDestroy()
@Component({
  selector: "texera-agent-interaction",
  templateUrl: "./agent-interaction.component.html",
  styleUrls: ["./agent-interaction.component.scss"],
  imports: [
    NgIf,
    NzTheadComponent,
    NzTrDirective,
    NgFor,
    NzTableCellDirective,
    NzThMeasureDirective,
    NzTbodyComponent,
    ɵNzTransitionPatchDirective,
    NzIconDirective,
    NzSpaceCompactItemDirective,
    NzSelectComponent,
    FormsModule,
    NzOptionComponent,
    NzTooltipDirective,
    NzInputDirective,
    NzAutosizeDirective,
    NzButtonComponent,
    NzWaveDirective,
    NgSwitch,
    NgSwitchCase,
    NgTemplateOutlet,
    NativeOperatorEditorComponent,
  ],
})
export class AgentInteractionComponent implements OnInit, OnChanges {
  @Input() operatorId!: string;
  @Input() operatorDisplayName?: string;
  @Input() sampleRecords?: Record<string, any>[];
  @Input() resultStatistics?: Record<string, string>;
  /** The operator's current result: state, shape and error. */
  @Input() resultSummary?: OperatorResultSummary;
  /** "feedback" opens a native operator's panel on its feedback box (the box's chat button). */
  @Input() initialMode: "actions" | "feedback" = "actions";
  @Output() closed = new EventEmitter<void>();

  /** Set when the operator is one the dataflow agent defined natively. */
  public nativeOperator?: OperatorPredicate & { nativeOp: NativeOperatorDefinition };
  public mode: "result" | "edit" | "feedback" | null = null;
  public running = false;
  public actionError?: string;
  /** A one-line confirmation under the actions, e.g. after a save. */
  public notice?: string;
  /** The agent the last run or edit went to. */
  public sharedWith?: string;
  private agentState?: AgentState;
  private agentStateSubscription?: Subscription;
  /** The agent list has arrived; until then no agent is "missing". */
  private agentsLoaded = false;

  public availableAgents: Array<{ id: string; name: string; isConnected: boolean }> = [];
  public selectedAgentId: string | null = null;
  public feedbackMessage: string = "";

  // Cached visualization HTML to avoid iframe re-render on every WS update
  private cachedVisualizationHtml: SafeHtml | null = null;
  private cachedVisualizationRawHtml: string | null = null;

  constructor(
    private agentService: AgentService,
    private workflowActionService: WorkflowActionService,
    private notificationService: NotificationService,
    private changeDetectorRef: ChangeDetectorRef,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    // The connected agent is known at once; the full list arrives over HTTP.
    this.selectedAgentId = this.agentService.getActivelyConnectedAgentIds()[0] ?? this.selectedAgentId;
    this.watchAgentState();
    this.loadAvailableAgents();
    this.agentService.agentChange$.pipe(untilDestroyed(this)).subscribe(() => {
      this.loadAvailableAgents();
    });
    // A canvas reload (after an edit) re-adds the operator with its new definition.
    const graph = this.workflowActionService.getTexeraGraph();
    merge(graph.getOperatorAddStream(), graph.getOperatorPropertyChangeStream())
      .pipe(untilDestroyed(this))
      .subscribe(() => this.refreshOperator());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["operatorId"] || changes["initialMode"]) {
      this.refreshOperator();
      this.mode = this.initialMode === "feedback" ? "feedback" : null;
      this.actionError = undefined;
      this.notice = undefined;
      if (changes["operatorId"]) this.sharedWith = undefined;
    }
    if (changes["sampleRecords"]) {
      // Only update cached visualization HTML when the actual content changes
      const newRecords = changes["sampleRecords"].currentValue as Record<string, any>[] | undefined;
      const newHtml = newRecords?.[0]?.["html-content"] || null;
      if (newHtml !== this.cachedVisualizationRawHtml) {
        this.cachedVisualizationRawHtml = newHtml;
        this.cachedVisualizationHtml = newHtml ? this.sanitizer.bypassSecurityTrustHtml(newHtml) : null;
      }
    }
  }

  private loadAvailableAgents(): void {
    this.agentService
      .getAllAgents()
      .pipe(untilDestroyed(this))
      .subscribe(agents => {
        const connectedAgentIds = new Set(this.agentService.getActivelyConnectedAgentIds());

        this.availableAgents = agents.map(agent => ({
          id: agent.id,
          name: agent.name,
          isConnected: connectedAgentIds.has(agent.id),
        }));

        // Auto-select: prefer connected agent, then first agent if only one
        const connectedAgent = this.availableAgents.find(a => a.isConnected);
        if (connectedAgent) {
          this.selectedAgentId = connectedAgent.id;
        } else if (this.availableAgents.length === 1) {
          this.selectedAgentId = this.availableAgents[0].id;
        }

        this.agentsLoaded = true;
        this.watchAgentState();
        this.changeDetectorRef.detectChanges();
      });
  }

  private refreshOperator(): void {
    const graph = this.workflowActionService.getTexeraGraph();
    let operator: OperatorPredicate | undefined;
    try {
      operator = this.operatorId ? graph.getOperator(this.operatorId) : undefined;
    } catch {
      operator = undefined;
    }
    this.nativeOperator = isNativeOperator(operator) ? operator : undefined;
  }

  /** Follow the agent's state: Run and Edit wait while it works. */
  private watchAgentState(): void {
    this.agentStateSubscription?.unsubscribe();
    if (!this.selectedAgentId) return;
    this.agentStateSubscription = this.agentService
      .getAgentStateObservable(this.selectedAgentId)
      .pipe(untilDestroyed(this))
      .subscribe(state => {
        this.agentState = state;
        this.changeDetectorRef.detectChanges();
      });
  }

  public get icon(): string {
    return this.nativeOperator ? nativeOperatorIcon(this.nativeOperator.nativeOp) : "";
  }

  public get typeName(): string {
    return this.nativeOperator ? nativeOperatorTypeName(this.nativeOperator.nativeOp) : "";
  }

  public get summary(): string {
    return this.nativeOperator ? nativeOperatorSummary(this.nativeOperator) : "";
  }

  /** The connected agent that runs and edits this operator. */
  public get actionAgentId(): string | undefined {
    return this.selectedAgentId && this.isSelectedAgentConnected() ? this.selectedAgentId : undefined;
  }

  public get agentName(): string {
    return this.availableAgents.find(agent => agent.id === this.selectedAgentId)?.name ?? "The agent";
  }

  public get busy(): boolean {
    return this.agentState === AgentState.GENERATING || this.agentState === AgentState.STOPPING;
  }

  public get canAct(): boolean {
    return !!this.actionAgentId && !this.busy && !this.running;
  }

  /** Why Run and Edit are unavailable, or what the last action did. */
  public get statusText(): string | undefined {
    if (!this.actionAgentId)
      return this.agentsLoaded ? "Open the agent's chat to run or edit this operator." : undefined;
    if (this.busy && !this.running) return `${this.agentName} is working; Run and Edit wait until it finishes.`;
    return this.notice;
  }

  /** "2 rows · 3 columns" for a computed result. */
  public get resultShape(): string | undefined {
    const summary = this.resultSummary;
    if (!summary || summary.error || !["Completed", "CompletedFromCache"].includes(summary.state)) return undefined;
    const rows = summary.totalRowCount ?? summary.outputTuples;
    const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
    return [plural(rows, "row"), ...(summary.outputColumns ? [plural(summary.outputColumns, "column")] : [])].join(
      " · "
    );
  }

  public toggleMode(mode: "result" | "edit" | "feedback"): void {
    this.mode = this.mode === mode ? null : mode;
    this.notice = undefined;
  }

  /** Compute the operator's result; the agent sees it as the user's run. */
  public run(): void {
    const agentId = this.actionAgentId;
    if (!agentId || !this.canAct) return;
    this.mode = "result";
    this.running = true;
    this.actionError = undefined;
    this.notice = undefined;
    this.agentService
      .runNativeOperator(agentId, this.operatorId)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: response => {
          this.running = false;
          this.sharedWith = this.agentName;
          if (response.status === "error") this.actionError = response.userAction?.error ?? "The run failed.";
          this.changeDetectorRef.detectChanges();
        },
        error: (error: unknown) => {
          this.running = false;
          this.actionError = agentErrorText(error);
          this.changeDetectorRef.detectChanges();
        },
      });
  }

  /** After an edit: show the result when it ran, otherwise confirm the save. */
  public onSaved(response: UserActionResponse): void {
    this.actionError = undefined;
    if (response.status === "unchanged") {
      this.mode = null;
      this.notice = "Nothing changed.";
    } else if (response.userAction?.run || response.status === "error") {
      this.mode = "result";
      this.sharedWith = this.agentName;
      if (response.status === "error")
        this.actionError = response.userAction?.error ?? "The change was saved, but the run failed.";
    } else {
      this.mode = null;
      this.notice = `Saved. ${this.agentName} reads your change at its next turn.`;
    }
    this.changeDetectorRef.detectChanges();
  }

  public onAgentSelected(): void {
    this.watchAgentState();
  }

  public isSelectedAgentConnected(): boolean {
    if (!this.selectedAgentId) return false;
    return this.agentService.isAgentActivelyConnected(this.selectedAgentId);
  }

  public sendFeedbackToAgent(): void {
    if (!this.selectedAgentId || !this.feedbackMessage.trim() || !this.operatorId) {
      return;
    }

    if (!this.isSelectedAgentConnected()) {
      this.notificationService.error("Agent is not connected. Please open the agent chat panel first.");
      return;
    }

    const agentId = this.selectedAgentId;
    const operatorName = this.operatorDisplayName || this.getOperatorName() || "this operator";
    // A native operator's id is the name the agent itself uses for it.
    const contextMessage = this.nativeOperator
      ? `Feedback on \`${this.operatorId}\`: ${this.feedbackMessage.trim()}`
      : `Regarding operator "${operatorName}" (ID: ${this.operatorId}): ${this.feedbackMessage.trim()}`;

    this.agentService.sendMessage(agentId, contextMessage, "feedback");
    this.notificationService.success("Message sent to agent successfully");
    this.feedbackMessage = "";
    if (this.nativeOperator) {
      this.mode = null;
      this.notice = `Sent to ${this.agentName}; the reply is in the chat.`;
    }
    this.changeDetectorRef.detectChanges();
  }

  private getOperatorName(): string | undefined {
    try {
      const operator = this.workflowActionService.getTexeraGraph().getOperator(this.operatorId);
      return operator?.customDisplayName || undefined;
    } catch {
      return undefined;
    }
  }

  public canSend(): boolean {
    return !!this.selectedAgentId && !!this.feedbackMessage.trim();
  }

  /**
   * Check if sample records represent a visualization (has __is_visualization__ flag).
   */
  public isVisualization(): boolean {
    if (!this.sampleRecords || this.sampleRecords.length === 0) return false;
    return this.sampleRecords[0]["__is_visualization__"] === true;
  }

  /**
   * Get the cached sanitized HTML content from a visualization record for iframe srcdoc.
   */
  public getVisualizationHtml(): SafeHtml {
    return this.cachedVisualizationHtml || this.sanitizer.bypassSecurityTrustHtml("");
  }

  /**
   * Get column names from sample records, placing __row_index__ first (displayed as "Row").
   */
  public getSampleColumns(): string[] {
    if (!this.sampleRecords || this.sampleRecords.length === 0) return [];
    const allKeys = Object.keys(this.sampleRecords[0]);
    const rowIndexKey = allKeys.find(k => k.startsWith("_") && k.includes("row_index"));
    const otherKeys = allKeys.filter(k => k !== rowIndexKey);
    return rowIndexKey ? [rowIndexKey, ...otherKeys] : otherKeys;
  }

  /**
   * Get display name for a column header.
   */
  public getColumnDisplayName(col: string): string {
    if (col.startsWith("_") && col.includes("row_index")) return "Row";
    return col;
  }

  /**
   * Parse resultStatistics into displayable column stats.
   * Each entry in resultStatistics is a JSON string with { data_type, statistics: { ... } }.
   */
  public getParsedColumnStats(): Array<{
    column: string;
    dataType: string;
    stats: Array<{ key: string; value: string }>;
  }> {
    if (!this.resultStatistics) return [];
    const sampleCols = this.getSampleColumns().filter(c => !c.startsWith("_") || !c.includes("row_index"));
    const columns = sampleCols.length > 0 ? sampleCols : Object.keys(this.resultStatistics);
    const result: Array<{ column: string; dataType: string; stats: Array<{ key: string; value: string }> }> = [];
    const excludedKeys = new Set(["count", "std", "p25", "median", "p75"]);

    for (const colName of columns) {
      const statsJson = this.resultStatistics[colName];
      if (!statsJson) continue;
      try {
        const parsed = JSON.parse(statsJson);
        const dataType: string = parsed.data_type ?? "unknown";
        const statistics: Record<string, any> = parsed.statistics ?? {};
        const statEntries: Array<{ key: string; value: string }> = [];

        for (const [key, value] of Object.entries(statistics)) {
          if (value === undefined || excludedKeys.has(key)) continue;
          if (key === "top_10" && typeof value === "object") {
            const topEntries = Object.entries(value as Record<string, any>)
              .slice(0, 5)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ");
            statEntries.push({ key: "top values", value: topEntries });
          } else if (value === null || String(value) === "null") {
            statEntries.push({ key, value: "NaN" });
          } else if (typeof value !== "object") {
            const formatted =
              typeof value === "number" && !Number.isInteger(value)
                ? Number(value.toPrecision(4)).toString()
                : String(value);
            statEntries.push({ key, value: formatted });
          }
        }
        result.push({ column: colName, dataType, stats: statEntries });
      } catch {
        // skip unparseable
      }
    }
    return result;
  }

  public hasColumnStats(): boolean {
    return this.getParsedColumnStats().length > 0;
  }

  public getDisplayRows(): Array<{ record?: Record<string, any>; isEllipsis: boolean }> {
    if (!this.sampleRecords || this.sampleRecords.length === 0) return [];
    const rowIndexKey = Object.keys(this.sampleRecords[0]).find(k => k.startsWith("_") && k.includes("row_index"));
    if (!rowIndexKey) {
      return this.sampleRecords.map(r => ({ record: r, isEllipsis: false }));
    }

    const rows: Array<{ record?: Record<string, any>; isEllipsis: boolean }> = [];
    for (let i = 0; i < this.sampleRecords.length; i++) {
      if (i > 0) {
        const prevIdx = this.sampleRecords[i - 1][rowIndexKey];
        const currIdx = this.sampleRecords[i][rowIndexKey];
        if (typeof prevIdx === "number" && typeof currIdx === "number" && currIdx - prevIdx > 1) {
          rows.push({ isEllipsis: true });
        }
      }
      rows.push({ record: this.sampleRecords[i], isEllipsis: false });
    }
    return rows;
  }
}
