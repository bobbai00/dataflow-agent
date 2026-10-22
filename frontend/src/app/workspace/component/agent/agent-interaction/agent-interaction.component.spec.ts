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

import { SimpleChange, SimpleChanges } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { DomSanitizer } from "@angular/platform-browser";
import { EMPTY, Subject, of, throwError } from "rxjs";
import { HttpErrorResponse } from "@angular/common/http";
import { AgentInteractionComponent } from "./agent-interaction.component";
import { AgentInfo, AgentService } from "../../../service/agent/agent.service";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import { NotificationService } from "../../../../common/service/notification/notification.service";
import { commonTestProviders } from "../../../../common/testing/test-utils";
import { AgentState } from "../../../service/agent/agent-types";
import { NativeOperatorEditorComponent } from "../native-operator-editor/native-operator-editor.component";

function makeAgent(id: string, name: string = id): AgentInfo {
  return { id, name, modelType: "gpt-test", isBaselineMode: false, createdAt: new Date("2026-01-01T00:00:00Z") };
}

/** The texera graph the component reads: one operator, and no change events. */
function graphWith(operator?: object) {
  return {
    getOperator: vi.fn().mockReturnValue(operator),
    getOperatorAddStream: () => EMPTY,
    getOperatorPropertyChangeStream: () => EMPTY,
  };
}

// A filter the dataflow agent defined natively.
const kept = {
  operatorID: "kept",
  operatorType: "DataProcessing",
  nativeOp: {
    type: "Filter",
    inputs: ["records"],
    properties: {},
    source: "set kept: filter(records, lambda row: row['value'] > 15)",
    doc: "Keep the records over 15.",
  },
};

