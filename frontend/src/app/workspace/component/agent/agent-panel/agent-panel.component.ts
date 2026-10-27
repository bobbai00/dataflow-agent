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

import { Component, HostListener, OnDestroy, OnInit } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { Subscription } from "rxjs";
import { filter, switchMap, take } from "rxjs/operators";
import { NzResizeEvent, NzResizableDirective, NzResizeHandlesComponent } from "ng-zorro-antd/resizable";
import { AgentService, AgentInfo } from "../../../service/agent/agent.service";
import { agentOf } from "../../../service/agent/workflow-agent";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import { ComputingUnitStatusService } from "../../../../common/service/computing-unit/computing-unit-status/computing-unit-status.service";
import { ComputingUnitState } from "../../../../common/type/computing-unit-connection.interface";
import { NgIf, NgFor } from "@angular/common";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzSpinComponent } from "ng-zorro-antd/spin";
import { CdkDrag, CdkDragHandle } from "@angular/cdk/drag-drop";
import { NzMenuDirective, NzMenuItemComponent } from "ng-zorro-antd/menu";
import { AgentRegistrationComponent } from "./agent-registration/agent-registration.component";
import { AgentChatComponent } from "./agent-chat/agent-chat.component";

/**
 * The agent panel: one chat, with the open workflow's agent. It is always open.
 *
 * A workflow has at most one agent here, its newest. Opening a workflow that
 * has an agent shows its chat; opening one that has none starts its chat with
 * the default model as soon as a computing unit runs. Only when that model is
 * not offered (or the start fails) does the registration ask for a model.
 * Agents of other workflows are never shown: moving to another workflow moves
 * the chat.
 */
@UntilDestroy()
@Component({
  selector: "texera-agent-panel",
  templateUrl: "agent-panel.component.html",
  styleUrls: ["agent-panel.component.scss"],
  imports: [
    NgIf,
    NgFor,
    ɵNzTransitionPatchDirective,
    NzTooltipDirective,
    NzIconDirective,
    NzSpinComponent,
    CdkDrag,
    CdkDragHandle,
    NzResizableDirective,
    NzResizeHandlesComponent,
    NzMenuDirective,
    NzMenuItemComponent,
    AgentRegistrationComponent,
    AgentChatComponent,
  ],
})
export class AgentPanelComponent implements OnInit, OnDestroy {
  protected readonly window = window;
  /** The model a new chat starts with, and its name in the panel. */
  public static readonly DEFAULT_MODEL = "claude-haiku-5.5";
  public static readonly DEFAULT_MODEL_NAME = "Claude Haiku 5.5";
  protected readonly defaultModelName = AgentPanelComponent.DEFAULT_MODEL_NAME;
  private static readonly MIN_PANEL_HEIGHT = 450;
  /** The panel's top: just under the workspace's menu bar. */
  static readonly TOP = 80;
  /** Room left under the panel for the canvas's zoom buttons. */
  private static readonly BOTTOM_GAP = 56;

  /**
   * The panel opens on the right of the canvas, the same each time: about 40%
   * of the window wide (600 to 900 px) and as tall as the canvas allows. It can
   * be dragged and resized; a chat opened later starts from here again.
   */
  width = Math.round(Math.min(900, Math.max(600, window.innerWidth * 0.4)));
  height = Math.max(
    AgentPanelComponent.MIN_PANEL_HEIGHT,
    window.innerHeight - AgentPanelComponent.TOP - AgentPanelComponent.BOTTOM_GAP
  );
  readonly top = AgentPanelComponent.TOP;
  readonly maxHeight = Math.max(AgentPanelComponent.MIN_PANEL_HEIGHT, window.innerHeight - AgentPanelComponent.TOP - 8);
  id = -1;
  dragPosition = { x: 0, y: 0 };

  /** The caller's agents, as the service last listed them. */
  agents: AgentInfo[] = [];
  /** The open workflow's id; undefined until the workflow is saved. */
  workflowId?: number;
  /** The workflow's agent, whose chat the panel shows; null while it has none. */
  agent: AgentInfo | null = null;
  /** `[agent]` or empty: rendered with an *ngFor tracked by id, so the chat is rebuilt only when the agent changes. */
  chatAgents: AgentInfo[] = [];
  /** The workflow's agent list has not arrived yet. */
  loading = true;
  /** The workflow has no agent and its chat is starting: waiting for a computing unit, or creating the agent. */
  startingChat = false;
  /** The selected computing unit runs; a new agent needs one. */
  computingUnitRunning = false;
  /** The default model is not offered, or starting the chat failed: the user picks a model. */
  pickModel = false;
  /** The workflow whose chat was started, so a listing that returns before the new agent starts no second one. */
  private chatStartedFor?: number;
  private chatStart?: Subscription;

  constructor(
    private agentService: AgentService,
    private workflowActionService: WorkflowActionService,
    private computingUnitStatusService: ComputingUnitStatusService,
    private route: ActivatedRoute
  ) {}

