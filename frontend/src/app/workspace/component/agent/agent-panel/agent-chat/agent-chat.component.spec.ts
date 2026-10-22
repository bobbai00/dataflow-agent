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

import { ApplicationRef } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { NzModalService } from "ng-zorro-antd/modal";
import { MarkdownModule } from "ngx-markdown";
import { BehaviorSubject, Observable, Subject, of, throwError } from "rxjs";
import { AgentChatComponent } from "./agent-chat.component";
import { AgentInfo, AgentService, AgentSettingsApi } from "../../../../service/agent/agent.service";
import { AgentState, ReActStep, ToolOperatorAccess } from "../../../../service/agent/agent-types";
import { WorkflowActionService } from "../../../../service/workflow-graph/model/workflow-action.service";
import { NotificationService } from "../../../../../common/service/notification/notification.service";
import { WorkflowPersistService } from "../../../../../common/service/workflow-persist/workflow-persist.service";
import { AgentFileUpload, AgentFileUploadService } from "../../../../service/agent/agent-file-upload.service";
import { Workflow } from "../../../../../common/type/workflow";
import { commonTestProviders } from "../../../../../common/testing/test-utils";

const AGENT_ID = "agent-1";

/**
 * Subject-backed double of AgentService. The component's ngOnInit subscribes to
 * the state / steps / HEAD / workflow streams, so each test drives behavior by
 * calling `next(...)` on the corresponding subject — mirroring how the real
 * service pushes WebSocket updates through BehaviorSubjects.
 */
class MockAgentService {
  public stateSubject = new BehaviorSubject<AgentState>(AgentState.AVAILABLE);
  public stepsSubject = new BehaviorSubject<ReActStep[]>([]);
  public headIdSubject = new BehaviorSubject<string | null>(null);
  public workflowSubject = new BehaviorSubject<Workflow | null>(null);
  public scrollToStepSubject = new Subject<{ agentId: string; messageId: string; stepId: number }>();
  public scrollToStep$ = this.scrollToStepSubject.asObservable();

  public ensureWorkflowPolling = vi.fn();
  public checkoutStep = vi.fn((): Observable<unknown> => of({ status: "checked out" }));
  public nextContextSubject = new BehaviorSubject<string>("");
  public getNextContextObservable = vi.fn((): Observable<string> => this.nextContextSubject.asObservable());
  public getSnapshotTree = vi.fn((): Observable<{ rootId: string; nodes: unknown[] }> => of({ rootId: "", nodes: [] }));
  public importReActSteps = vi.fn((): Observable<unknown> => of({ headId: "h", importedCount: 0 }));
  public sendDebugInput = vi.fn();
  public getAgentState = vi.fn((): Observable<AgentState> => of(this.stateSubject.getValue()));
  public getAgentStateObservable = vi.fn((): Observable<AgentState> => this.stateSubject.asObservable());
  public getReActStepsObservable = vi.fn((): Observable<ReActStep[]> => this.stepsSubject.asObservable());
  public getHeadIdObservable = vi.fn((): Observable<string | null> => this.headIdSubject.asObservable());
  public getWorkflowObservable = vi.fn((): Observable<Workflow | null> => this.workflowSubject.asObservable());
  public setHoveredMessage = vi.fn();
  public sendMessage = vi.fn();
  public stopGeneration = vi.fn();
  public clearMessages = vi.fn();
  public getReActSteps = vi.fn((): Observable<ReActStep[]> => of([]));
  public getSystemInfo = vi.fn(
    (): Observable<{
      systemPrompt: string;
      tools: Array<{ name: string; description: string; inputSchema: any; enabled: boolean }>;
    }> => of({ systemPrompt: "", tools: [] })
  );
  public getAgentSettings = vi.fn((): Observable<AgentSettingsApi> => of({}));
  public updateAgentSettings = vi.fn(
    (_agentId: string, settings: Partial<AgentSettingsApi>): Observable<AgentSettingsApi> =>
      of(settings as AgentSettingsApi)
  );
}