describe("AgentInteractionComponent", () => {
  let fixture: ComponentFixture<AgentInteractionComponent>;
  let component: AgentInteractionComponent;
  let agentChangeSubject: Subject<void>;
  let agentService: {
    agentChange$: ReturnType<Subject<void>["asObservable"]>;
    getAllAgents: ReturnType<typeof vi.fn>;
    getActivelyConnectedAgentIds: ReturnType<typeof vi.fn>;
    isAgentActivelyConnected: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    getAgentStateObservable: ReturnType<typeof vi.fn>;
    runNativeOperator: ReturnType<typeof vi.fn>;
    editNativeOperator: ReturnType<typeof vi.fn>;
    getNativeStatementForm: ReturnType<typeof vi.fn>;
    getNativeCatalog: ReturnType<typeof vi.fn>;
    getOperatorResultSummaries: ReturnType<typeof vi.fn>;
  };
  let workflowActionService: { getTexeraGraph: ReturnType<typeof vi.fn> };
  let notification: Record<"success" | "error" | "info" | "warning", ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    agentChangeSubject = new Subject<void>();
    agentService = {
      agentChange$: agentChangeSubject.asObservable(),
      getAllAgents: vi.fn().mockReturnValue(of([])),
      getActivelyConnectedAgentIds: vi.fn().mockReturnValue([]),
      isAgentActivelyConnected: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      getAgentStateObservable: vi.fn().mockReturnValue(of(AgentState.AVAILABLE)),
      runNativeOperator: vi.fn(),
      editNativeOperator: vi.fn(),
      getNativeStatementForm: vi.fn().mockReturnValue(EMPTY),
      getNativeCatalog: vi.fn().mockReturnValue(of([])),
      getOperatorResultSummaries: vi.fn().mockReturnValue(new Map()),
    };
    workflowActionService = {
      getTexeraGraph: vi.fn().mockReturnValue(graphWith(undefined)),
    };
    notification = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [AgentInteractionComponent, HttpClientTestingModule, NoopAnimationsModule],
      providers: [
        { provide: AgentService, useValue: agentService },
        { provide: WorkflowActionService, useValue: workflowActionService },
        { provide: NotificationService, useValue: notification },
        ...commonTestProviders,
      ],
    }).compileComponents();
  });

  function createComponent(
    inputs: Partial<
      Pick<AgentInteractionComponent, "operatorId" | "operatorDisplayName" | "sampleRecords" | "resultStatistics">
    > = {}
  ): void {
    fixture = TestBed.createComponent(AgentInteractionComponent);
    component = fixture.componentInstance;
    component.operatorId = inputs.operatorId ?? "op-1";
    if (inputs.operatorDisplayName !== undefined) component.operatorDisplayName = inputs.operatorDisplayName;
    if (inputs.sampleRecords !== undefined) component.sampleRecords = inputs.sampleRecords;
    if (inputs.resultStatistics !== undefined) component.resultStatistics = inputs.resultStatistics;
    fixture.detectChanges();
  }

  it("should create", () => {
    createComponent();
    expect(component).toBeTruthy();
  });

  it("binds the @Input properties", () => {
    const records = [{ a: 1 }];
    const stats = { a: "{}" };
    createComponent({
      operatorId: "op-7",
      operatorDisplayName: "Filter",
      sampleRecords: records,
      resultStatistics: stats,
    });
    expect(component.operatorId).toBe("op-7");
    expect(component.operatorDisplayName).toBe("Filter");
    expect(component.sampleRecords).toBe(records);
    expect(component.resultStatistics).toBe(stats);
  });

  describe("loadAvailableAgents (ngOnInit)", () => {
    it("maps agents and flags the actively connected ones", () => {
      agentService.getAllAgents.mockReturnValue(of([makeAgent("a1"), makeAgent("a2")]));
      agentService.getActivelyConnectedAgentIds.mockReturnValue(["a2"]);

      createComponent();

      expect(component.availableAgents).toEqual([
        { id: "a1", name: "a1", isConnected: false },
        { id: "a2", name: "a2", isConnected: true },
      ]);
    });

    it("auto-selects the connected agent", () => {
      agentService.getAllAgents.mockReturnValue(of([makeAgent("a1"), makeAgent("a2")]));
      agentService.getActivelyConnectedAgentIds.mockReturnValue(["a2"]);
      createComponent();
      expect(component.selectedAgentId).toBe("a2");
    });

    it("auto-selects the only agent when none is connected", () => {
      agentService.getAllAgents.mockReturnValue(of([makeAgent("solo")]));
      agentService.getActivelyConnectedAgentIds.mockReturnValue([]);
      createComponent();
      expect(component.selectedAgentId).toBe("solo");
    });

    it("leaves the selection empty with multiple disconnected agents", () => {
      agentService.getAllAgents.mockReturnValue(of([makeAgent("a1"), makeAgent("a2")]));
      agentService.getActivelyConnectedAgentIds.mockReturnValue([]);
      createComponent();
      expect(component.selectedAgentId).toBeNull();
    });

    it("reloads the agent list when agentChange$ emits", () => {
      agentService.getAllAgents.mockReturnValue(of([makeAgent("a1")]));
      createComponent();
      expect(component.availableAgents).toHaveLength(1);

      agentService.getAllAgents.mockReturnValue(of([makeAgent("a1"), makeAgent("a2")]));
      agentChangeSubject.next();

      expect(component.availableAgents).toHaveLength(2);
    });
  });

  describe("isSelectedAgentConnected", () => {
    it("returns false when no agent is selected", () => {
      createComponent();
      component.selectedAgentId = null;
      expect(component.isSelectedAgentConnected()).toBe(false);
      expect(agentService.isAgentActivelyConnected).not.toHaveBeenCalled();
    });

    it("delegates to the service for the selected agent", () => {
      createComponent();
      component.selectedAgentId = "a1";
      agentService.isAgentActivelyConnected.mockReturnValue(true);
      expect(component.isSelectedAgentConnected()).toBe(true);
      expect(agentService.isAgentActivelyConnected).toHaveBeenCalledWith("a1");
    });
  });

  describe("canSend", () => {
    it("requires both a selected agent and a non-blank message", () => {
      createComponent();
      component.selectedAgentId = null;
      component.feedbackMessage = "hi";
      expect(component.canSend()).toBe(false);

      component.selectedAgentId = "a1";
      component.feedbackMessage = "   ";
      expect(component.canSend()).toBe(false);

      component.feedbackMessage = "hi";
      expect(component.canSend()).toBe(true);
    });
  });

  describe("sendFeedbackToAgent", () => {
    beforeEach(() => {
      createComponent({ operatorId: "op-1", operatorDisplayName: "MyOp" });
      component.selectedAgentId = "a1";
      component.feedbackMessage = "hello";
      agentService.isAgentActivelyConnected.mockReturnValue(true);
    });

    it("is a no-op when no agent is selected", () => {
      component.selectedAgentId = null;
      component.sendFeedbackToAgent();
      expect(agentService.sendMessage).not.toHaveBeenCalled();
    });

    it("is a no-op when the message is blank", () => {
      component.feedbackMessage = "   ";
      component.sendFeedbackToAgent();
      expect(agentService.sendMessage).not.toHaveBeenCalled();
    });

    it("is a no-op when there is no operatorId", () => {
      component.operatorId = "";
      component.sendFeedbackToAgent();
      expect(agentService.sendMessage).not.toHaveBeenCalled();
    });

    it("errors and does not send when the selected agent is not connected", () => {
      agentService.isAgentActivelyConnected.mockReturnValue(false);
      component.sendFeedbackToAgent();
      expect(notification.error).toHaveBeenCalledWith(
        "Agent is not connected. Please open the agent chat panel first."
      );
      expect(agentService.sendMessage).not.toHaveBeenCalled();
    });

    it("sends the feedback with operator context, notifies, and clears the input", () => {
      component.sendFeedbackToAgent();
      expect(agentService.sendMessage).toHaveBeenCalledWith(
        "a1",
        'Regarding operator "MyOp" (ID: op-1): hello',
        "feedback"
      );
      expect(notification.success).toHaveBeenCalledWith("Message sent to agent successfully");
      expect(component.feedbackMessage).toBe("");
    });

    it("falls back to the graph's custom display name when no display name is provided", () => {
      component.operatorDisplayName = undefined;
      workflowActionService.getTexeraGraph.mockReturnValue({
        getOperator: vi.fn().mockReturnValue({ customDisplayName: "GraphOp" }),
      });
      component.sendFeedbackToAgent();
      expect(agentService.sendMessage).toHaveBeenCalledWith(
        "a1",
        'Regarding operator "GraphOp" (ID: op-1): hello',
        "feedback"
      );
    });

    it("falls back to 'this operator' when no name can be resolved", () => {
      component.operatorDisplayName = undefined;
      workflowActionService.getTexeraGraph.mockImplementation(() => {
        throw new Error("no graph");
      });
      component.sendFeedbackToAgent();
      expect(agentService.sendMessage).toHaveBeenCalledWith(
        "a1",
        'Regarding operator "this operator" (ID: op-1): hello',
        "feedback"
      );
    });
  });

  describe("sample-record helpers", () => {
    it("detects a visualization record", () => {
      createComponent({ sampleRecords: [{ __is_visualization__: true, "html-content": "<p>x</p>" }] });
      expect(component.isVisualization()).toBe(true);
    });

    it("reports non-visualization and empty records as not a visualization", () => {
      createComponent({ sampleRecords: [{ a: 1 }] });
      expect(component.isVisualization()).toBe(false);
      component.sampleRecords = [];
      expect(component.isVisualization()).toBe(false);
    });

    it("lists columns with the row-index column first and maps its display name to 'Row'", () => {
      createComponent({ sampleRecords: [{ __row_index__: 0, a: 1, b: 2 }] });
      expect(component.getSampleColumns()).toEqual(["__row_index__", "a", "b"]);
      expect(component.getColumnDisplayName("__row_index__")).toBe("Row");
      expect(component.getColumnDisplayName("a")).toBe("a");
    });

    it("inserts an ellipsis row where the row index skips ahead", () => {
      createComponent({
        sampleRecords: [
          { __row_index__: 0, a: 1 },
          { __row_index__: 5, a: 2 },
        ],
      });
      const rows = component.getDisplayRows();
      expect(rows.map(r => r.isEllipsis)).toEqual([false, true, false]);
      expect(rows[0].record).toEqual({ __row_index__: 0, a: 1 });
      expect(rows[2].record).toEqual({ __row_index__: 5, a: 2 });
    });
  });

  describe("column statistics", () => {
    const stats = {
      score: JSON.stringify({
        data_type: "integer",
        statistics: { min: 1, max: 10, mean: 5.5, count: 100 },
      }),
    };

    it("parses resultStatistics and excludes noisy keys", () => {
      createComponent({ resultStatistics: stats });
      const parsed = component.getParsedColumnStats();
      expect(parsed).toHaveLength(1);
      expect(parsed[0].column).toBe("score");
      expect(parsed[0].dataType).toBe("integer");
      const keys = parsed[0].stats.map(s => s.key);
      expect(keys).toContain("min");
      expect(keys).toContain("max");
      expect(keys).not.toContain("count");
    });

    it("reports whether any column stats are present", () => {
      createComponent({ resultStatistics: stats });
      expect(component.hasColumnStats()).toBe(true);

      createComponent();
      expect(component.hasColumnStats()).toBe(false);
    });
  });

  describe("ngOnChanges visualization caching", () => {
    function sampleRecordsChange(currentValue: Record<string, any>[] | undefined): SimpleChanges {
      return { sampleRecords: new SimpleChange(undefined, currentValue, true) };
    }

    it("sanitizes and caches the html-content when sampleRecords change", () => {
      createComponent();
      const sanitizer = TestBed.inject(DomSanitizer);
      const spy = vi.spyOn(sanitizer, "bypassSecurityTrustHtml");

      component.ngOnChanges(sampleRecordsChange([{ "html-content": "<p>hi</p>" }]));

      expect(spy).toHaveBeenCalledWith("<p>hi</p>");
      expect(component.getVisualizationHtml()).toBeTruthy();
    });

    it("clears the cached html when the new records carry no html-content", () => {
      createComponent();
      component.ngOnChanges(sampleRecordsChange([{ "html-content": "<p>hi</p>" }]));
      component.ngOnChanges(sampleRecordsChange([{ a: 1 }]));

      // A cleared cache makes getVisualizationHtml fall through to the empty sanitized
      // fallback; if the cache had survived it would return the cached value instead.
      const sanitizer = TestBed.inject(DomSanitizer);
      const spy = vi.spyOn(sanitizer, "bypassSecurityTrustHtml");
      component.getVisualizationHtml();
      expect(spy).toHaveBeenCalledWith("");
    });
  });

  describe("a native operator's panel", () => {
    /** The panel for `kept`, with one connected agent, as the canvas opens it. */
    function createNative(state = AgentState.AVAILABLE, initialMode: "actions" | "feedback" = "actions"): HTMLElement {
      workflowActionService.getTexeraGraph.mockReturnValue(graphWith(kept));
      agentService.getAllAgents.mockReturnValue(of([makeAgent("a1", "Bob")]));
      agentService.getActivelyConnectedAgentIds.mockReturnValue(["a1"]);
      agentService.isAgentActivelyConnected.mockReturnValue(true);
      agentService.getAgentStateObservable.mockReturnValue(of(state));
      fixture = TestBed.createComponent(AgentInteractionComponent);
      component = fixture.componentInstance;
      fixture.componentRef.setInput("operatorId", "kept");
      fixture.componentRef.setInput("initialMode", initialMode);
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    }
    const button = (element: HTMLElement, name: string) =>
      Array.from(element.querySelectorAll<HTMLButtonElement>(".op-action")).find(b => b.textContent?.trim() === name)!;

    it("names the operator and offers Run, Edit and Feedback in place of the classic panel", () => {
      const element = createNative();
      expect(element.querySelector(".op-id")?.textContent?.trim()).toBe("kept");
      expect(element.querySelector(".op-type")?.textContent?.trim()).toBe("Filter");
      expect(element.querySelector(".op-summary")?.textContent?.trim()).toBe("Keep the records over 15.");
      expect(element.querySelector(".op-icon")?.getAttribute("src")).toBe("assets/operator_images/Filter.png");
      expect(Array.from(element.querySelectorAll(".op-action")).map(b => b.textContent?.trim())).toEqual([
        "Run",
        "Edit",
        "Feedback",
      ]);
      // Nothing opens until an action is chosen; one agent needs no picker.
      expect(element.querySelector(".op-body")).toBeNull();
      expect(element.querySelector(".header-row")).toBeNull();
    });

    it("runs the operator through its agent and shows the result the agent now sees", () => {
      agentService.runNativeOperator.mockReturnValue(
        of({ status: "ok", userAction: { kind: "run", operatorId: "kept", status: "ok", rows: 2 } })
      );
      const element = createNative();
      fixture.componentRef.setInput("sampleRecords", [
        { id: 2, value: 20 },
        { id: 3, value: 30 },
      ]);
      fixture.componentRef.setInput("resultSummary", {
        state: "Completed",
        inputTuples: 3,
        outputTuples: 2,
        totalRowCount: 2,
        outputColumns: 2,
      });
      button(element, "Run").click();
      fixture.detectChanges();

      expect(agentService.runNativeOperator).toHaveBeenCalledWith("a1", "kept");
      expect(element.querySelector(".result-shape")?.textContent?.trim()).toBe("2 rows · 2 columns");
      expect(element.querySelector(".result-shared")?.textContent?.trim()).toBe("Bob sees this");
      expect(element.querySelectorAll(".sample-records-table tbody tr").length).toBe(2);
    });

    it("says why a run failed", () => {
      agentService.runNativeOperator.mockReturnValue(
        throwError(() => new HttpErrorResponse({ status: 409, error: { error: "The agent is working." } }))
      );
      const element = createNative();
      button(element, "Run").click();
      fixture.detectChanges();
      expect(element.querySelector(".op-error")?.textContent?.trim()).toBe("The agent is working.");
    });

    it("waits while the agent works", () => {
      const element = createNative(AgentState.GENERATING);
      expect(button(element, "Run").disabled).toBe(true);
      expect(button(element, "Edit").disabled).toBe(true);
      expect(button(element, "Feedback").disabled).toBe(false);
      expect(element.querySelector(".op-status")?.textContent).toContain("Bob is working");
    });

    it("opens the editor for Edit, and after a save says the agent reads the change", () => {
      const element = createNative();
      button(element, "Edit").click();
      fixture.detectChanges();
      const editor = fixture.debugElement.query(
        debug => debug.componentInstance instanceof NativeOperatorEditorComponent
      );
      expect(editor.componentInstance.agentId).toBe("a1");
      expect(editor.componentInstance.operatorId).toBe("kept");

      component.onSaved({ status: "ok", userAction: { kind: "edit", operatorId: "kept", status: "ok" } });
      fixture.detectChanges();
      expect(element.querySelector(".op-body")).toBeNull();
      expect(element.querySelector(".op-status")?.textContent?.trim()).toBe(
        "Saved. Bob reads your change at its next turn."
      );

      component.onSaved({ status: "ok", userAction: { kind: "edit", operatorId: "kept", run: true, status: "ok" } });
      expect(component.mode).toBe("result");
    });

    it("sends feedback that names the operator by its id; the chat button opens the feedback box", () => {
      const element = createNative(AgentState.AVAILABLE, "feedback");
      expect(component.mode).toBe("feedback");
      component.feedbackMessage = "Use 20 instead.";
      component.sendFeedbackToAgent();
      expect(agentService.sendMessage).toHaveBeenCalledWith("a1", "Feedback on `kept`: Use 20 instead.", "feedback");
      fixture.detectChanges();
      expect(element.querySelector(".op-status")?.textContent?.trim()).toBe("Sent to Bob; the reply is in the chat.");
    });

    it("closes from its close button", () => {
      const element = createNative();
      const closed = vi.fn();
      component.closed.subscribe(closed);
      (element.querySelector(".op-close") as HTMLButtonElement).click();
      expect(closed).toHaveBeenCalled();
    });
  });
});
