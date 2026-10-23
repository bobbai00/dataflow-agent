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
import { Observable, Subject, of } from "rxjs";
import { AgentPanelComponent } from "./agent-panel.component";
import { AgentRegistrationComponent } from "./agent-registration/agent-registration.component";
import { AgentChatComponent } from "./agent-chat/agent-chat.component";
import { AgentInfo, AgentService } from "../../../service/agent/agent.service";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
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
  // Element injected before the fixture so loadPanelSettings' getElementById("agent-container")
  // resolves to a style object the test controls (jsdom does not round-trip `transform`
  // through cssText, so the style is faked via defineProperty).
  let fakeContainer: HTMLDivElement | undefined;

  beforeEach(async () => {
    localStorage.clear();
    agentService = new MockAgentService();
    metadataSubject = new Subject();
    workflowAction = {
      getWorkflowMetadata: vi.fn().mockReturnValue({ wid: CURRENT_WID }),
      workflowMetaDataChanged: () => metadataSubject.asObservable(),
    };
    routeParams = {};

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
    fakeContainer?.remove();
    fakeContainer = undefined;
    // ngOnDestroy persists panel settings; wipe them so specs stay independent.
    localStorage.clear();
    vi.restoreAllMocks();
  });

  function createComponent(): AgentPanelComponent {
    fixture = TestBed.createComponent(AgentPanelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    return component;
  }

  function installFakeContainer(style: { cssText: string; transform: string }): void {
    fakeContainer = document.createElement("div");
    fakeContainer.id = "agent-container";
    Object.defineProperty(fakeContainer, "style", { value: style, configurable: true });
    // Insert at the front of <body> so getElementById resolves to this element,
    // not the panel's own #agent-container rendered later by the fixture.
    document.body.insertBefore(fakeContainer, document.body.firstChild);
  }

  const chats = () => fixture.debugElement.queryAll(By.directive(StubAgentChatComponent)).map(d => d.componentInstance);
  const registration = () => fixture.debugElement.query(By.directive(StubAgentRegistrationComponent));
  const title = () => (fixture.nativeElement.querySelector("#title") as HTMLElement).textContent?.trim();

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
      // The open panel has a remove button for the shown agent.
      component.openPanel();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector(".remove-agent")).toBeTruthy();
    });

    it("shows the registration when the workflow has no agent, even if other workflows have", () => {
      agentService.agentList = [makeDelegateAgent("elsewhere", OTHER_WID)];
      createComponent();

      expect(component.agent).toBeNull();
      expect(component.loading).toBe(false);
      expect(chats()).toEqual([]);
      expect(registration()).not.toBeNull();
      expect(title()).toBe("AI Agent");
      expect(agentService.activateAgent).not.toHaveBeenCalled();
      component.openPanel();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector(".remove-agent")).toBeNull();
    });

    it("shows a spinner, not the registration, until the agent list arrives", () => {
      const pending = new Subject<AgentInfo[]>();
      agentService.getAllAgents.mockReturnValue(pending.asObservable());
      createComponent();

      expect(component.loading).toBe(true);
      expect(fixture.nativeElement.querySelector(".panel-loading")).toBeTruthy();
      expect(registration()).toBeNull();

      pending.next([]);
      fixture.detectChanges();
      expect(component.loading).toBe(false);
      expect(fixture.nativeElement.querySelector(".panel-loading")).toBeNull();
      expect(registration()).not.toBeNull();
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

    it("closes the chat when the workflow's agent disappears from the list", () => {
      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)];
      createComponent();

      agentService.agentList = [];
      agentService.agentChangeSubject.next();
      fixture.detectChanges();

      expect(agentService.deactivateAgent).toHaveBeenCalledWith("a");
      expect(component.agent).toBeNull();
      expect(chats()).toEqual([]);
      expect(registration()).not.toBeNull();
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
    it("connects the new agent at once and lists again, which puts it in the chat", () => {
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

    it("disconnects and deletes the agent and goes back to the registration", () => {
      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)];
      createComponent();
      component.openPanel();
      fixture.detectChanges();
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
      expect(component.agent).toBeNull();
      expect(chats()).toEqual([]);
      expect(registration()).not.toBeNull();
      expect(title()).toBe("AI Agent");
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

  describe("openPanel and docked state", () => {
    it("the docked button opens the panel and the minimize button docks it again", () => {
      createComponent();
      const content = fixture.nativeElement.querySelector("#content") as HTMLElement;
      expect(content.hidden).toBe(true);
      expect(fixture.nativeElement.querySelector("#return-button")).toBeNull();

      const dockedButton = fixture.nativeElement.querySelector("#agent-docked-button") as HTMLButtonElement;
      dockedButton.click();
      fixture.detectChanges();

      expect(component.width).toBe(560);
      expect(content.hidden).toBe(false);
      expect(fixture.nativeElement.querySelector("#agent-docked-button")).toBeNull();

      const minimize = fixture.nativeElement.querySelector("#return-button li:last-child") as HTMLElement;
      minimize.click();
      fixture.detectChanges();

      expect(component.width).toBe(0);
      expect(component.isDocked).toBe(true);
      expect(fixture.nativeElement.querySelector("#agent-docked-button")).toBeTruthy();
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

    it("handleDragStart undocks the panel", () => {
      createComponent();
      component.isDocked = true;
      component.handleDragStart();
      expect(component.isDocked).toBe(false);
    });
  });

  describe("panel settings persistence", () => {
    it("restores a saved width only when the panel was left undocked", () => {
      localStorage.setItem("agent-panel-width", "512");
      localStorage.setItem("agent-panel-docked", "false");
      createComponent();
      expect(component.width).toBe(512);
    });

    it("stays docked when the panel was saved docked, regardless of the saved width", () => {
      localStorage.setItem("agent-panel-width", "512");
      localStorage.setItem("agent-panel-docked", "true");
      createComponent();
      expect(component.width).toBe(0);
    });

    it("rejects a saved width below the minimum", () => {
      localStorage.setItem("agent-panel-width", "100");
      localStorage.setItem("agent-panel-docked", "false");
      createComponent();
      expect(component.width).toBe(0);
    });

    it("rejects a non-numeric saved width", () => {
      localStorage.setItem("agent-panel-width", "not-a-number");
      localStorage.setItem("agent-panel-docked", "false");
      createComponent();
      expect(component.width).toBe(0);
    });

    it("restores a saved height at or above the minimum", () => {
      localStorage.setItem("agent-panel-height", "600");
      createComponent();
      expect(component.height).toBe(600);
    });

    it("keeps the default height when the saved height is below the minimum", () => {
      localStorage.setItem("agent-panel-height", "300");
      createComponent();
      expect(component.height).toBe(Math.max(450, window.innerHeight * 0.7));
    });

    it("re-applies the saved container style and derives the return position from its transform", () => {
      const style = { cssText: "", transform: "translate3d(10px, 20px, 0px) translate3d(5px, -5px, 0px)" };
      installFakeContainer(style);
      localStorage.setItem("agent-panel-style", "transform: translate3d(15px, 15px, 0px);");

      createComponent();

      expect(style.cssText).toBe("transform: translate3d(15px, 15px, 0px);");
      expect(component.returnPosition).toEqual({ x: -15, y: -15 });
      expect(component.isDocked).toBe(false); // drag position (0,0) differs from (-15,-15)
    });

    it("counts as docked when the saved transform nets out to the origin", () => {
      const style = { cssText: "", transform: "translate3d(5px, 5px, 0px) translate3d(-5px, -5px, 0px)" };
      installFakeContainer(style);
      localStorage.setItem("agent-panel-style", "transform: none;");

      createComponent();

      expect(component.returnPosition.x === 0).toBe(true);
      expect(component.returnPosition.y === 0).toBe(true);
      expect(component.isDocked).toBe(true);
    });

    it("persists dimensions, docked flag and container style, and disconnects the agent on destroy", () => {
      agentService.agentList = [makeDelegateAgent("a", CURRENT_WID)];
      createComponent();
      component.openPanel(); // width 0 -> 560
      const height = component.height;

      fixture.destroy();

      expect(agentService.deactivateAgent).toHaveBeenCalledWith("a");
      expect(localStorage.getItem("agent-panel-width")).toBe("560");
      expect(localStorage.getItem("agent-panel-height")).toBe(String(height));
      expect(localStorage.getItem("agent-panel-docked")).toBe("false");
      // The panel's own #agent-container is still attached during ngOnDestroy.
      expect(localStorage.getItem("agent-panel-style")).not.toBeNull();
    });

    it("saves docked=true for a closed panel and skips the style when no container exists", () => {
      createComponent();
      vi.spyOn(document, "getElementById").mockReturnValue(null);

      fixture.destroy();

      expect(localStorage.getItem("agent-panel-width")).toBe("0");
      expect(localStorage.getItem("agent-panel-docked")).toBe("true");
      expect(localStorage.getItem("agent-panel-style")).toBeNull();
    });
  });
});