function makeAgentInfo(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: AGENT_ID,
    name: "Test Agent",
    modelType: "gpt-test",
    isBaselineMode: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeStep(overrides: Partial<ReActStep> = {}): ReActStep {
  const messageId = overrides.messageId ?? "m1";
  const stepId = overrides.stepId ?? 0;
  return {
    messageId,
    stepId,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    role: "agent",
    content: "step content",
    isBegin: false,
    isEnd: false,
    id: `${messageId}-${stepId}`,
    ...overrides,
  };
}

describe("AgentChatComponent", () => {
  let fixture: ComponentFixture<AgentChatComponent>;
  let component: AgentChatComponent;
  let agentService: MockAgentService;
  let reloadWorkflow: ReturnType<typeof vi.fn>;
  let notification: Record<"success" | "error" | "warning" | "info", ReturnType<typeof vi.fn>>;
  let persist: { setWorkflowPersistFlag: ReturnType<typeof vi.fn> };
  let fileUpload: { uploadFiles: ReturnType<typeof vi.fn> };
  let uploadSubject: Subject<AgentFileUpload>;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;
  // Originals of the globals we overwrite below, captured so afterEach can restore them
  // (direct assignment is not undone by vi.restoreAllMocks, so they would leak across spec files).
  let origScrollIntoView: typeof Element.prototype.scrollIntoView;
  let origCreateObjectURL: typeof URL.createObjectURL;
  let origRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(async () => {
    // jsdom gaps: Element#scrollIntoView and URL.createObjectURL/revokeObjectURL
    // are not implemented; the component calls them from scrollToMessage and
    // exportReActSteps.
    origScrollIntoView = Element.prototype.scrollIntoView;
    origCreateObjectURL = URL.createObjectURL;
    origRevokeObjectURL = URL.revokeObjectURL;
    scrollIntoViewMock = vi.fn();
    (Element.prototype as any).scrollIntoView = scrollIntoViewMock;
    createObjectURL = vi.fn(() => "blob:mock-url");
    revokeObjectURL = vi.fn();
    (URL as any).createObjectURL = createObjectURL;
    (URL as any).revokeObjectURL = revokeObjectURL;

    agentService = new MockAgentService();
    reloadWorkflow = vi.fn();
    notification = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
    persist = { setWorkflowPersistFlag: vi.fn() };
    uploadSubject = new Subject<AgentFileUpload>();
    fileUpload = { uploadFiles: vi.fn(() => uploadSubject.asObservable()) };

    await TestBed.configureTestingModule({
      // MarkdownModule.forRoot() backs the <markdown> elements in the chat
      // bubbles and the system-prompt tab (same wiring as AppModule).
      imports: [AgentChatComponent, HttpClientTestingModule, NoopAnimationsModule, MarkdownModule.forRoot()],
      providers: [
        // The declarative <nz-modal> delegates opening to NzModalService.create(),
        // so the real service is required to render the system-info modal.
        NzModalService,
        { provide: AgentService, useValue: agentService },
        { provide: WorkflowActionService, useValue: { reloadWorkflow } },
        { provide: NotificationService, useValue: notification },
        { provide: WorkflowPersistService, useValue: persist },
        { provide: AgentFileUploadService, useValue: fileUpload },
        ...commonTestProviders,
      ],
    }).compileComponents();
  });

  afterEach(() => {
    // Some tests destroy the fixture themselves; guard against a double-destroy.
    try {
      fixture?.destroy();
    } catch {
      // already destroyed
    }
    fixture = undefined as unknown as ComponentFixture<AgentChatComponent>;
    // The system-info modal renders into the CDK overlay attached to document.body.
    // Clear its contents (rather than removing the container) so document-level queries
    // stay test-local without detaching the element CDK's OverlayContainer caches.
    document.querySelectorAll(".cdk-overlay-container").forEach(el => (el.innerHTML = ""));
    // Restore the globals overwritten by direct assignment in beforeEach.
    Element.prototype.scrollIntoView = origScrollIntoView;
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    vi.restoreAllMocks();
  });

  function createComponent(agentInfo: AgentInfo = makeAgentInfo(), isActive = false): AgentChatComponent {
    fixture = TestBed.createComponent(AgentChatComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput("agentInfo", agentInfo);
    fixture.componentRef.setInput("isActive", isActive);
    fixture.detectChanges();
    return component;
  }

  describe("ngOnInit workflow polling", () => {
    it("ensures workflow polling when the agent delegate carries a workflowId", () => {
      createComponent(
        makeAgentInfo({
          delegate: {
            userInfo: { uid: 1, name: "user", email: "user@example.com", role: "REGULAR" },
            workflowId: 42,
          },
        })
      );
      expect(agentService.ensureWorkflowPolling).toHaveBeenCalledWith(AGENT_ID, 42);
    });

    it("does not start polling when there is no delegate", () => {
      createComponent();
      expect(agentService.ensureWorkflowPolling).not.toHaveBeenCalled();
    });
  });

  describe("auto-persist toggling on state transitions", () => {
    it("disables persistence when generation starts and re-enables when it finishes", () => {
      createComponent();
      // Initial AVAILABLE (paired with the startWith(UNAVAILABLE) seed) must not touch the flag.
      expect(persist.setWorkflowPersistFlag).not.toHaveBeenCalled();

      agentService.stateSubject.next(AgentState.GENERATING);
      expect(persist.setWorkflowPersistFlag).toHaveBeenNthCalledWith(1, false);

      // A repeated GENERATING emission must not re-disable.
      agentService.stateSubject.next(AgentState.GENERATING);
      expect(persist.setWorkflowPersistFlag).toHaveBeenCalledTimes(1);

      agentService.stateSubject.next(AgentState.AVAILABLE);
      expect(persist.setWorkflowPersistFlag).toHaveBeenNthCalledWith(2, true);
      expect(persist.setWorkflowPersistFlag).toHaveBeenCalledTimes(2);
    });

    it("re-enables persistence when STOPPING resolves to AVAILABLE", () => {
      createComponent();
      agentService.stateSubject.next(AgentState.GENERATING);
      agentService.stateSubject.next(AgentState.STOPPING);
      expect(persist.setWorkflowPersistFlag).toHaveBeenCalledTimes(1); // only the disable so far

      agentService.stateSubject.next(AgentState.AVAILABLE);
      expect(persist.setWorkflowPersistFlag).toHaveBeenLastCalledWith(true);
    });

    it("re-enables persistence on destroy if it was left disabled", () => {
      createComponent();
      agentService.stateSubject.next(AgentState.GENERATING);
      expect(persist.setWorkflowPersistFlag).toHaveBeenCalledWith(false);

      fixture.destroy();
      expect(persist.setWorkflowPersistFlag).toHaveBeenLastCalledWith(true);
      expect(persist.setWorkflowPersistFlag).toHaveBeenCalledTimes(2);
    });

    it("does not touch the flag on destroy when it was never disabled", () => {
      createComponent();
      fixture.destroy();
      expect(persist.setWorkflowPersistFlag).not.toHaveBeenCalled();
    });
  });

  describe("step subscription and hovered-message tracking", () => {
    it("leaves the canvas highlight alone on new emissions", () => {
      createComponent();
      const steps = [makeStep({ stepId: 0 }), makeStep({ stepId: 1 }), makeStep({ stepId: 2 })];
      agentService.stepsSubject.next(steps);

      expect(component.agentResponses).toEqual(steps);
      // Highlighting follows the pointer only — arriving steps never claim it.
      expect(component.hoveredMessageIndex).toBeNull();
      expect(agentService.setHoveredMessage).not.toHaveBeenCalled();
    });

    it("keeps a manually hovered non-latest step across the next emission", () => {
      createComponent();
      const steps = [makeStep({ stepId: 0 }), makeStep({ stepId: 1 }), makeStep({ stepId: 2 })];
      agentService.stepsSubject.next(steps);

      component.setHoveredMessage(0);
      expect(agentService.setHoveredMessage).toHaveBeenLastCalledWith(AGENT_ID, steps[0]);

      agentService.stepsSubject.next([...steps, makeStep({ stepId: 3 })]);
      expect(component.hoveredMessageIndex).toBe(0);
    });

    it("keeps a hover on the latest step across the next emission", () => {
      createComponent();
      const steps = [makeStep({ stepId: 0 }), makeStep({ stepId: 1 })];
      agentService.stepsSubject.next(steps);
      component.setHoveredMessage(1);

      agentService.stepsSubject.next([...steps, makeStep({ stepId: 2 })]);
      expect(component.hoveredMessageIndex).toBe(1);
      expect(agentService.setHoveredMessage).toHaveBeenLastCalledWith(AGENT_ID, steps[1]);
    });

    it("clears the highlight when unhovered (null)", () => {
      createComponent();
      const steps = [makeStep({ stepId: 0 }), makeStep({ stepId: 1 }), makeStep({ stepId: 2 })];
      agentService.stepsSubject.next(steps);
      component.setHoveredMessage(0);

      component.setHoveredMessage(null);
      expect(component.hoveredMessageIndex).toBeNull();
      expect(agentService.setHoveredMessage).toHaveBeenLastCalledWith(AGENT_ID, null);
    });

    it("drops a hover left dangling past the end of the visible steps", () => {
      createComponent();
      const steps = [makeStep({ stepId: 0 }), makeStep({ stepId: 1 }), makeStep({ stepId: 2 })];
      agentService.stepsSubject.next(steps);
      component.setHoveredMessage(2);

      agentService.stepsSubject.next([steps[0]]);
      expect(component.hoveredMessageIndex).toBeNull();
      expect(agentService.setHoveredMessage).toHaveBeenLastCalledWith(AGENT_ID, null);
    });
  });

  describe("canvas actions in the chat", () => {
    const action = (userAction: Partial<NonNullable<ReActStep["userAction"]>>, id = "act") =>
      makeStep({
        messageId: id,
        stepId: 0,
        id,
        role: "user",
        isBegin: true,
        isEnd: true,
        messageSource: "action",
        content: "I edited `kept` on the canvas. Its definition is now:\nset kept: filter(records, lambda row: True)",
        toolCalls: [{ toolName: "dataflow", toolCallId: "t", input: {} }],
        userAction: { kind: "edit", operatorId: "kept", status: "ok", ...userAction },
      });

    it("shows a user's edit or run as one row on the user's side, not as an agent action", () => {
      createComponent();
      agentService.stepsSubject.next([
        makeStep({ stepId: 0, role: "user", content: "hi", isBegin: true }),
        action({ run: true, rows: 1 }),
        action({ kind: "run", rows: 2 }, "act2"),
      ]);
      fixture.detectChanges();
      expect(component.chatItems.map(item => item.kind)).toEqual(["message", "action", "action"]);
      const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll(".user-action-text")).map(row =>
        row.textContent?.trim()
      );
      expect(rows).toEqual(["You edited `kept` and ran it · 1 row", "You ran `kept` · 2 rows"]);
    });

    it("shows a running action on its row instead of the agent thinking, and opens what the agent reads", () => {
      createComponent();
      agentService.stepsSubject.next([action({ kind: "run", status: "running" })]);
      agentService.stateSubject.next(AgentState.GENERATING);
      fixture.detectChanges();
      const element = fixture.nativeElement as HTMLElement;
      expect(element.querySelector(".user-action-text")?.textContent?.trim()).toBe("Running `kept`…");
      expect(element.querySelector(".loading-message")).toBeNull();

      (element.querySelector(".user-action-toggle") as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(element.querySelector(".user-action-details")?.textContent).toContain("I edited `kept` on the canvas.");
    });

    it("marks a failed action", () => {
      createComponent();
      agentService.stepsSubject.next([action({ status: "error", error: "boom" })]);
      fixture.detectChanges();
      const element = fixture.nativeElement as HTMLElement;
      expect(element.querySelector(".user-action-text")?.textContent?.trim()).toBe("You edited `kept`; it failed");
      expect(element.querySelector(".user-action.user-action-error")).not.toBeNull();
    });
  });

  describe("HEAD-path filtering of visible steps", () => {
    it("shows only the root-to-HEAD ancestor chain when a HEAD is set", () => {
      createComponent();
      const a = makeStep({ messageId: "m1", stepId: 0, id: "a" });
      const b = makeStep({ messageId: "m1", stepId: 1, id: "b", parentId: "a" });
      const c = makeStep({ messageId: "m1", stepId: 2, id: "c", parentId: "b" });
      const d = makeStep({ messageId: "m2", stepId: 0, id: "d", parentId: "a" }); // branch off "a"
      agentService.stepsSubject.next([a, b, c, d]);

      // No HEAD yet: everything is visible.
      expect(component.visibleSteps.map(s => s.id)).toEqual(["a", "b", "c", "d"]);

      // HEAD at mid-chain "b": only the a -> b path remains.
      agentService.headIdSubject.next("b");
      expect(component.visibleSteps.map(s => s.id)).toEqual(["a", "b"]);

      // Clearing HEAD restores all steps.
      agentService.headIdSubject.next(null);
      expect(component.visibleSteps.map(s => s.id)).toEqual(["a", "b", "c", "d"]);
    });
  });

  describe("workflow reload while the tab is active", () => {
    const wfA = { wid: 42, name: "wf", content: { operators: [{ operatorID: "op-1" }] } } as unknown as Workflow;

    it("reloads on activation, deduplicates identical content, and stops when deactivated", () => {
      createComponent(makeAgentInfo(), false);

      // Inactive: workflow emissions are ignored.
      agentService.workflowSubject.next(wfA);
      expect(reloadWorkflow).not.toHaveBeenCalled();

      // Activating subscribes and replays the latest workflow.
      fixture.componentRef.setInput("isActive", true);
      fixture.detectChanges();
      expect(reloadWorkflow).toHaveBeenCalledTimes(1);
      expect(reloadWorkflow).toHaveBeenCalledWith(wfA, false, false);

      // A different object with JSON-identical content is suppressed.
      agentService.workflowSubject.next(JSON.parse(JSON.stringify(wfA)) as Workflow);
      expect(reloadWorkflow).toHaveBeenCalledTimes(1);

      // Content change goes through.
      const wfB = { ...wfA, content: { operators: [] } } as unknown as Workflow;
      agentService.workflowSubject.next(wfB);
      expect(reloadWorkflow).toHaveBeenCalledTimes(2);

      // Deactivating stops the subscription; later emissions do not reload.
      fixture.componentRef.setInput("isActive", false);
      fixture.detectChanges();
      agentService.workflowSubject.next({
        ...wfA,
        content: { operators: [{ operatorID: "op-2" }] },
      } as unknown as Workflow);
      expect(reloadWorkflow).toHaveBeenCalledTimes(2);
    });
  });

  describe("sendMessage / onEnterPress", () => {
    it("ignores whitespace-only input", () => {
      createComponent();
      component.currentMessage = "   ";
      component.sendMessage();
      expect(agentService.sendMessage).not.toHaveBeenCalled();
      expect(component.currentMessage).toBe("   ");
    });

    it("does not send while the agent is not AVAILABLE", () => {
      createComponent();
      agentService.stateSubject.next(AgentState.GENERATING);
      component.currentMessage = "hello";
      component.sendMessage();
      expect(agentService.sendMessage).not.toHaveBeenCalled();
      expect(component.currentMessage).toBe("hello");
    });

    it("sends the trimmed text and clears the input", () => {
      createComponent();
      component.currentMessage = "  hello world  ";
      component.sendMessage();
      expect(agentService.sendMessage).toHaveBeenCalledWith(AGENT_ID, "hello world");
      expect(component.currentMessage).toBe("");
    });

    it("Enter sends the message and prevents the default newline", () => {
      createComponent();
      component.currentMessage = "hi";
      const event = new KeyboardEvent("keydown", { key: "Enter" });
      const preventDefault = vi.spyOn(event, "preventDefault");
      component.onEnterPress(event);
      expect(preventDefault).toHaveBeenCalled();
      expect(agentService.sendMessage).toHaveBeenCalledWith(AGENT_ID, "hi");
    });

    it("Shift+Enter inserts a newline instead of sending", () => {
      createComponent();
      component.currentMessage = "hi";
      const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true });
      const preventDefault = vi.spyOn(event, "preventDefault");
      component.onEnterPress(event);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(agentService.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("state display helpers", () => {
    const cases: ReadonlyArray<[AgentState, string, string, string]> = [
      [AgentState.AVAILABLE, "check-circle", "#52c41a", "Agent is ready"],
      [AgentState.GENERATING, "sync", "#1890ff", "Agent is generating response..."],
      [AgentState.STOPPING, "sync", "#1890ff", "Agent is stopping..."],
      [AgentState.UNAVAILABLE, "close-circle", "#ff4d4f", "Agent is unavailable"],
    ];

    cases.forEach(([state, icon, color, tooltip]) => {
      it(`maps ${state} to icon "${icon}", color "${color}" and its tooltip`, () => {
        createComponent();
        agentService.stateSubject.next(state);
        expect(component.getStateIcon()).toBe(icon);
        expect(component.getStateIconColor()).toBe(color);
        expect(component.getStateTooltip()).toBe(tooltip);
      });
    });

    it("reports the per-state boolean flags", () => {
      createComponent();

      agentService.stateSubject.next(AgentState.AVAILABLE);
      expect(component.canSendMessage()).toBe(true);
      expect(component.isAvailable()).toBe(true);
      expect(component.isConnected()).toBe(true);
      expect(component.isGenerating()).toBe(false);
      expect(component.isStopping()).toBe(false);

      agentService.stateSubject.next(AgentState.GENERATING);
      expect(component.canSendMessage()).toBe(false);
      expect(component.isGenerating()).toBe(true);
      expect(component.isConnected()).toBe(true);

      agentService.stateSubject.next(AgentState.STOPPING);
      expect(component.isStopping()).toBe(true);
      expect(component.isConnected()).toBe(true);

      agentService.stateSubject.next(AgentState.UNAVAILABLE);
      expect(component.isConnected()).toBe(false);
      expect(component.canSendMessage()).toBe(false);
    });

    it("falls back to the unknown-status tooltip for an unrecognized state", () => {
      createComponent();
      (component as any).agentState = "Bogus";
      expect(component.getStateTooltip()).toBe("Agent status unknown");
      expect(component.getStateIcon()).toBe("close-circle");
      expect(component.getStateIconColor()).toBe("#ff4d4f");
    });
  });

  describe("tool result and operator-access helpers", () => {
    it("prefers output, then result, then the raw entry", () => {
      createComponent();
      const step = makeStep({ toolResults: [{ output: "out" }, { result: "res" }, { other: 1 }] });
      expect(component.getToolResult(step, 0)).toBe("out");
      expect(component.getToolResult(step, 1)).toBe("res");
      expect(component.getToolResult(step, 2)).toEqual({ other: 1 });
    });

    it("returns null for missing tool results or an out-of-range index", () => {
      createComponent();
      expect(component.getToolResult(makeStep(), 0)).toBeNull();
      expect(component.getToolResult(makeStep({ toolResults: [{ output: "x" }] }), 5)).toBeNull();
    });

    it("resolves per-tool-call operator access from the map", () => {
      createComponent();
      const access: ToolOperatorAccess = {
        viewedOperatorIds: ["op-v"],
        addedOperatorIds: [],
        modifiedOperatorIds: ["op-m"],
      };
      const step = makeStep({ operatorAccess: new Map([[0, access]]) });
      expect(component.getToolOperatorAccess(step, 0)).toBe(access);
      expect(component.getToolOperatorAccess(step, 1)).toBeNull();
      expect(component.hasOperatorAccess(step)).toBe(true);
    });

    it("reports no operator access for a missing or empty map", () => {
      createComponent();
      expect(component.getToolOperatorAccess(makeStep(), 0)).toBeNull();
      expect(component.hasOperatorAccess(makeStep())).toBe(false);
      expect(component.hasOperatorAccess(makeStep({ operatorAccess: new Map() }))).toBe(false);
    });
  });

  describe("showSystemInfo / refreshSystemInfo", () => {
    it("populates prompt and tools and applies default settings", () => {
      createComponent();
      const tool = { name: "dataflow", description: "Builds the dataflow", inputSchema: {}, enabled: true };
      agentService.getSystemInfo.mockReturnValue(of({ systemPrompt: "SYSTEM PROMPT TEXT", tools: [tool] }));
      agentService.getAgentSettings.mockReturnValue(of({}));

      component.showSystemInfo();

      expect(component.isSystemInfoModalVisible).toBe(true);
      expect(component.systemPrompt).toBe("SYSTEM PROMPT TEXT");
      expect(component.availableTools).toEqual([tool]);
      // ?? defaults for a settings payload with no fields set:
      expect(component.settingsMaxCharLimit).toBe(20000);
      expect(component.settingsMaxCellCharLimit).toBe(4000);
      expect(component.settingsToolTimeoutSeconds).toBe(120);
      expect(component.settingsExecutionTimeoutMinutes).toBe(10);
      expect(component.settingsMaxSteps).toBe(10);
      expect(component.settingsAgentMode).toBe("native");
      // agent-service defaults: dataEvidence on, flowEvidence and operatorDoc off
      expect(component.settingsDataEvidence).toBe("enabled");
      expect(component.settingsFlowEvidence).toBe("disabled");
      expect(component.settingsOperatorDoc).toBe("disabled");
    });

    it("applies explicit settings values from the server", () => {
      createComponent();
      agentService.getAgentSettings.mockReturnValue(
        of({
          maxOperatorResultCharLimit: 111,
          maxOperatorResultCellCharLimit: 222,
          toolTimeoutSeconds: 33,
          executionTimeoutMinutes: 4,
          maxSteps: 5,
          agentMode: "code",
          dataEvidence: false,
          flowEvidence: true,
          operatorDoc: true,
        })
      );

      component.showSystemInfo();

      expect(component.settingsMaxCharLimit).toBe(111);
      expect(component.settingsMaxCellCharLimit).toBe(222);
      expect(component.settingsToolTimeoutSeconds).toBe(33);
      expect(component.settingsExecutionTimeoutMinutes).toBe(4);
      expect(component.settingsMaxSteps).toBe(5);
      expect(component.settingsAgentMode).toBe("code");
      expect(component.settingsDataEvidence).toBe("disabled");
      expect(component.settingsFlowEvidence).toBe("enabled");
      expect(component.settingsOperatorDoc).toBe("enabled");
    });

    it("closeSystemInfoModal hides the modal", () => {
      createComponent();
      component.showSystemInfo();
      component.closeSystemInfoModal();
      expect(component.isSystemInfoModalVisible).toBe(false);
    });
  });

  describe("settings save methods", () => {
    const saveCases = [
      {
        method: "saveMaxCharLimit",
        prop: "settingsMaxCharLimit",
        key: "maxOperatorResultCharLimit",
        value: 31000,
        toast: "Max character limit saved",
      },
      {
        method: "saveMaxCellCharLimit",
        prop: "settingsMaxCellCharLimit",
        key: "maxOperatorResultCellCharLimit",
        value: 512,
        toast: "Max cell character limit saved",
      },
      {
        method: "saveToolTimeout",
        prop: "settingsToolTimeoutSeconds",
        key: "toolTimeoutSeconds",
        value: 90,
        toast: "Tool timeout saved",
      },
      {
        method: "saveExecutionTimeout",
        prop: "settingsExecutionTimeoutMinutes",
        key: "executionTimeoutMinutes",
        value: 5,
        toast: "Execution timeout saved",
      },
      {
        method: "saveMaxSteps",
        prop: "settingsMaxSteps",
        key: "maxSteps",
        value: 25,
        toast: "Max steps saved",
      },
    ] as const;

    saveCases.forEach(({ method, prop, key, value, toast }) => {
      it(`${method} sends only { ${key} } and toasts "${toast}"`, () => {
        createComponent();
        (component as any)[prop] = value;
        (component as any)[method]();
        expect(agentService.updateAgentSettings).toHaveBeenCalledTimes(1);
        expect(agentService.updateAgentSettings).toHaveBeenCalledWith(AGENT_ID, { [key]: value });
        expect(notification.success).toHaveBeenCalledWith(toast);
      });
    });

    // The evidence selects replace the retired Column Stats control, whose
    // `columnStats` PATCH the agent-service rejects with a 400.
    const evidenceCases = [
      { method: "saveDataEvidence", prop: "settingsDataEvidence", key: "dataEvidence", toast: "Data evidence" },
      { method: "saveFlowEvidence", prop: "settingsFlowEvidence", key: "flowEvidence", toast: "Flow evidence" },
      { method: "saveOperatorDoc", prop: "settingsOperatorDoc", key: "operatorDoc", toast: "Operator doc" },
    ] as const;

    evidenceCases.forEach(({ method, prop, key, toast }) => {
      it(`${method} sends only { ${key} } as a boolean and toasts the new state`, () => {
        createComponent();
        (component as any)[prop] = "disabled";
        (component as any)[method]();
        expect(agentService.updateAgentSettings).toHaveBeenLastCalledWith(AGENT_ID, { [key]: false });
        expect(notification.success).toHaveBeenLastCalledWith(`${toast} disabled`);

        (component as any)[prop] = "enabled";
        (component as any)[method]();
        expect(agentService.updateAgentSettings).toHaveBeenLastCalledWith(AGENT_ID, { [key]: true });
        expect(notification.success).toHaveBeenLastCalledWith(`${toast} enabled`);
      });
    });

    it("stays silent when the settings update errors (service already notified)", () => {
      createComponent();
      agentService.updateAgentSettings.mockReturnValue(throwError(() => new Error("nope")));
      component.saveMaxCharLimit();
      expect(notification.success).not.toHaveBeenCalled();
    });
  });

  describe("exportReActSteps", () => {
    it("warns and skips the fetch when there is nothing to export", () => {
      createComponent();
      // Exercise the template binding too: locate the export button by its tooltip
      // rather than by position (the toolbar also has play/import buttons).
      const exportButton = fixture.nativeElement.querySelector(
        '.chat-toolbar button[nztooltiptitle="Export ReAct steps as JSON"]'
      ) as HTMLButtonElement;
      exportButton.click();
      expect(notification.warning).toHaveBeenCalledWith("No ReAct steps to export");
      expect(agentService.getReActSteps).not.toHaveBeenCalled();
    });

    it("downloads fetched steps as JSON with operatorAccess flattened to a plain object", async () => {
      createComponent();
      const step = makeStep({
        operatorAccess: new Map([
          [0, { viewedOperatorIds: ["op-1"], addedOperatorIds: [], modifiedOperatorIds: ["op-2"] }],
        ]),
      });
      agentService.stepsSubject.next([step]);
      agentService.getReActSteps.mockReturnValue(of([step]));
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

      component.exportReActSteps();

      expect(agentService.getReActSteps).toHaveBeenCalledWith(AGENT_ID);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0][0] as Blob;
      // jsdom's Blob has no .text(); read the contents with a FileReader instead.
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });
      const exported = JSON.parse(text);
      expect(exported.agentId).toBe(AGENT_ID);
      expect(exported.agentName).toBe("Test Agent");
      expect(exported.modelType).toBe("gpt-test");
      expect(exported.stepCount).toBe(1);
      expect(exported.steps[0].operatorAccess).toEqual({
        "0": { viewedOperatorIds: ["op-1"], addedOperatorIds: [], modifiedOperatorIds: ["op-2"] },
      });
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
      expect(notification.success).toHaveBeenCalledWith("Exported 1 ReAct steps");
    });

    it("shows an error toast when the fetch fails", () => {
      createComponent();
      agentService.stepsSubject.next([makeStep()]);
      agentService.getReActSteps.mockReturnValue(throwError(() => new Error("boom")));
      vi.spyOn(console, "error").mockImplementation(() => {});

      component.exportReActSteps();

      expect(notification.error).toHaveBeenCalledWith("Failed to export ReAct steps");
      expect(createObjectURL).not.toHaveBeenCalled();
    });
  });

  describe("drag & drop file upload", () => {
    const fileDragEvent = (type: string, files: File[] = []): DragEvent =>
      ({
        type,
        preventDefault: vi.fn(),
        dataTransfer: { types: ["Files"], files, dropEffect: "" },
      }) as unknown as DragEvent;

    it("opens the drop zone only for file drags", () => {
      createComponent();

      component.onFileDragEnter(fileDragEvent("dragenter"));
      expect(component.isFileDragOver).toBe(true);

      component.onFileDragLeave(fileDragEvent("dragleave"));
      expect(component.isFileDragOver).toBe(false);

      // An operator drag carries no files and must leave the panel alone.
      const operatorDrag = { preventDefault: vi.fn(), dataTransfer: { types: ["text/plain"] } } as unknown as DragEvent;
      component.onFileDragEnter(operatorDrag);
      expect(component.isFileDragOver).toBe(false);
    });

    it("keeps the drop zone open while the pointer crosses child elements", () => {
      createComponent();

      component.onFileDragEnter(fileDragEvent("dragenter"));
      component.onFileDragEnter(fileDragEvent("dragenter"));
      component.onFileDragLeave(fileDragEvent("dragleave"));

      expect(component.isFileDragOver).toBe(true);
    });

    it("uploads dropped files and appends each dataset path to the message", () => {
      createComponent();
      const file = new File(["a,b\n1,2\n"], "my data.csv", { type: "text/csv" });

      component.onFileDrop(fileDragEvent("drop", [file]));

      expect(fileUpload.uploadFiles).toHaveBeenCalledWith([file]);
      // The pending row uses the sanitized name the service will store under.
      expect(component.fileUploads).toEqual([{ fileName: "my_data.csv", percentage: 0, status: "uploading" }]);
      expect(component.isFileDragOver).toBe(false);

      uploadSubject.next({ fileName: "my_data.csv", percentage: 40, status: "uploading" });
      expect(component.fileUploads[0].percentage).toBe(40);

      uploadSubject.next({
        fileName: "my_data.csv",
        percentage: 100,
        status: "done",
        path: "/me@texera.dev/agent-uploads/v1/my_data.csv",
      });
      expect(component.currentMessage).toBe("/me@texera.dev/agent-uploads/v1/my_data.csv");
    });

    it("appends the path after text the user already typed", () => {
      createComponent();
      component.currentMessage = "plot this ";
      component.onFileDrop(fileDragEvent("drop", [new File(["x"], "a.csv")]));

      uploadSubject.next({ fileName: "a.csv", percentage: 100, status: "done", path: "/me/agent-uploads/v1/a.csv" });

      expect(component.currentMessage).toBe("plot this /me/agent-uploads/v1/a.csv");
    });

    it("reports an upload failure and marks the row failed", () => {
      createComponent();
      component.onFileDrop(fileDragEvent("drop", [new File(["x"], "a.csv")]));

      uploadSubject.error(new Error("lakefs is down"));

      expect(notification.error).toHaveBeenCalledWith(expect.stringContaining("lakefs is down"));
      expect(component.fileUploads[0].status).toBe("failed");
      expect(component.currentMessage).toBe("");
    });

    it("ignores a drop that carries no files", () => {
      createComponent();

      component.onFileDrop(fileDragEvent("drop", []));

      expect(fileUpload.uploadFiles).not.toHaveBeenCalled();
      expect(component.fileUploads).toEqual([]);
    });
  });

  describe("scroll-to-step requests", () => {
    it("scrolls to and highlights the requested step of this agent", () => {
      createComponent();
      const s0 = makeStep({ messageId: "m1", stepId: 0 });
      const s1 = makeStep({ messageId: "m1", stepId: 1 });
      agentService.stepsSubject.next([s0, s1]);
      fixture.detectChanges();
      agentService.setHoveredMessage.mockClear();

      agentService.scrollToStepSubject.next({ agentId: AGENT_ID, messageId: "m1", stepId: 0 });

      expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
      expect(component.hoveredMessageIndex).toBe(0);
      expect(agentService.setHoveredMessage).toHaveBeenCalledWith(AGENT_ID, s0);
    });

    it("ignores scroll requests addressed to other agents", () => {
      createComponent();
      agentService.stepsSubject.next([makeStep()]);
      fixture.detectChanges();

      agentService.scrollToStepSubject.next({ agentId: "someone-else", messageId: "m1", stepId: 0 });

      expect(scrollIntoViewMock).not.toHaveBeenCalled();
    });
  });

  describe("template rendering", () => {
    it("renders user and agent message bubbles with roles, content and tool summary", async () => {
      createComponent();
      const userStep = makeStep({ messageId: "m1", stepId: 0, role: "user", content: "hello agent" });
      const agentStep = makeStep({
        messageId: "m1",
        stepId: 1,
        role: "agent",
        content: "hi human",
        isBegin: true,
        toolCalls: [{ toolName: "addOperator" }],
        usage: { totalTokens: 10 },
      });
      agentService.stepsSubject.next([userStep, agentStep]);
      fixture.detectChanges();
      // <markdown> writes its parsed HTML into the element only after awaiting an
      // async parse(), so flush a macrotask before asserting on the rendered text.
      // (fixture.whenStable() never settles here — the markdown pipeline keeps the
      // zone perpetually unstable.)
      await new Promise(resolve => setTimeout(resolve, 0));
      fixture.detectChanges();

      const messages = fixture.nativeElement.querySelectorAll(".messages-container .message");
      expect(messages.length).toBe(2);
      expect(messages[0].classList.contains("user-message")).toBe(true);
      expect(messages[0].textContent).toContain("You");
      expect(messages[0].textContent).toContain("hello agent");
      expect(messages[1].classList.contains("ai-message")).toBe(true);
      expect(messages[1].textContent).toContain("Test Agent");
      expect(messages[1].textContent).toContain("hi human");
      expect(messages[1].textContent).toContain("Add 1 operator");
      // The details button belongs to the hovered row only.
      expect(messages[1].querySelector("button")).toBeNull();
      component.setHoveredMessage(1);
      fixture.detectChanges();
      expect(messages[1].querySelector("button")).toBeTruthy();
    });

    it("shows the thinking spinner and stop button while generating", async () => {
      createComponent();
      agentService.stateSubject.next(AgentState.GENERATING);
      fixture.detectChanges();
      // The textarea's [disabled] binding rides on ngModel, whose disabled state is
      // pushed to the control value accessor on a microtask; flush it before asserting.
      await new Promise(resolve => setTimeout(resolve, 0));
      fixture.detectChanges();

      const loading = fixture.nativeElement.querySelector(".loading-message");
      expect(loading).toBeTruthy();
      expect(loading.textContent).toContain("Thinking...");
      expect(fixture.nativeElement.querySelector("textarea").disabled).toBe(true);

      const inputButtons = fixture.nativeElement.querySelectorAll(".input-area button");
      expect(inputButtons.length).toBe(2); // send + stop
      (inputButtons[1] as HTMLButtonElement).click();
      expect(agentService.stopGeneration).toHaveBeenCalledWith(AGENT_ID);
    });

    it("shows the stopping indicator while the agent stops", () => {
      createComponent();
      agentService.stateSubject.next(AgentState.STOPPING);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector(".loading-message").textContent).toContain("Stopping...");
    });

    it("shows the disconnected banner and hides the clear button when unavailable", () => {
      createComponent();
      agentService.stateSubject.next(AgentState.UNAVAILABLE);
      fixture.detectChanges();

      const warning = fixture.nativeElement.querySelector(".connection-warning");
      expect(warning).toBeTruthy();
      expect(warning.textContent).toContain("Agent is disconnected. Please check your connection.");
      // Clear button (*ngIf isAvailable) is gone: info + play + export + import remain.
      expect(fixture.nativeElement.querySelectorAll(".chat-toolbar button").length).toBe(4);
      expect(
        fixture.nativeElement.querySelector('.chat-toolbar button[nztooltiptitle="Clear chat history"]')
      ).toBeNull();

      agentService.stateSubject.next(AgentState.AVAILABLE);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector(".connection-warning")).toBeNull();
      expect(fixture.nativeElement.querySelectorAll(".chat-toolbar button").length).toBe(5);
      expect(
        fixture.nativeElement.querySelector('.chat-toolbar button[nztooltiptitle="Clear chat history"]')
      ).toBeTruthy();
    });

    it("disables the send button until there is input and the agent is available", () => {
      createComponent();
      const sendButton = fixture.nativeElement.querySelector(".input-area button") as HTMLButtonElement;
      expect(sendButton.disabled).toBe(true); // empty input

      component.currentMessage = "run it";
      fixture.detectChanges();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();
      expect(agentService.sendMessage).toHaveBeenCalledWith(AGENT_ID, "run it");

      component.currentMessage = "again";
      agentService.stateSubject.next(AgentState.GENERATING);
      fixture.detectChanges();
      expect(sendButton.disabled).toBe(true);
    });

    it("clear button delegates to the service", () => {
      createComponent();
      const clearButton = fixture.nativeElement.querySelector(
        '.chat-toolbar button[nztooltiptitle="Clear chat history"]'
      ) as HTMLButtonElement;
      clearButton.click();
      expect(agentService.clearMessages).toHaveBeenCalledWith(AGENT_ID);
    });

    describe("system-info modal", () => {
      // The modal body renders inside the CDK overlay, which is attached to
      // ApplicationRef rather than to this fixture — tick() re-renders it.
      const flushOverlay = (): void => {
        fixture.detectChanges();
        TestBed.inject(ApplicationRef).tick();
      };

      // Lets the <markdown> component's awaited parse() result land in the DOM
      // without depending on full zone stability while the overlay is open.
      const flushAsyncRendering = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

      const clickTab = (label: string): void => {
        // Prefer the innermost [role="tab"] node: HTMLElement.click() bubbles,
        // so this reaches the tab's click listener wherever nz-tabs attached it.
        let candidates = Array.from(document.querySelectorAll<HTMLElement>("[role='tab']"));
        if (candidates.length === 0) {
          candidates = Array.from(document.querySelectorAll<HTMLElement>(".ant-tabs-tab"));
        }
        const tab = candidates.find(el => (el.textContent ?? "").includes(label));
        expect(tab, `expected a tab header containing "${label}"`).toBeTruthy();
        tab!.click();
        flushOverlay();
      };

      beforeEach(() => {
        createComponent();
        agentService.getSystemInfo.mockReturnValue(
          of({
            systemPrompt: "SYSTEM PROMPT TEXT",
            tools: [{ name: "createOperator", description: "Creates an operator", inputSchema: {}, enabled: true }],
          })
        );
      });

      it("opens from the toolbar info button and renders all three tab headers", async () => {
        const infoButton = fixture.nativeElement.querySelector(".chat-toolbar button") as HTMLButtonElement;
        infoButton.click();
        fixture.detectChanges();
        await flushAsyncRendering();
        flushOverlay();

        const bodyText = document.body.textContent ?? "";
        expect(bodyText).toContain("Agent System Information");
        expect(bodyText).toContain("System Prompt");
        expect(bodyText).toContain("Tools (1)");
        expect(bodyText).toContain("Parameters");
        expect(bodyText).not.toContain("Operators");
        // The first tab is active by default and shows the fetched prompt.
        expect(bodyText).toContain("SYSTEM PROMPT TEXT");
      });

      it("renders the tools list and parameter inputs per tab", async () => {
        component.showSystemInfo();
        fixture.detectChanges();
        await flushAsyncRendering();
        flushOverlay();

        clickTab("Tools (1)");
        expect(document.body.textContent).toContain("createOperator");
        expect(document.body.textContent).toContain("Creates an operator");

        clickTab("Parameters");
        expect(document.querySelectorAll("nz-input-number").length).toBe(5);
        const paramsText = document.body.textContent ?? "";
        expect(paramsText).toContain("Max Operator Result Character Limit");
        expect(paramsText).toContain("Max Cell Character Limit");
        expect(paramsText).toContain("Tool Execution Timeout (seconds)");
        expect(paramsText).toContain("Workflow Execution Timeout (minutes)");
        expect(paramsText).toContain("Max Steps per Message");
      });
    });
  });

  describe("snapshot tree layout", () => {
    /** s1 → s2 → {s3, s5}; s5 forks off s2 after s3/s4 already exist. */
    const branchingTree = [
      { id: "s1", parentId: undefined, reactStepId: "r1", operatorCount: 1, resultCount: 0, timestamp: 1000 },
      { id: "s2", parentId: "s1", reactStepId: "r2", operatorCount: 2, resultCount: 0, timestamp: 2000 },
      { id: "s3", parentId: "s2", reactStepId: "r3", operatorCount: 3, resultCount: 0, timestamp: 3000 },
      { id: "s4", parentId: "s3", reactStepId: "r4", operatorCount: 4, resultCount: 0, timestamp: 4000 },
      { id: "s5", parentId: "s2", reactStepId: "r5", operatorCount: 3, resultCount: 0, timestamp: 5000 },
    ];

    it("orders rows chronologically, parents before children", () => {
      // Deliberately shuffled input: order must come from timestamps, not array order.
      const shuffled = [branchingTree[4], branchingTree[1], branchingTree[3], branchingTree[0], branchingTree[2]];
      expect(AgentChatComponent.orderSnapshotsByTime(shuffled).map(n => n.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    });

    it("never places a child above its parent, even when the child's timestamp is older or missing", () => {
      const skewed = [
        { id: "p", parentId: undefined, reactStepId: "r1", operatorCount: 1, resultCount: 0, timestamp: 5000 },
        { id: "c", parentId: "p", reactStepId: "r2", operatorCount: 2, resultCount: 0, timestamp: 1000 },
        { id: "g", parentId: "c", reactStepId: "r3", operatorCount: 3, resultCount: 0, timestamp: null },
      ];
      expect(AgentChatComponent.orderSnapshotsByTime(skewed).map(n => n.id)).toEqual(["p", "c", "g"]);
    });

    it("keeps a linear chain in one lane and gives each fork the next lane", () => {
      const ordered = AgentChatComponent.orderSnapshotsByTime(branchingTree);
      const lanes = AgentChatComponent.assignSnapshotLanes(ordered);
      expect([lanes.get("s1"), lanes.get("s2"), lanes.get("s3"), lanes.get("s4")]).toEqual([0, 0, 0, 0]);
      // s5 is s2's second child → its own lane, so the fork is visible on x.
      expect(lanes.get("s5")).toBe(1);
    });

    it("checks out the last step of the snapshot's own turn, not the next turn's request", () => {
      createComponent();
      // Two turns. Snapshot S1 is owned by a1 (the only action-bearing step of
      // turn m1); f1 is that turn's action-less final reply. u2 opens turn m2.
      component.agentResponses = [
        { id: "u1", parentId: undefined, messageId: "m1", role: "user", timestamp: new Date(1) },
        {
          id: "a1",
          parentId: "u1",
          messageId: "m1",
          role: "agent",
          toolCalls: [{ toolName: "addOperator" }],
          timestamp: new Date(2),
        },
        { id: "f1", parentId: "a1", messageId: "m1", role: "agent", timestamp: new Date(3) },
        { id: "u2", parentId: "f1", messageId: "m2", role: "user", timestamp: new Date(4) },
        {
          id: "a2",
          parentId: "u2",
          messageId: "m2",
          role: "agent",
          toolCalls: [{ toolName: "addOperator" }],
          timestamp: new Date(5),
        },
      ] as any;
      component.snapshotTree = {
        rootId: "root",
        nodes: [
          { id: "S1", parentId: "root", reactStepId: "a1" },
          { id: "S2", parentId: "S1", reactStepId: "a2" },
        ],
      } as any;

      component.onSnapshotNodeClick({ id: "S1", reactStepId: "a1" } as any);

      // f1 — the deepest step of turn m1. Checking out u2 would show a request
      // this snapshot predates and branch the next turn off it.
      expect(agentService.checkoutStep).toHaveBeenLastCalledWith(AGENT_ID, "f1");
    });

    it("checks out the owning step itself when its turn produced nothing after it", () => {
      createComponent();
      component.agentResponses = [
        { id: "u1", parentId: undefined, messageId: "m1", role: "user", timestamp: new Date(1) },
        {
          id: "a1",
          parentId: "u1",
          messageId: "m1",
          role: "agent",
          toolCalls: [{ toolName: "addOperator" }],
          timestamp: new Date(2),
        },
        { id: "u2", parentId: "a1", messageId: "m2", role: "user", timestamp: new Date(3) },
      ] as any;
      component.snapshotTree = { rootId: "root", nodes: [{ id: "S1", parentId: "root", reactStepId: "a1" }] } as any;

      component.onSnapshotNodeClick({ id: "S1", reactStepId: "a1" } as any);

      expect(agentService.checkoutStep).toHaveBeenLastCalledWith(AGENT_ID, "a1");
    });

    it("keeps the tree shape unchanged across a checkout, moving only the highlight", () => {
      // Steps r1..r5 mirror the snapshots; r5 branches off r2 like s5 off s2.
      component.agentResponses = [
        { id: "r1", parentId: undefined },
        { id: "r2", parentId: "r1" },
        { id: "r3", parentId: "r2" },
        { id: "r4", parentId: "r3" },
        { id: "r5", parentId: "r2" },
      ] as any;
      component.snapshotTree = { rootId: "s1", nodes: branchingTree };

      // HEAD on the branch tip...
      component.currentHeadId = "r5";
      component.buildSnapshotTree();
      const branchLayout = component.snapshotNodes.map(n => ({ id: n.id, x: n.x, y: n.y }));
      const branchEdges = component.snapshotEdges.map(e => e.path);
      expect(component.snapshotNodes.find(n => n.isActive)!.id).toBe("s5");

      // ...then checked out to the other branch's tip.
      component.currentHeadId = "r4";
      component.buildSnapshotTree();
      expect(component.snapshotNodes.map(n => ({ id: n.id, x: n.x, y: n.y }))).toEqual(branchLayout);
      expect(component.snapshotEdges.map(e => e.path)).toEqual(branchEdges);
      // Only the highlight moved.
      expect(component.snapshotNodes.find(n => n.isActive)!.id).toBe("s4");
      expect(component.snapshotNodes.filter(n => n.isOnActivePath).map(n => n.id)).toEqual(["s1", "s2", "s3", "s4"]);
    });

    it("routes a fork away from its parent's lane immediately", () => {
      component.snapshotTree = { rootId: "s1", nodes: branchingTree };
      component.buildSnapshotTree();

      const nodeX = new Map(component.snapshotNodes.map(n => [n.id, n.x]));
      const fork = component.snapshotEdges.find(e => e.sourceId === "s2" && e.targetId === "s5")!;
      expect(nodeX.get("s5")).not.toBe(nodeX.get("s2"));
      // The path bends into the child's lane first, then drops: the only
      // straight segment ("L") is the vertical run at the child's x.
      expect(fork.path).toContain(`L ${nodeX.get("s5")} `);
      expect(fork.path.startsWith(`M ${nodeX.get("s2")} `)).toBe(true);
    });

    it("gives every snapshot its own y, with the time axis labelling each row", () => {
      component.snapshotTree = { rootId: "s1", nodes: branchingTree };
      component.buildSnapshotTree();

      expect(component.snapshotNodes.length).toBe(5);
      const ys = component.snapshotNodes.map(n => n.y);
      expect(new Set(ys).size).toBe(ys.length); // no two nodes share a level
      expect([...ys]).toEqual([...ys].sort((a, b) => a - b)); // rows increase with time
      expect(component.snapshotNodes.map(n => n.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
      // Rows never overlap vertically.
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(component.snapshotNodes[i].height);
      }
      expect(component.snapshotTimeRows.map(r => r.y)).toEqual(ys);
      expect(component.snapshotEdges.length).toBe(4);
      expect(component.treeHeight).toBeGreaterThan(ys[ys.length - 1]);
    });

    it("labels a repeated clock time only on its first row", () => {
      const sameSecond = [
        { id: "a", parentId: undefined, reactStepId: "r1", operatorCount: 1, resultCount: 0, timestamp: 1000 },
        { id: "b", parentId: "a", reactStepId: "r2", operatorCount: 2, resultCount: 0, timestamp: 1000 },
      ];
      component.snapshotTree = { rootId: "a", nodes: sameSecond };
      component.buildSnapshotTree();
      expect(component.snapshotTimeRows[0].label).not.toBe("");
      expect(component.snapshotTimeRows[1].label).toBe("");
    });
  });
});
