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

import { Component, EventEmitter, Input, Output } from "@angular/core";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { ActivatedRoute } from "@angular/router";
import { By } from "@angular/platform-browser";
import { BehaviorSubject, Observable, Subject, of } from "rxjs";
import { AgentPanelComponent } from "./agent-panel.component";
import { AgentRegistrationComponent } from "./agent-registration/agent-registration.component";
import { AgentChatComponent } from "./agent-chat/agent-chat.component";
import { AgentInfo, AgentService, ModelType } from "../../../service/agent/agent.service";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import { ComputingUnitStatusService } from "../../../../common/service/computing-unit/computing-unit-status/computing-unit-status.service";
import { ComputingUnitState } from "../../../../common/type/computing-unit-connection.interface";
import { commonTestProviders } from "../../../../common/testing/test-utils";

const CURRENT_WID = 42;
const OTHER_WID = 43;
const USER_INFO = { uid: 1, name: "user", email: "user@example.com", role: "REGULAR" };

/**
 * Subject-backed double of AgentService (panel surface only). The panel lists the
 * agents in ngOnInit, again whenever agentChange$ fires, and whenever the workflow
 * changes; tests set `agentList` and push through `agentChangeSubject.next()`.
 */
class MockAgentService {
  public agentChangeSubject = new Subject<void>();
  public agentChange$ = this.agentChangeSubject.asObservable();
  public agentList: AgentInfo[] = [];

  public getAllAgents = vi.fn((): Observable<AgentInfo[]> => of(this.agentList));
  public activateAgent = vi.fn((): boolean => true);
  public deactivateAgent = vi.fn();
  public deleteAgent = vi.fn((): Observable<boolean> => of(true));

