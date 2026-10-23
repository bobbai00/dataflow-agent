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

import { ComponentFixture, TestBed } from "@angular/core/testing";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { BehaviorSubject, EMPTY, Subject, of, throwError } from "rxjs";
import { HttpErrorResponse } from "@angular/common/http";
import { AgentInteractionComponent, explainRequest } from "./agent-interaction.component";
import { AgentInfo, AgentService, OperatorResultSummary } from "../../../service/agent/agent.service";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import { WorkflowResultService } from "../../../service/workflow-result/workflow-result.service";
import { NotificationService } from "../../../../common/service/notification/notification.service";
import { commonTestProviders } from "../../../../common/testing/test-utils";
import { AgentState, ReActStep } from "../../../service/agent/agent-types";
import { NativeOperatorEditorComponent } from "../native-operator-editor/native-operator-editor.component";
import { NativeStatementForm } from "../../../service/agent/native-operator";

function makeAgent(id: string, name: string = id): AgentInfo {
  return { id, name, modelType: "gpt-test", isBaselineMode: false, createdAt: new Date("2026-01-01T00:00:00Z") };
}

/** The texera graph the component reads: these operators and links, and no change events. */
function graphWith(operators: object[] = [], links: object[] = []) {
  const byId = new Map(operators.map((op: any) => [op.operatorID, op]));
  return {
    hasOperator: (id: string) => byId.has(id),
    getOperator: (id: string) => byId.get(id),
    getAllLinks: () => links,
    getOperatorAddStream: () => EMPTY,
    getOperatorPropertyChangeStream: () => EMPTY,
    getLinkAddStream: () => EMPTY,
    getLinkDeleteStream: () => EMPTY,
  };
}

// A source and a filter the dataflow agent defined natively.
const records = {
  operatorID: "records",
  operatorType: "PythonUDFV2",
  nativeOp: { type: "Process", inputs: [], properties: {}, source: "set records: make_table()" },
};
const kept = {
  operatorID: "kept",
  operatorType: "PythonUDFV2",
  nativeOp: {
    type: "Filter",
    inputs: ["records"],
    properties: {},
    source: "set kept: filter(records, lambda row: row['value'] > 15)",
    doc: "Keep the records over 15.",
  },
};
const keptForm: NativeStatementForm = {
  id: "kept",
  op: "filter",
  inputs: ["records"],
  positional: [{ source: "lambda row: row['value'] > 15", kind: "lambda" }],
  keywords: [],
  doc: "Keep the records over 15.",
  statement: kept.nativeOp.source,
};
const table = (rows: number, extra: Partial<OperatorResultSummary> = {}): OperatorResultSummary => ({
  state: "Completed",
  inputTuples: 0,
  outputTuples: rows,
  totalRowCount: rows,
  resultSchema: [
    { name: "id", type: "int64" },
    { name: "value", type: "int64" },
  ],
  sampleRecords: Array.from({ length: rows }, (_, i) => ({ id: i + 1, value: (i + 1) * 10 })),
  ...extra,
});

