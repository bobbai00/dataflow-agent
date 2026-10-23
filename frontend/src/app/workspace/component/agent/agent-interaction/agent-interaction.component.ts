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
import { isEqual } from "lodash-es";
import { AgentService, OperatorResultSummary, UserActionResponse } from "../../../service/agent/agent.service";
import { AgentState, ReActStep } from "../../../service/agent/agent-types";
import { isNativeOperator, nativeOperatorIcon, nativeOperatorTypeName } from "../../../service/agent/native-operator";
import {
  cellText,
  formProperties,
  inputOperatorIds,
  OperatorOutcome,
  OperatorProperty,
  operatorProperties,
  summaryOutcome,
  tableShape,
  OperatorTable,
} from "../../../service/agent/operator-data";
import { NativeOperatorDefinition, OperatorPredicate } from "../../../types/workflow-common.interface";
import { agentsOf } from "../../../service/agent/workflow-agent";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import { WorkflowResultService } from "../../../service/workflow-result/workflow-result.service";
import { NotificationService } from "../../../../common/service/notification/notification.service";
import { NgIf, NgFor, NgTemplateOutlet } from "@angular/common";
import {
  agentErrorText,
  NativeOperatorEditorComponent,
} from "../native-operator-editor/native-operator-editor.component";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzSpaceCompactItemDirective } from "ng-zorro-antd/space";
import { NzSelectComponent, NzOptionComponent } from "ng-zorro-antd/select";
import { FormsModule } from "@angular/forms";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { NzInputDirective, NzAutosizeDirective } from "ng-zorro-antd/input";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { MarkdownComponent } from "ngx-markdown";

/** Records shown for each input, and for the output. */
const INPUT_RECORDS = 3;
const OUTPUT_RECORDS = 5;

/** The panel's width: enough for four columns; each further column widens it, as a chart does, up to a bound. */
const PANEL_WIDTH = 480;
const COLUMN_WIDTH = 96;
const CHART_WIDTH = 760;
const MAX_PANEL_WIDTH = 920;

/** One table an operator reads, from the operator that produces it. */
export interface OperatorInput {
  operatorId: string;
  outcome: OperatorOutcome;
  running: boolean;
}

/** The agent's explanation of an operator: what it does, how its result comes from its inputs, and what it holds. */
export interface OperatorExplanation {
  /** The message that asked for it; the reply is the agent's first answer after it. */
  request: string;
  agentName: string;
  text?: string;
  pending: boolean;
}

/** Explanations by `${agentId}:${operatorId}`, kept while the workspace is open so reopening a panel shows them. */
const EXPLANATIONS = new Map<string, OperatorExplanation>();

/** The message that asks an agent to explain an operator, with its result; the chat shows it as the user's. */
export function explainRequest(operatorId: string, inputIds: readonly string[]): string {
  const from =
    inputIds.length > 0
      ? `its input${inputIds.length > 1 ? "s" : ""} ${inputIds.map(id => `\`${id}\``).join(", ")}`
      : "what it reads";
  return (
    `Explain \`${operatorId}\`. First see whether it has a result: look at it (show it; do not run anything). ` +
    `Then, in a few sentences, say what this operator does and how its result is computed from ${from}, ` +
    "and use the result in the explanation: how many rows it has, its key columns, and the values that matter. " +
    "If it has no result yet, say so and explain it from its definition. Do not change any operator."
  );
}

/**
 * The agent's answer to a request: its first reply without tool calls after
 * the request's own step. `done` without text means no answer is coming (the
 * conversation moved on).
 */
export function explanationReply(steps: readonly ReActStep[], request: string): { done: boolean; text?: string } {
  let asked = -1;
  steps.forEach((step, index) => {
    if (step.role === "user" && step.content.trim() === request.trim()) asked = index;
  });
  if (asked < 0) return { done: false };
  for (const step of steps.slice(asked + 1)) {
    if (step.role === "user" && step.messageSource !== "correction") return { done: true };
    if (step.role === "agent" && !(step.toolCalls?.length ?? 0) && step.content.trim()) {
      return { done: true, text: step.content.trim() };
    }
  }
  return { done: false };
}

