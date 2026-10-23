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
import { NzResizeEvent, NzResizableDirective, NzResizeHandlesComponent } from "ng-zorro-antd/resizable";
import { AgentService, AgentInfo } from "../../../service/agent/agent.service";
import { agentOf } from "../../../service/agent/workflow-agent";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import { calculateTotalTranslate3d } from "../../../../common/util/panel-dock";
import { NgIf, NgClass, NgFor } from "@angular/common";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzSpinComponent } from "ng-zorro-antd/spin";
import { CdkDrag, CdkDragHandle } from "@angular/cdk/drag-drop";
import { NzMenuDirective, NzMenuItemComponent } from "ng-zorro-antd/menu";
import { AgentRegistrationComponent } from "./agent-registration/agent-registration.component";
import { AgentChatComponent } from "./agent-chat/agent-chat.component";

/**
 * The agent panel: one chat, with the open workflow's agent.
 *
 * A workflow has at most one agent here, its newest. Opening a workflow that
 * has an agent shows its chat; opening one that has none shows the
 * registration, where the user picks a model and creates the agent. Agents of
 * other workflows are never shown: moving to another workflow moves the chat.
 */
@UntilDestroy()
@Component({
  selector: "texera-agent-panel",
  templateUrl: "agent-panel.component.html",
  styleUrls: ["agent-panel.component.scss"],
  imports: [
    NgIf,
    NgFor,
    NgClass,
    NzButtonComponent,
    NzWaveDirective,
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
  private static readonly MIN_PANEL_WIDTH = 400;
  /** Width a closed panel opens at: room for the version rail and a readable chat. */
  private static readonly DEFAULT_PANEL_WIDTH = 560;
  private static readonly MIN_PANEL_HEIGHT = 450;

  // Panel dimensions and position
  width: number = 0; // Start with 0 to show docked button
  height = Math.max(AgentPanelComponent.MIN_PANEL_HEIGHT, window.innerHeight * 0.7);
  id = -1;
  dragPosition = { x: 0, y: 0 };
  returnPosition = { x: 0, y: 0 };
  isDocked = true;

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

  constructor(
    private agentService: AgentService,
    private workflowActionService: WorkflowActionService,
    private route: ActivatedRoute
  ) {}

  ngOnInit(): void {
    this.loadPanelSettings();

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

  /** List the caller's agents for the open workflow and show the one that is its. */
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
      });
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
    this.savePanelSettings();
  }

  /**
   * Open the panel from docked state
   */
  public openPanel(): void {
    if (this.width === 0) {
      // Open panel
      this.width = AgentPanelComponent.DEFAULT_PANEL_WIDTH;
    } else {
      // Close panel (dock it)
      this.width = 0;
      this.isDocked = true;
    }
  }

  /**
   * The registration made an agent for this workflow. Connect it right away and
   * list again: it is the newest, so the listing puts it in the chat.
   */
  public onAgentCreated(agentId: string): void {
    this.agentService.activateAgent(agentId);
    this.listAgents();
  }

  /**
   * Delete the workflow's agent, after confirmation. The chat closes; the
   * listing that follows shows the registration (or an older agent of the
   * workflow, if one exists).
   */
  public removeAgent(): void {
    const agent = this.agent;
    if (!agent) return;
    if (!confirm(`Remove ${agent.name} and its chat from this workflow? You can create a new agent afterwards.`)) {
      return;
    }
    this.show(null);
    this.agentService
      .deleteAgent(agent.id)
      .pipe(untilDestroyed(this))
      .subscribe({
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

  /**
   * Handle drag start
   */
  handleDragStart(): void {
    this.isDocked = false;
  }

  /**
   * Load panel settings from localStorage
   */
  private loadPanelSettings(): void {
    const savedWidth = localStorage.getItem("agent-panel-width");
    const savedHeight = localStorage.getItem("agent-panel-height");
    const savedStyle = localStorage.getItem("agent-panel-style");
    const savedDocked = localStorage.getItem("agent-panel-docked");

    // Only restore width if the panel was not docked
    if (savedDocked === "false" && savedWidth) {
      const parsedWidth = Number(savedWidth);
      if (!isNaN(parsedWidth) && parsedWidth >= AgentPanelComponent.MIN_PANEL_WIDTH) {
        this.width = parsedWidth;
      }
    }

    if (savedHeight) {
      const parsedHeight = Number(savedHeight);
      if (!isNaN(parsedHeight) && parsedHeight >= AgentPanelComponent.MIN_PANEL_HEIGHT) {
        this.height = parsedHeight;
      }
    }

    if (savedStyle) {
      const container = document.getElementById("agent-container");
      if (container) {
        container.style.cssText = savedStyle;
        const translates = container.style.transform;
        const [xOffset, yOffset] = calculateTotalTranslate3d(translates);
        this.returnPosition = { x: -xOffset, y: -yOffset };
        this.isDocked = this.dragPosition.x === this.returnPosition.x && this.dragPosition.y === this.returnPosition.y;
      }
    }
  }

  /**
   * Save panel settings to localStorage
   */
  private savePanelSettings(): void {
    localStorage.setItem("agent-panel-width", String(this.width));
    localStorage.setItem("agent-panel-height", String(this.height));
    localStorage.setItem("agent-panel-docked", String(this.width === 0));

    const container = document.getElementById("agent-container");
    if (container) {
      localStorage.setItem("agent-panel-style", container.style.cssText);
    }
  }
}