  /** The models the gateway offers; the default model leads. */
  public modelTypes: ModelType[] = [
    { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", description: "", icon: "robot" },
    { id: "gpt-test", name: "GPT Test", description: "", icon: "robot" },
  ];
  public fetchModelTypes = vi.fn((): Observable<ModelType[]> => of(this.modelTypes));
  /** Creating an agent adds it to what the service lists, as the agent service does. */
  public createAgent = vi.fn((_model: string, _name?: string, workflowId?: number): Observable<AgentInfo> => {
    const made = makeDelegateAgent("started", workflowId, "2026-02-01T00:00:00Z");
    this.agentList = [...this.agentList, made];
    return of(made);
  });
}

/**
 * Child components have their own specs (agent-chat, agent-registration); the panel
 * spec shallow-renders them via stubs so the panel's template still decides which
 * of them shows, without pulling in markdown / computing-unit machinery.
 */
@Component({
  selector: "texera-agent-registration",
  standalone: true,
  template: "",
})
class StubAgentRegistrationComponent {
  @Output() agentCreated = new EventEmitter<string>();
}

@Component({
  selector: "texera-agent-chat",
  standalone: true,
  template: "",
})
class StubAgentChatComponent {
  @Input() agentInfo?: AgentInfo;
  @Input() isActive = false;
}

function makeAgent(id: string, overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    name: `Agent ${id}`,
    modelType: "gpt-test",
    isBaselineMode: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** An agent made for a workflow, at the given time. */
function makeDelegateAgent(id: string, workflowId: number | undefined, createdAt = "2026-01-01T00:00:00Z"): AgentInfo {
  return makeAgent(id, { delegate: { userInfo: USER_INFO, workflowId }, createdAt: new Date(createdAt) });
}

describe("AgentPanelComponent", () => {
  let fixture: ComponentFixture<AgentPanelComponent>;
  let component: AgentPanelComponent;
  let agentService: MockAgentService;
  let metadataSubject: Subject<{ wid?: number }>;
  let workflowAction: { getWorkflowMetadata: ReturnType<typeof vi.fn>; workflowMetaDataChanged: () => Observable<any> };
  let routeParams: { id?: string };
  let computingUnitStatus: BehaviorSubject<ComputingUnitState>;

  beforeEach(async () => {
    localStorage.clear();
    agentService = new MockAgentService();
    metadataSubject = new Subject();
    workflowAction = {
      getWorkflowMetadata: vi.fn().mockReturnValue({ wid: CURRENT_WID }),
      workflowMetaDataChanged: () => metadataSubject.asObservable(),
    };
    routeParams = {};
    computingUnitStatus = new BehaviorSubject<ComputingUnitState>(ComputingUnitState.Running);

    TestBed.overrideComponent(AgentPanelComponent, {
      remove: { imports: [AgentRegistrationComponent, AgentChatComponent] },
      add: { imports: [StubAgentRegistrationComponent, StubAgentChatComponent] },
    });

    await TestBed.configureTestingModule({
      imports: [AgentPanelComponent, HttpClientTestingModule, NoopAnimationsModule],
      providers: [
        { provide: AgentService, useValue: agentService },
        { provide: WorkflowActionService, useValue: workflowAction },
        { provide: ActivatedRoute, useValue: { snapshot: { params: routeParams } } },
        { provide: ComputingUnitStatusService, useValue: { getStatus: () => computingUnitStatus.asObservable() } },
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
    fixture = undefined as unknown as ComponentFixture<AgentPanelComponent>;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  function createComponent(): AgentPanelComponent {
    fixture = TestBed.createComponent(AgentPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    return component;
  }

  const chats = () => fixture.debugElement.queryAll(By.directive(StubAgentChatComponent)).map(d => d.componentInstance);
  const registration = () => fixture.debugElement.query(By.directive(StubAgentRegistrationComponent));
  const title = () => (fixture.nativeElement.querySelector("#title") as HTMLElement).textContent?.trim();
  const loadingText = () =>
    (fixture.nativeElement.querySelector(".panel-loading-text") as HTMLElement | null)?.textContent?.trim();

  describe("the workflow's agent", () => {
    it("lists the agents for the open workflow and shows its newest agent in the one chat", () => {
      const older = makeDelegateAgent("older", CURRENT_WID, "2026-01-01T00:00:00Z");
      const newest = makeDelegateAgent("newest", CURRENT_WID, "2026-01-03T00:00:00Z");
      const elsewhere = makeDelegateAgent("elsewhere", OTHER_WID, "2026-01-05T00:00:00Z");
      agentService.agentList = [older, elsewhere, newest];
      createComponent();

      expect(agentService.getAllAgents).toHaveBeenCalledTimes(1);
      expect(agentService.getAllAgents).toHaveBeenCalledWith(CURRENT_WID);
      expect(component.agent).toEqual(newest);
      expect(agentService.activateAgent).toHaveBeenCalledWith("newest");
      expect(agentService.activateAgent).not.toHaveBeenCalledWith("elsewhere");
      expect(chats().map(c => [c.agentInfo?.id, c.isActive])).toEqual([["newest", true]]);
      expect(registration()).toBeNull();
      expect(title()).toBe("Agent newest");
      expect(agentService.createAgent).not.toHaveBeenCalled();
      // The panel has a button that starts the chat over.
      expect(fixture.nativeElement.querySelector(".remove-agent")).toBeTruthy();
    });

    it("starts the workflow's chat with Claude Haiku 5.5 when it has no agent, even if other workflows have", () => {
      agentService.agentList = [makeDelegateAgent("elsewhere", OTHER_WID)];
      createComponent();

      expect(agentService.createAgent).toHaveBeenCalledTimes(1);
      expect(agentService.createAgent).toHaveBeenCalledWith("claude-haiku-5.5", "Bob", CURRENT_WID);
      expect(agentService.activateAgent).toHaveBeenCalledWith("started");
      expect(agentService.activateAgent).not.toHaveBeenCalledWith("elsewhere");
      expect(component.agent?.id).toBe("started");
      expect(chats().map(c => c.agentInfo?.id)).toEqual(["started"]);
      expect(registration()).toBeNull();
      expect(fixture.nativeElement.querySelector(".panel-loading")).toBeNull();
    });

    it("waits for a running computing unit before starting the chat, and says so", () => {
      computingUnitStatus.next(ComputingUnitState.NoComputingUnit);
      createComponent();

      expect(agentService.createAgent).not.toHaveBeenCalled();
      expect(loadingText()).toBe("Waiting for a computing unit to start the chat…");
      expect(registration()).toBeNull();

      computingUnitStatus.next(ComputingUnitState.Running);
      fixture.detectChanges();

      expect(agentService.createAgent).toHaveBeenCalledTimes(1);
      expect(component.agent?.id).toBe("started");
    });

    it("starts one chat: a listing that returns before the new agent starts no second one", () => {
      const created = new Subject<AgentInfo>();
      agentService.createAgent.mockReturnValue(created.asObservable());
      createComponent();
      expect(loadingText()).toBe("Starting a chat with Claude Haiku 5.5…");

      agentService.agentChangeSubject.next();
      fixture.detectChanges();

      expect(agentService.getAllAgents).toHaveBeenCalledTimes(2);
      expect(agentService.createAgent).toHaveBeenCalledTimes(1);
      expect(loadingText()).toBe("Starting a chat with Claude Haiku 5.5…");
    });

    it("asks for a model when Claude Haiku 5.5 is not offered", () => {
      agentService.modelTypes = [{ id: "gpt-test", name: "GPT Test", description: "", icon: "robot" }];
      vi.spyOn(console, "error").mockImplementation(() => {});
      createComponent();

      expect(agentService.createAgent).not.toHaveBeenCalled();
      expect(registration()).not.toBeNull();
      expect(fixture.nativeElement.querySelector(".panel-loading")).toBeNull();
      expect(title()).toBe("AI Agent");
      expect(fixture.nativeElement.querySelector(".remove-agent")).toBeNull();
    });

    it("shows a spinner, not the registration, until the agent list arrives and while the chat starts", () => {
      const pending = new Subject<AgentInfo[]>();
      agentService.getAllAgents.mockReturnValue(pending.asObservable());
      agentService.createAgent.mockReturnValue(new Subject<AgentInfo>().asObservable());
      createComponent();

      expect(component.loading).toBe(true);
      expect(fixture.nativeElement.querySelector(".panel-loading")).toBeTruthy();
      expect(loadingText()).toBeUndefined();
      expect(registration()).toBeNull();

      pending.next([]);
      fixture.detectChanges();
      expect(component.loading).toBe(false);
      expect(loadingText()).toBe("Starting a chat with Claude Haiku 5.5…");
      expect(registration()).toBeNull();
    });

    it("asks with the route's workflow id while the workflow metadata has none yet", () => {
      workflowAction.getWorkflowMetadata.mockReturnValue({});
      routeParams.id = String(OTHER_WID);
      agentService.agentList = [makeDelegateAgent("a", OTHER_WID)];
      createComponent();

      expect(agentService.getAllAgents).toHaveBeenCalledWith(OTHER_WID);
      expect(component.agent?.id).toBe("a");
    });

    it("treats an unsaved workflow (no id anywhere) as the one agents without a workflow id are for", () => {
      workflowAction.getWorkflowMetadata.mockReturnValue({});
      agentService.agentList = [makeDelegateAgent("bound", CURRENT_WID), makeDelegateAgent("free", undefined)];
      createComponent();

      expect(agentService.getAllAgents).toHaveBeenCalledWith(undefined);
      expect(component.agent?.id).toBe("free");
    });

    it("asks for a model in an unsaved workflow, which has no id to bind a chat to", () => {
      workflowAction.getWorkflowMetadata.mockReturnValue({});
      createComponent();

      expect(agentService.createAgent).not.toHaveBeenCalled();
      expect(registration()).not.toBeNull();

      // Once saved, the workflow has an id and its chat starts.
      metadataSubject.next({ wid: CURRENT_WID });
      fixture.detectChanges();
      expect(agentService.createAgent).toHaveBeenCalledWith("claude-haiku-5.5", "Bob", CURRENT_WID);
      expect(registration()).toBeNull();
    });

    it("moves the chat to a newer agent of the workflow when the list changes", () => {
      const first = makeDelegateAgent("first", CURRENT_WID, "2026-01-01T00:00:00Z");
      agentService.agentList = [first];
      createComponent();
      const chatBefore = chats()[0];

      const second = makeDelegateAgent("second", CURRENT_WID, "2026-01-02T00:00:00Z");
      agentService.agentList = [first, second];
      agentService.agentChangeSubject.next();
      fixture.detectChanges();

      expect(agentService.getAllAgents).toHaveBeenCalledTimes(2);
      expect(agentService.deactivateAgent).toHaveBeenCalledWith("first");
      expect(agentService.activateAgent).toHaveBeenLastCalledWith("second");
      expect(chats().map(c => c.agentInfo?.id)).toEqual(["second"]);
      expect(chats()[0]).not.toBe(chatBefore);
      expect(title()).toBe("Agent second");
    });

    it("keeps the chat (same component) when a new listing brings the same agent again", () => {
      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)];
      createComponent();
      const chatBefore = chats()[0];

      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)]; // a fresh object, same id
      agentService.agentChangeSubject.next();
      fixture.detectChanges();

      expect(agentService.deactivateAgent).not.toHaveBeenCalled();
      expect(chats()[0]).toBe(chatBefore);
    });

    it("starts a new chat when the workflow's agent disappears from the list", () => {
      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)];
      createComponent();

      agentService.agentList = [];
      agentService.agentChangeSubject.next();
      fixture.detectChanges();

      expect(agentService.deactivateAgent).toHaveBeenCalledWith("a");
      expect(agentService.createAgent).toHaveBeenCalledTimes(1);
      expect(chats().map(c => c.agentInfo?.id)).toEqual(["started"]);
      expect(registration()).toBeNull();
    });
  });

  describe("workflow changes", () => {
    it("drops the chat, lists again for the new workflow and shows its agent", () => {
      const here = makeDelegateAgent("here", CURRENT_WID);
      const there = makeDelegateAgent("there", OTHER_WID);
      agentService.agentList = [here, there];
      createComponent();
      expect(component.agent?.id).toBe("here");

      // The listing for the other workflow is on its way: spinner, no chat, no registration.
      const pending = new Subject<AgentInfo[]>();
      agentService.getAllAgents.mockReturnValue(pending.asObservable());
      metadataSubject.next({ wid: OTHER_WID });
      fixture.detectChanges();

      expect(agentService.deactivateAgent).toHaveBeenCalledWith("here");
      expect(agentService.getAllAgents).toHaveBeenLastCalledWith(OTHER_WID);
      expect(component.workflowId).toBe(OTHER_WID);
      expect(component.loading).toBe(true);
      expect(chats()).toEqual([]);
      expect(registration()).toBeNull();

      pending.next([here, there]);
      fixture.detectChanges();
      expect(component.agent?.id).toBe("there");
      expect(agentService.activateAgent).toHaveBeenLastCalledWith("there");
      expect(chats().map(c => c.agentInfo?.id)).toEqual(["there"]);
    });

    it("ignores metadata that repeats the current workflow id", () => {
      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)];
      createComponent();

      metadataSubject.next({ wid: CURRENT_WID });

      expect(agentService.getAllAgents).toHaveBeenCalledTimes(1);
      expect(agentService.deactivateAgent).not.toHaveBeenCalled();
    });

    it("discards a listing that arrives for a workflow the panel already left", () => {
      const stale = new Subject<AgentInfo[]>();
      agentService.getAllAgents.mockReturnValueOnce(stale.asObservable());
      createComponent(); // the listing for CURRENT_WID is still pending

      agentService.agentList = [makeDelegateAgent("there", OTHER_WID)];
      metadataSubject.next({ wid: OTHER_WID }); // answered at once from agentList
      expect(component.agent?.id).toBe("there");

      stale.next([makeDelegateAgent("here", CURRENT_WID)]);
      expect(component.agent?.id).toBe("there");
      expect(component.agents.map(a => a.id)).toEqual(["there"]);
    });
  });

  describe("onAgentCreated", () => {
    it("connects an agent the registration made at once and lists again, which puts it in the chat", () => {
      agentService.modelTypes = [];
      vi.spyOn(console, "error").mockImplementation(() => {});
      createComponent();
      expect(registration()).not.toBeNull();

      const made = makeDelegateAgent("made", CURRENT_WID);
      agentService.agentList = [made];
      registration().componentInstance.agentCreated.emit("made");
      fixture.detectChanges();

      expect(agentService.activateAgent).toHaveBeenCalledWith("made");
      expect(agentService.getAllAgents).toHaveBeenCalledTimes(2);
      expect(component.agent).toEqual(made);
      expect(chats().map(c => c.agentInfo?.id)).toEqual(["made"]);
      expect(registration()).toBeNull();
    });
  });

  describe("removeAgent", () => {
    it("does nothing when the removal is not confirmed", () => {
      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)];
      createComponent();
      vi.spyOn(window, "confirm").mockReturnValue(false);

      component.removeAgent();

      expect(agentService.deleteAgent).not.toHaveBeenCalled();
      expect(component.agent?.id).toBe("a");
    });

    it("disconnects and deletes the agent, then starts one new chat", () => {
      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)];
      createComponent();
      vi.spyOn(window, "confirm").mockReturnValue(true);
      // The service signals the change once the agent is gone.
      agentService.deleteAgent.mockImplementation(() => {
        agentService.agentList = [];
        agentService.agentChangeSubject.next();
        return of(true);
      });

      (fixture.nativeElement.querySelector(".remove-agent") as HTMLElement).click();
      fixture.detectChanges();

      expect(agentService.deactivateAgent).toHaveBeenCalledWith("a");
      expect(agentService.deleteAgent).toHaveBeenCalledWith("a");
      expect(agentService.createAgent).toHaveBeenCalledTimes(1);
      expect(component.agent?.id).toBe("started");
      expect(chats().map(c => c.agentInfo?.id)).toEqual(["started"]);
      expect(registration()).toBeNull();
    });

    it("falls back to the workflow's older agent when the newest is removed", () => {
      const older = makeDelegateAgent("older", CURRENT_WID, "2026-01-01T00:00:00Z");
      const newer = makeDelegateAgent("newer", CURRENT_WID, "2026-01-02T00:00:00Z");
      agentService.agentList = [older, newer];
      createComponent();
      expect(component.agent?.id).toBe("newer");
      vi.spyOn(window, "confirm").mockReturnValue(true);
      agentService.deleteAgent.mockImplementation(() => {
        agentService.agentList = [older];
        agentService.agentChangeSubject.next();
        return of(true);
      });

      component.removeAgent();
      fixture.detectChanges();

      expect(component.agent?.id).toBe("older");
      expect(chats().map(c => c.agentInfo?.id)).toEqual(["older"]);
    });
  });

  describe("always open, on the right", () => {
    const defaultWidth = () => Math.round(Math.min(900, Math.max(600, window.innerWidth * 0.4)));
    const defaultHeight = () => Math.max(450, window.innerHeight - 80 - 56);

    it("opens at once, with no docked button and nothing that closes it", () => {
      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)];
      createComponent();

      expect((fixture.nativeElement.querySelector("#content") as HTMLElement).hidden).toBe(false);
      expect(fixture.nativeElement.querySelector("#agent-docked-button")).toBeNull();
      // The one panel button starts the chat over.
      expect(fixture.nativeElement.querySelectorAll("#return-button li").length).toBe(1);
    });

    it("opens under the menu bar at 40% of the window wide (600 to 900 px) and as tall as the canvas", () => {
      createComponent();

      expect(component.width).toBe(defaultWidth());
      expect(component.height).toBe(defaultHeight());
      const container = fixture.nativeElement.querySelector("#agent-container") as HTMLElement;
      expect(container.style.top).toBe("80px");
      expect(container.style.width).toBe(`${defaultWidth()}px`);
      expect(container.style.height).toBe(`${defaultHeight()}px`);
      // No dragged position: it sits against the right edge.
      expect(container.style.transform === "" || container.style.transform === "translate3d(0px, 0px, 0px)").toBe(
        true
      );
    });

    it("opens the same way whatever an earlier session left in local storage", () => {
      localStorage.setItem("agent-panel-width", "420");
      localStorage.setItem("agent-panel-height", "460");
      localStorage.setItem("agent-panel-docked", "true");
      localStorage.setItem("agent-panel-style", "transform: translate3d(-900px, 400px, 0px);");
      createComponent();

      expect(component.width).toBe(defaultWidth());
      expect(component.height).toBe(defaultHeight());
      const container = fixture.nativeElement.querySelector("#agent-container") as HTMLElement;
      expect(container.style.transform).not.toContain("-900px");
    });

    it("disconnects the agent on destroy and saves no geometry", () => {
      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)];
      createComponent();

      fixture.destroy();

      expect(agentService.deactivateAgent).toHaveBeenCalledWith("a");
      expect(localStorage.getItem("agent-panel-width")).toBeNull();
      expect(localStorage.getItem("agent-panel-style")).toBeNull();
    });
  });

  describe("panel geometry", () => {
    it("onResize coalesces updates through requestAnimationFrame", () => {
      createComponent();
      const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(cb => {
        cb(0);
        return 123;
      });
      const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

      component.onResize({ width: 640, height: 520 });
      expect(caf).toHaveBeenCalledWith(-1); // initial frame id
      expect(raf).toHaveBeenCalledTimes(1);
      expect(component.width).toBe(640);
      expect(component.height).toBe(520);
      expect(component.id).toBe(123);

      component.onResize({ width: 700, height: 560 });
      expect(caf).toHaveBeenLastCalledWith(123); // cancels the previous frame
      expect(component.width).toBe(700);
      expect(component.height).toBe(560);
    });
  });
});