  ngOnInit(): void {
    this.computingUnitStatusService
      .getStatus()
      .pipe(untilDestroyed(this))
      .subscribe(status => (this.computingUnitRunning = status === ComputingUnitState.Running));

    // The workflow's metadata arrives after the panel exists; the route already names the
    // workflow, so its agent is asked for at once (an unsaved new workflow has no id yet).
    this.workflowId = this.currentWorkflowId() ?? this.routeWorkflowId();
    this.listAgents();

    this.agentService.agentChange$.pipe(untilDestroyed(this)).subscribe(() => this.listAgents());

    // Another workflow (or this one, once saved): drop the chat and list again with its id, so
    // the service brings its traced agents back (a seeded one, an earlier session's).
    this.workflowActionService
      .workflowMetaDataChanged()
      .pipe(untilDestroyed(this))
      .subscribe(metadata => {
        const wid = metadata.wid ?? undefined;
        if (wid === this.workflowId) return;
        this.workflowId = wid;
        this.cancelChatStart();
        this.chatStartedFor = undefined;
        this.pickModel = false;
        this.show(null);
        this.loading = true;
        this.listAgents();
      });
  }

  /** The open workflow's id, once it is saved. */
  private currentWorkflowId(): number | undefined {
    return this.workflowActionService.getWorkflowMetadata().wid ?? undefined;
  }

  /** The workflow id in the route (`/user/workflow/:id`), if any. */
  private routeWorkflowId(): number | undefined {
    const id = Number(this.route.snapshot.params["id"]);
    return Number.isFinite(id) && id > 0 ? id : undefined;
  }

  /** List the caller's agents for the open workflow and show the one that is its; none: start its chat. */
  private listAgents(): void {
    const wid = this.workflowId;
    this.agentService
      .getAllAgents(wid)
      .pipe(untilDestroyed(this))
      .subscribe(agents => {
        // The workflow changed while this listing was out; its own listing follows.
        if (wid !== this.workflowId) return;
        this.agents = agents;
        this.loading = false;
        this.show(agentOf(agents, wid));
        if (!this.agent) {
          this.startChat();
        }
      });
  }

  /**
   * The workflow has no agent: start its chat with the default model once a
   * computing unit runs. When that model is not offered, or the start fails,
   * the registration asks for a model instead.
   */
  private startChat(): void {
    const wid = this.workflowId;
    if (this.pickModel || (wid !== undefined && this.chatStartedFor === wid)) {
      return;
    }
    // An unsaved workflow has no id to bind a chat to: its user picks a model, as before.
    if (wid === undefined) {
      this.pickModel = true;
      return;
    }
    this.chatStartedFor = wid;
    this.startingChat = true;
    this.chatStart = this.computingUnitStatusService
      .getStatus()
      .pipe(
        filter(status => status === ComputingUnitState.Running),
        take(1),
        switchMap(() => this.agentService.fetchModelTypes()),
        switchMap(models => {
          if (!models.some(model => model.id === AgentPanelComponent.DEFAULT_MODEL)) {
            throw new Error(`${AgentPanelComponent.DEFAULT_MODEL} is not offered`);
          }
          return this.agentService.createAgent(
            AgentPanelComponent.DEFAULT_MODEL,
            AgentRegistrationComponent.DEFAULT_AGENT_NAME,
            wid
          );
        }),
        untilDestroyed(this)
      )
      .subscribe({
        next: agent => {
          this.startingChat = false;
          this.onAgentCreated(agent.id);
        },
        error: (error: unknown) => {
          console.error("Failed to start the chat:", error);
          this.startingChat = false;
          this.pickModel = true;
        },
      });
  }

  private cancelChatStart(): void {
    this.chatStart?.unsubscribe();
    this.chatStart = undefined;
    this.startingChat = false;
  }

  /** Put the agent in the chat and connect it; disconnect the one shown before. */
  private show(agent: AgentInfo | null): void {
    if (this.agent && this.agent.id !== agent?.id) {
      this.agentService.deactivateAgent(this.agent.id);
    }
    this.agent = agent;
    if (!agent) {
      this.chatAgents = [];
      return;
    }
    this.agentService.activateAgent(agent.id);
    if (this.chatAgents[0]?.id !== agent.id) {
      this.chatAgents = [agent];
    }
  }

  public trackAgent(_: number, agent: AgentInfo): string {
    return agent.id;
  }

  @HostListener("window:beforeunload")
  ngOnDestroy(): void {
    if (this.agent) {
      this.agentService.deactivateAgent(this.agent.id);
    }
  }

  /**
   * An agent was made for this workflow (its chat started, or the registration
   * made it). Connect it right away and list again: it is the newest, so the
   * listing puts it in the chat.
   */
  public onAgentCreated(agentId: string): void {
    this.agentService.activateAgent(agentId);
    this.listAgents();
  }

  /**
   * Start the chat over, after confirmation: delete the workflow's agent; the
   * listing that follows starts a new chat (or shows an older agent of the
   * workflow, if one exists). The dataflow on the canvas stays.
   */
  public removeAgent(): void {
    const agent = this.agent;
    if (!agent) return;
    if (
      !confirm(
        `Start a new chat? ${agent.name}'s messages and versions in this chat are removed; the dataflow on the canvas stays.`
      )
    ) {
      return;
    }
    this.show(null);
    // The first listing without the agent starts the new chat; later ones see it started.
    this.chatStartedFor = undefined;
    this.agentService
      .deleteAgent(agent.id)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => this.listAgents(),
        error: (error: unknown) => {
          console.error("Failed to delete agent:", error);
        },
      });
  }

  /**
   * Handle panel resize
   */
  onResize({ width, height }: NzResizeEvent): void {
    cancelAnimationFrame(this.id);
    this.id = requestAnimationFrame(() => {
      this.width = width!;
      this.height = height!;
    });
  }
}