/**
 * An operator's panel on the canvas, opened by selecting a native operator or
 * by an operator's chat button. It shows what the operator is — its doc and
 * its settings — and its data: each table it reads and the table it produces,
 * a few records each, in a section that can be hidden. A native operator the
 * dataflow agent defined also has Run, Edit and Feedback: a run or an edit
 * goes to the agent, which records it as the user's action and reads it at its
 * next turn; feedback is a message to the agent about the operator.
 */
@UntilDestroy()
@Component({
  selector: "texera-agent-interaction",
  templateUrl: "./agent-interaction.component.html",
  styleUrls: ["./agent-interaction.component.scss"],
  imports: [
    NgIf,
    NgFor,
    NgTemplateOutlet,
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
    NativeOperatorEditorComponent,
    MarkdownComponent,
  ],
})
export class AgentInteractionComponent implements OnInit, OnChanges {
  @Input() operatorId!: string;
  @Input() operatorDisplayName?: string;
  /** "feedback" opens the panel on its feedback box (the operator's chat button). */
  @Input() initialMode: "actions" | "feedback" = "actions";
  @Output() closed = new EventEmitter<void>();

  public operator?: OperatorPredicate;
  /** Set when the operator is one the dataflow agent defined natively. */
  public nativeOperator?: OperatorPredicate & { nativeOp: NativeOperatorDefinition };
  public mode: "edit" | "feedback" | null = null;
  public running = false;
  public actionError?: string;
  /** A one-line confirmation under the actions, e.g. after a save. */
  public notice?: string;
  private agentState?: AgentState;
  private agentStateSubscription?: Subscription;
  /** The agent list has arrived; until then no agent is "missing". */
  private agentsLoaded = false;

  public availableAgents: Array<{ id: string; name: string; isConnected: boolean }> = [];
  public selectedAgentId: string | null = null;
  public feedbackMessage: string = "";
  /** The agent's explanation of this operator, asked for with the Explain action. */
  public explanation?: OperatorExplanation;
  private explanationSubscription?: Subscription;

  /** The operator's settings, as its edit form names them when the agent can split its statement. */
  public properties: OperatorProperty[] = [];
  /** The tables the operator reads, one per input. */
  public inputs: OperatorInput[] = [];
  /** The table the operator produces, or why there is none. */
  public output: OperatorOutcome = {};
  /** The agent's run is computing the operator now. */
  public outputRunning = false;
  /** The data section is open; it opens with the panel. */
  public dataExpanded = true;

  private summaries: Map<string, OperatorResultSummary> = new Map();
  private runningOperators: ReadonlySet<string> = new Set();
  /** Results of a Texera run (not the agent's), for operators the agent has none for. */
  private engineOutcomes = new Map<string, OperatorOutcome>();
  private chartHtml: { raw: string; safe: SafeHtml } | null = null;