describe("AgentInteractionComponent", () => {
  let fixture: ComponentFixture<AgentInteractionComponent>;
  let component: AgentInteractionComponent;
  let agentChangeSubject: Subject<void>;
  let summaries: BehaviorSubject<Map<string, OperatorResultSummary>>;
  let running: BehaviorSubject<ReadonlySet<string>>;
  let agentService: {
    agentChange$: ReturnType<Subject<void>["asObservable"]>;
    operatorResultSummaries$: ReturnType<BehaviorSubject<Map<string, OperatorResultSummary>>["asObservable"]>;
    runningOperators$: ReturnType<BehaviorSubject<ReadonlySet<string>>["asObservable"]>;
    getAllAgents: ReturnType<typeof vi.fn>;
    getActivelyConnectedAgentIds: ReturnType<typeof vi.fn>;
    isAgentActivelyConnected: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    getAgentStateObservable: ReturnType<typeof vi.fn>;
    runNativeOperator: ReturnType<typeof vi.fn>;
    editNativeOperator: ReturnType<typeof vi.fn>;
    getNativeStatementForm: ReturnType<typeof vi.fn>;
    getNativeCatalog: ReturnType<typeof vi.fn>;
    getReActStepsObservable: ReturnType<typeof vi.fn>;
  };
  let workflowActionService: {
    getTexeraGraph: ReturnType<typeof vi.fn>;
    getWorkflowMetadata: ReturnType<typeof vi.fn>;
  };
  let workflowResultService: {
    getResultUpdateStream: () => typeof EMPTY;
    getPaginatedResultService: ReturnType<typeof vi.fn>;
    getResultService: ReturnType<typeof vi.fn>;
  };
  let notification: Record<"success" | "error" | "info" | "warning", ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    agentChangeSubject = new Subject<void>();
    summaries = new BehaviorSubject(new Map());
    running = new BehaviorSubject<ReadonlySet<string>>(new Set());
    agentService = {
      agentChange$: agentChangeSubject.asObservable(),
      operatorResultSummaries$: summaries.asObservable(),
      runningOperators$: running.asObservable(),
      getAllAgents: vi.fn().mockReturnValue(of([])),
      getActivelyConnectedAgentIds: vi.fn().mockReturnValue([]),
      isAgentActivelyConnected: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      getAgentStateObservable: vi.fn().mockReturnValue(of(AgentState.AVAILABLE)),
      runNativeOperator: vi.fn(),
      editNativeOperator: vi.fn(),
      getNativeStatementForm: vi.fn().mockReturnValue(EMPTY),
      getNativeCatalog: vi.fn().mockReturnValue(of([])),
      getReActStepsObservable: vi.fn().mockReturnValue(EMPTY),
    };
    workflowActionService = {
      getTexeraGraph: vi.fn().mockReturnValue(graphWith()),
      // An unsaved workflow: the agents made without a workflow id are its.
      getWorkflowMetadata: vi.fn().mockReturnValue({ name: "untitled" }),
    };
    workflowResultService = {
      getResultUpdateStream: () => EMPTY,
      getPaginatedResultService: vi.fn().mockReturnValue(undefined),
      getResultService: vi.fn().mockReturnValue(undefined),
    };
    notification = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [AgentInteractionComponent, HttpClientTestingModule, NoopAnimationsModule],
      providers: [
        { provide: AgentService, useValue: agentService },
        { provide: WorkflowActionService, useValue: workflowActionService },
        { provide: WorkflowResultService, useValue: workflowResultService },
        { provide: NotificationService, useValue: notification },
        ...commonTestProviders,
      ],
    }).compileComponents();
  });

  function createComponent(
    inputs: Partial<Pick<AgentInteractionComponent, "operatorId" | "operatorDisplayName">> = {}
  ) {
    fixture = TestBed.createComponent(AgentInteractionComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput("operatorId", inputs.operatorId ?? "op-1");
    if (inputs.operatorDisplayName !== undefined)
      fixture.componentRef.setInput("operatorDisplayName", inputs.operatorDisplayName);
    fixture.detectChanges();
  }

  it("should create", () => {
    createComponent();
    expect(component).toBeTruthy();
  });

  describe("loadAvailableAgents (ngOnInit)", () => {
    it("maps agents and flags the actively connected ones", () => {
      agentService.getAllAgents.mockReturnValue(of([makeAgent("a1"), makeAgent("a2")]));
      agentService.getActivelyConnectedAgentIds.mockReturnValue(["a2"]);

      createComponent();

      // Newest first; made at the same time, the one listed later counts as newer.
      expect(component.availableAgents).toEqual([
        { id: "a2", name: "a2", isConnected: true },
        { id: "a1", name: "a1", isConnected: false },
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

    it("lists only the open workflow's agents, newest first", () => {
      const user = { uid: 1, name: "user", email: "user@example.com", role: "REGULAR" };
      workflowActionService.getWorkflowMetadata.mockReturnValue({ wid: 7 });
      const older = { ...makeAgent("older"), delegate: { userInfo: user, workflowId: 7 } };
      const newer = {
        ...makeAgent("newer"),
        createdAt: new Date("2026-02-01T00:00:00Z"),
        delegate: { userInfo: user, workflowId: 7 },
      };
      const elsewhere = { ...makeAgent("elsewhere"), delegate: { userInfo: user, workflowId: 8 } };
      agentService.getAllAgents.mockReturnValue(of([older, elsewhere, makeAgent("unbound"), newer]));

      createComponent();

      expect(agentService.getAllAgents).toHaveBeenCalledWith(7);
      expect(component.availableAgents.map(a => a.id)).toEqual(["newer", "older"]);
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

    it("falls back to 'this operator' when no name can be resolved", () => {
      component.operatorDisplayName = undefined;
      component.sendFeedbackToAgent();
      expect(agentService.sendMessage).toHaveBeenCalledWith(
        "a1",
        'Regarding operator "this operator" (ID: op-1): hello',
        "feedback"
      );
    });
  });

  describe("a native operator's panel", () => {
    /** The panel for `kept`, with one connected agent, as the canvas opens it. */
    function createNative(state = AgentState.AVAILABLE, initialMode: "actions" | "feedback" = "actions"): HTMLElement {
      workflowActionService.getTexeraGraph.mockReturnValue(graphWith([records, kept]));
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
    const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, " ").trim();

    it("names the operator, its doc, and offers Run, Edit, Feedback and Explain", () => {
      const element = createNative();
      expect(text(element.querySelector(".op-id"))).toBe("kept");
      expect(text(element.querySelector(".op-type"))).toBe("Filter");
      expect(text(element.querySelector(".op-doc"))).toBe("Keep the records over 15.");
      expect(element.querySelector(".op-icon")?.getAttribute("src")).toBe("assets/operator_images/Filter.png");
      expect(Array.from(element.querySelectorAll(".op-action")).map(text)).toEqual([
        "Run",
        "Edit",
        "Feedback",
        "Explain",
      ]);
      // One agent needs no picker, and the feedback box waits for Feedback.
      expect(element.querySelector(".header-row")).toBeNull();
      expect(element.querySelector(".op-feedback")).toBeNull();
    });

    it("lists its properties read-only: its statement at once, then the fields its edit form names", () => {
      const form = new Subject<NativeStatementForm>();
      agentService.getNativeStatementForm.mockReturnValue(form);
      const element = createNative();
      const properties = () =>
        Array.from(element.querySelectorAll(".property-list dt")).map(dt => [text(dt), text(dt.nextElementSibling)]);
      expect(properties()).toEqual([
        ["Inputs", "records"],
        ["Statement", "set kept: filter(records, lambda row: row['value'] > 15)"],
      ]);
      form.next(keptForm);
      fixture.detectChanges();
      expect(agentService.getNativeStatementForm).toHaveBeenCalledWith("a1", "kept");
      expect(properties()).toEqual([
        ["Input", "records"],
        ["Condition", "lambda row: row['value'] > 15"],
      ]);
    });

    it("shows the table it reads and the table it produces, a few records each, until the data is hidden", () => {
      summaries.next(
        new Map([
          ["records", table(6)],
          ["kept", table(4, { cached: true })],
        ])
      );
      const element = createNative();
      fixture.detectChanges();
      const blocks = Array.from(element.querySelectorAll(".data-block"));
      const head = (block: Element) =>
        [".data-role", ".data-source", ".data-badge", ".data-shape"].map(part => text(block.querySelector(part)) ?? "");
      expect(blocks.map(head)).toEqual([
        ["Input", "records", "", "6 rows · 2 columns"],
        ["Output", "", "cached", "4 rows · 2 columns"],
      ]);
      expect(blocks.map(block => block.querySelectorAll(".data-table tbody tr").length)).toEqual([3, 4]);
      expect(
        Array.from(blocks[0].querySelectorAll("th")).map(th => [
          text(th.querySelector(".column-name")),
          text(th.querySelector(".column-type")),
        ])
      ).toEqual([
        ["id", "int64"],
        ["value", "int64"],
      ]);
      expect(text(blocks[0].querySelector(".data-note"))).toBe("3 more rows");

      (element.querySelector(".section-toggle") as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(element.querySelectorAll(".data-block").length).toBe(0);
      expect(text(element.querySelector(".section-toggle .section-meta"))).toBe("4 rows · 2 columns");
    });

    it("says an operator is computing while the agent's run computes it, and why it failed", () => {
      const element = createNative();
      running.next(new Set(["kept"]));
      fixture.detectChanges();
      expect(text(element.querySelector(".data-output .data-note"))).toBe("Computing…");
      expect(text(element.querySelector(".data-input .data-note"))).toBe("Not computed yet. Run computes it.");

      const diagnostic = { operatorId: "records", message: "name 'pd' is not defined" };
      running.next(new Set());
      summaries.next(
        new Map([
          [
            "kept",
            {
              state: "Failed",
              inputTuples: 0,
              outputTuples: 0,
              error: `NATIVE_ERROR_V2:${JSON.stringify(diagnostic)}`,
            },
          ],
        ])
      );
      fixture.detectChanges();
      expect(text(element.querySelector(".data-output .data-error"))).toBe("records failed: name 'pd' is not defined");
    });

    it("runs the operator through its agent and says the agent sees the run", () => {
      agentService.runNativeOperator.mockReturnValue(
        of({ status: "ok", userAction: { kind: "run", operatorId: "kept", status: "ok", rows: 2 } })
      );
      const element = createNative();
      button(element, "Run").click();
      fixture.detectChanges();
      expect(agentService.runNativeOperator).toHaveBeenCalledWith("a1", "kept");
      expect(text(element.querySelector(".op-status"))).toBe("Bob sees your run.");
    });

    it("says why a run failed", () => {
      agentService.runNativeOperator.mockReturnValue(
        throwError(() => new HttpErrorResponse({ status: 409, error: { error: "The agent is working." } }))
      );
      const element = createNative();
      button(element, "Run").click();
      fixture.detectChanges();
      expect(text(element.querySelector(".op-error"))).toBe("The agent is working.");
    });

    it("waits while the agent works", () => {
      const element = createNative(AgentState.GENERATING);
      expect(button(element, "Run").disabled).toBe(true);
      expect(button(element, "Edit").disabled).toBe(true);
      expect(button(element, "Feedback").disabled).toBe(false);
      expect(element.querySelector(".op-status")?.textContent).toContain("Bob is working");
    });

    it("opens the editor for Edit, and after a save is back on the operator, saying the agent reads the change", () => {
      const element = createNative();
      button(element, "Edit").click();
      fixture.detectChanges();
      const editor = fixture.debugElement.query(
        debug => debug.componentInstance instanceof NativeOperatorEditorComponent
      );
      expect(editor.componentInstance.agentId).toBe("a1");
      expect(editor.componentInstance.operatorId).toBe("kept");
      expect(element.querySelector(".op-data")).toBeNull();

      component.onSaved({ status: "ok", userAction: { kind: "edit", operatorId: "kept", status: "ok", version: 6 } });
      fixture.detectChanges();
      expect(element.querySelector(".op-data")).not.toBeNull();
      expect(text(element.querySelector(".op-status"))).toBe("Saved as v6. Bob reads your change at its next turn.");
    });

    it("sends feedback that names the operator by its id; the chat button opens the feedback box", () => {
      const element = createNative(AgentState.AVAILABLE, "feedback");
      expect(element.querySelector(".op-feedback .feedback-input")).not.toBeNull();
      component.feedbackMessage = "Use 20 instead.";
      component.sendFeedbackToAgent();
      expect(agentService.sendMessage).toHaveBeenCalledWith("a1", "Feedback on `kept`: Use 20 instead.", "feedback");
      fixture.detectChanges();
      expect(text(element.querySelector(".op-status"))).toBe("Sent to Bob; the reply is in the chat.");
    });

    it("asks its agent to explain it, with its result, and shows the reply under the actions", () => {
      const steps = new BehaviorSubject<ReActStep[]>([]);
      agentService.getReActStepsObservable.mockReturnValue(steps);
      const element = createNative();
      button(element, "Explain").click();
      fixture.detectChanges();
      const request = explainRequest("kept", ["records"]);
      expect(agentService.sendMessage).toHaveBeenCalledWith("a1", request, "feedback");
      expect(request).toMatch(
        /^Explain `kept`\. First see whether it has a result: look at it, and if it has none yet, run it\./
      );
      expect(request).toContain("computed from its input `records`");
      expect(request).toContain("use the result in the explanation");
      expect(text(element.querySelector(".op-explanation-pending"))).toBe("Bob is explaining…");
      const step = (id: string, role: "user" | "agent", content: string, toolCalls?: unknown[]) =>
        ({
          id,
          role,
          content,
          toolCalls,
          isBegin: true,
          isEnd: true,
          messageId: "m",
          stepId: 0,
        }) as unknown as ReActStep;
      steps.next([
        step("u1", "user", request),
        step("a1", "agent", "", [{ toolName: "dataflow" }]),
        step("a2", "agent", "kept keeps 2 of its 3 records: 20 and 30."),
      ]);
      fixture.detectChanges();
      expect(element.querySelector(".op-explanation-pending")).toBeNull();
      expect(component.explanation).toMatchObject({
        pending: false,
        text: "kept keeps 2 of its 3 records: 20 and 30.",
      });
      expect(element.querySelector(".op-explanation")).not.toBeNull();
    });

    it("closes from its close button", () => {
      const element = createNative();
      const closed = vi.fn();
      component.closed.subscribe(closed);
      (element.querySelector(".op-close") as HTMLButtonElement).click();
      expect(closed).toHaveBeenCalled();
    });
  });

  describe("a Texera operator's panel", () => {
    it("lists its properties and shows a Texera run's first records when no agent ran it", () => {
      const scan = {
        operatorID: "scan",
        operatorType: "CSVFileScan",
        operatorProperties: { fileName: "a.csv", limit: 10 },
      };
      workflowActionService.getTexeraGraph.mockReturnValue(graphWith([scan]));
      workflowResultService.getPaginatedResultService.mockReturnValue({
        selectPage: () =>
          of({
            table: [{ a: 1 }, { a: 2 }],
            schema: [{ attributeName: "a", attributeType: "integer" }],
          }),
        getCurrentTotalNumTuples: () => 9,
      });
      createComponent({ operatorId: "scan" });
      const element = fixture.nativeElement as HTMLElement;
      expect(
        Array.from(element.querySelectorAll(".property-list dt")).map(dt => [
          dt.textContent?.trim(),
          dt.nextElementSibling?.textContent?.trim(),
        ])
      ).toEqual([
        ["File Name", "a.csv"],
        ["Limit", "10"],
      ]);
      expect(element.querySelector(".op-actions")).toBeNull();
      expect(element.querySelector(".data-output .data-shape")?.textContent?.trim()).toBe("9 rows · 1 column");
      expect(element.querySelectorAll(".data-output .data-table tbody tr").length).toBe(2);
    });
  });
});