  constructor(
    private agentService: AgentService,
    private workflowActionService: WorkflowActionService,
    private workflowResultService: WorkflowResultService,
    private notificationService: NotificationService,
    private changeDetectorRef: ChangeDetectorRef,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    // The connected agent is known at once; the full list arrives over HTTP.
    this.selectedAgentId = this.agentService.getActivelyConnectedAgentIds()[0] ?? this.selectedAgentId;
    this.watchAgentState();
    this.loadExplanation();
    this.loadAvailableAgents();
    this.agentService.agentChange$.pipe(untilDestroyed(this)).subscribe(() => {
      this.loadAvailableAgents();
    });
    this.agentService.operatorResultSummaries$.pipe(untilDestroyed(this)).subscribe(summaries => {
      this.summaries = summaries;
      this.refreshData();
    });
    this.agentService.runningOperators$.pipe(untilDestroyed(this)).subscribe(running => {
      this.runningOperators = running;
      this.refreshData();
    });
    this.workflowResultService
      .getResultUpdateStream()
      .pipe(untilDestroyed(this))
      .subscribe(() => this.loadEngineResults());
    // A canvas update (after an edit) re-adds the operator with its new definition.
    const graph = this.workflowActionService.getTexeraGraph();
    merge(
      graph.getOperatorAddStream(),
      graph.getOperatorPropertyChangeStream(),
      graph.getLinkAddStream(),
      graph.getLinkDeleteStream()
    )
      .pipe(untilDestroyed(this))
      .subscribe(() => this.refreshOperator());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["operatorId"] || changes["initialMode"]) {
      this.mode = this.initialMode === "feedback" ? "feedback" : null;
      this.actionError = undefined;
      this.notice = undefined;
      if (changes["operatorId"]) this.dataExpanded = true;
      this.refreshOperator();
      this.loadExplanation();
    }
  }

  private loadAvailableAgents(): void {
    // Only this workflow's agents: the agent panel chats with one of them, never with another workflow's.
    const workflowId = this.workflowActionService.getWorkflowMetadata().wid ?? undefined;
    this.agentService
      .getAllAgents(workflowId)
      .pipe(untilDestroyed(this))
      .subscribe(agents => {
        const connectedAgentIds = new Set(this.agentService.getActivelyConnectedAgentIds());

        this.availableAgents = agentsOf(agents, workflowId).map(agent => ({
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
        this.loadProperties();
        this.changeDetectorRef.detectChanges();
      });
  }

  /** The operator as the canvas holds it now, and everything shown of it. */
  private refreshOperator(): void {
    const graph = this.workflowActionService.getTexeraGraph();
    const definition = (op?: OperatorPredicate) => op && [op.operatorID, op.nativeOp?.source ?? op.operatorProperties];
    const previous = definition(this.operator);
    this.operator =
      this.operatorId && graph.hasOperator(this.operatorId) ? graph.getOperator(this.operatorId) : undefined;
    this.nativeOperator = isNativeOperator(this.operator) ? this.operator : undefined;
    // Another operator, or this one defined anew: its settings and results again.
    if (!isEqual(previous, definition(this.operator))) {
      this.loadProperties();
      this.loadEngineResults();
    }
    this.refreshData();
  }

  /** The operator's settings: a native operator's as its edit form names them, once the agent splits its statement. */
  private loadProperties(): void {
    const operator = this.operator;
    if (!operator) {
      this.properties = [];
      return;
    }
    this.properties = operatorProperties(operator);
    const agentId = this.actionAgentId;
    if (!isNativeOperator(operator) || !agentId) return;
    this.agentService
      .getNativeStatementForm(agentId, operator.operatorID)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: form => {
          if (this.operator?.operatorID !== form.id) return;
          this.properties = formProperties(form);
          this.changeDetectorRef.detectChanges();
        },
        // The statement stays shown as it is.
        error: () => {},
      });
  }

  /** The tables the operator reads and produces, from the agent's results, else a Texera run's. */
  private refreshData(): void {
    const operator = this.operator;
    const outcome = (operatorId: string, limit: number): OperatorOutcome => {
      const summary = this.summaries.get(operatorId);
      return summary ? summaryOutcome(operatorId, summary, limit) : this.engineOutcomes.get(operatorId) ?? {};
    };
    this.inputs = operator
      ? inputOperatorIds(operator, this.workflowActionService.getTexeraGraph().getAllLinks()).map(operatorId => ({
          operatorId,
          outcome: outcome(operatorId, INPUT_RECORDS),
          running: this.runningOperators.has(operatorId),
        }))
      : [];
    this.output = operator ? outcome(operator.operatorID, OUTPUT_RECORDS) : {};
    this.outputRunning = !!operator && this.runningOperators.has(operator.operatorID);
    const html = this.output.table?.html;
    if (html !== this.chartHtml?.raw)
      this.chartHtml = html === undefined ? null : { raw: html, safe: this.sanitizer.bypassSecurityTrustHtml(html) };
    this.changeDetectorRef.detectChanges();
  }

  /** A Texera run's first page for the operator and its inputs, where the agent recorded none. */
  private loadEngineResults(): void {
    const operator = this.operator;
    if (!operator) return;
    const ids = [
      operator.operatorID,
      ...inputOperatorIds(operator, this.workflowActionService.getTexeraGraph().getAllLinks()),
    ];
    for (const operatorId of ids) {
      if (this.summaries.has(operatorId)) continue;
      const limit = operatorId === operator.operatorID ? OUTPUT_RECORDS : INPUT_RECORDS;
      const paginated = this.workflowResultService.getPaginatedResultService(operatorId);
      if (paginated) {
        paginated
          .selectPage(1, limit)
          .pipe(untilDestroyed(this))
          .subscribe(page => {
            this.engineOutcomes.set(operatorId, {
              table: {
                rows: paginated.getCurrentTotalNumTuples(),
                columns: page.schema.map(attribute => ({
                  name: attribute.attributeName,
                  type: attribute.attributeType,
                })),
                records: page.table.slice(0, limit) as Array<Record<string, unknown>>,
                cached: false,
              },
            });
            this.refreshData();
          });
        continue;
      }
      const snapshot = this.workflowResultService.getResultService(operatorId)?.getCurrentResultSnapshot();
      const html = (snapshot?.[0] as Record<string, unknown> | undefined)?.["html-content"];
      if (typeof html === "string")
        this.engineOutcomes.set(operatorId, { table: { columns: [], records: [], html, cached: false } });
    }
    this.refreshData();
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
    if (this.nativeOperator) return nativeOperatorIcon(this.nativeOperator.nativeOp);
    return this.operator ? `assets/operator_images/${this.operator.operatorType}.png` : "";
  }

  public get typeName(): string {
    if (this.nativeOperator) return nativeOperatorTypeName(this.nativeOperator.nativeOp);
    return this.operator?.operatorType ?? "";
  }

  /** The operator's one-line doc, or the name the user gave it. */
  public get doc(): string | undefined {
    return this.nativeOperator?.nativeOp.doc?.trim() || this.operator?.customDisplayName || undefined;
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
    if (!this.nativeOperator) return undefined;
    if (!this.actionAgentId)
      return this.agentsLoaded ? "Open the agent's chat to run or edit this operator." : undefined;
    if (this.busy && !this.running) return `${this.agentName} is working; Run and Edit wait until it finishes.`;
    return this.notice;
  }

  /** The chart the operator drew, when it draws one. */
  public get chart(): SafeHtml | null {
    return this.chartHtml?.safe ?? null;
  }

  /**
   * The panel's width: a wide table or a chart widens it so more of it
   * shows, up to a bound that leaves the canvas around it in view.
   */
  public get panelWidth(): number {
    const columns = Math.max(
      0,
      ...[this.output, ...this.inputs.map(input => input.outcome)].map(outcome => outcome.table?.columns.length ?? 0)
    );
    const natural = this.chart ? CHART_WIDTH : PANEL_WIDTH + Math.max(0, columns - 4) * COLUMN_WIDTH;
    return Math.max(PANEL_WIDTH, Math.min(natural, MAX_PANEL_WIDTH, Math.round(window.innerWidth * 0.6)));
  }

  /** "2 rows · 3 columns" for the output and each input; what the data section's title says when hidden. */
  public shape(table: OperatorTable | undefined): string {
    return table ? tableShape(table) : "";
  }

  public cell(value: unknown): string {
    return cellText(value);
  }

  public toggleMode(mode: "edit" | "feedback"): void {
    this.mode = this.mode === mode ? null : mode;
    this.notice = undefined;
  }

  /** Compute the operator's result; the agent sees it as the user's run. */
  public run(): void {
    const agentId = this.actionAgentId;
    if (!agentId || !this.canAct) return;
    this.mode = null;
    this.dataExpanded = true;
    this.running = true;
    this.actionError = undefined;
    this.notice = undefined;
    this.agentService
      .runNativeOperator(agentId, this.operatorId)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: response => {
          this.running = false;
          if (response.status === "error") this.actionError = response.userAction?.error ?? "The run failed.";
          this.notice = response.responding
            ? `${this.agentName} sees your run and is answering in the chat.`
            : `${this.agentName} sees your run.`;
          this.changeDetectorRef.detectChanges();
        },
        error: (error: unknown) => {
          this.running = false;
          this.actionError = agentErrorText(error);
          this.changeDetectorRef.detectChanges();
        },
      });
  }

  /** After an edit: back to the operator, its result shown when it ran. */
  public onSaved(response: UserActionResponse): void {
    this.actionError = undefined;
    this.mode = null;
    if (response.status === "unchanged") {
      this.notice = "Nothing changed.";
    } else if (response.userAction?.run || response.status === "error") {
      this.dataExpanded = true;
      if (response.status === "error")
        this.actionError = response.userAction?.error ?? "The change was saved, but the run failed.";
      this.notice = response.responding
        ? `${this.saved(response)} ${this.agentName} is answering in the chat.`
        : this.saved(response);
    } else {
      this.notice = `${this.saved(response)} ${this.agentName} reads your change at its next turn.`;
    }
    this.changeDetectorRef.detectChanges();
  }

  public onAgentSelected(): void {
    this.watchAgentState();
    this.loadProperties();
    this.loadExplanation();
  }

  /**
   * Ask the agent to explain the operator: what it does, how its result is
   * computed from its inputs, and what the result holds, which it looks at
   * first. It runs nothing: a run would replace the results downstream. The request and the reply are ordinary chat
   * messages; the reply also shows here, under the actions.
   */
  public explain(): void {
    const agentId = this.actionAgentId;
    if (!agentId || !this.canAct) return;
    const request = explainRequest(
      this.operatorId,
      this.inputs.map(input => input.operatorId)
    );
    this.mode = null;
    this.notice = undefined;
    this.actionError = undefined;
    this.agentService.sendMessage(agentId, request, "feedback");
    this.explanation = { request, agentName: this.agentName, pending: true };
    EXPLANATIONS.set(this.explanationKey(agentId), this.explanation);
    this.watchExplanation(agentId);
    this.changeDetectorRef.detectChanges();
  }

  public dismissExplanation(): void {
    if (this.selectedAgentId) EXPLANATIONS.delete(this.explanationKey(this.selectedAgentId));
    this.explanation = undefined;
    this.explanationSubscription?.unsubscribe();
  }

  private explanationKey(agentId: string): string {
    return `${agentId}:${this.operatorId}`;
  }

  /** The explanation this agent gave of this operator, if it was asked. */
  private loadExplanation(): void {
    this.explanationSubscription?.unsubscribe();
    this.explanation = this.selectedAgentId ? EXPLANATIONS.get(this.explanationKey(this.selectedAgentId)) : undefined;
    if (this.explanation?.pending && this.selectedAgentId) this.watchExplanation(this.selectedAgentId);
  }

  /** Fill the pending explanation from the agent's reply when it arrives. */
  private watchExplanation(agentId: string): void {
    this.explanationSubscription?.unsubscribe();
    const explanation = this.explanation;
    if (!explanation?.pending) return;
    this.explanationSubscription = this.agentService
      .getReActStepsObservable(agentId)
      .pipe(untilDestroyed(this))
      .subscribe(steps => {
        const reply = explanationReply(steps, explanation.request);
        if (!reply.done) return;
        explanation.text = reply.text;
        explanation.pending = false;
        this.explanationSubscription?.unsubscribe();
        this.changeDetectorRef.detectChanges();
      });
  }

  /** "Saved as v6." — the version a saved edit made. */
  private saved(response: UserActionResponse): string {
    const version = response.userAction?.version;
    return version === undefined ? "Saved." : `Saved as v${version}.`;
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
    const operatorName = this.operatorDisplayName || this.operator?.customDisplayName || "this operator";
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

  public canSend(): boolean {
    return !!this.selectedAgentId && !!this.feedbackMessage.trim();
  }
}
