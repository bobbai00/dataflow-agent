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
  Component,
  ViewChild,
  ElementRef,
  Input,
  OnInit,
  AfterViewChecked,
  ChangeDetectorRef,
  OnDestroy,
  OnChanges,
  SimpleChanges,
} from "@angular/core";
import { HttpErrorResponse } from "@angular/common/http";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { Subject } from "rxjs";
import { distinctUntilChanged, filter, pairwise, startWith, takeUntil } from "rxjs/operators";
import { AgentState, ReActStep } from "../../../../service/agent/agent-types";
import { AgentFileUpload, AgentFileUploadService } from "../../../../service/agent/agent-file-upload.service";
import { AgentInfo, AgentService, SnapshotTreeResponse } from "../../../../service/agent/agent.service";
import { WorkflowActionService } from "../../../../service/workflow-graph/model/workflow-action.service";
import { NotificationService } from "../../../../../common/service/notification/notification.service";
import { WorkflowPersistService } from "../../../../../common/service/workflow-persist/workflow-persist.service";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { NzSpaceCompactItemDirective } from "ng-zorro-antd/space";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NgIf, NgFor, NgSwitch, NgSwitchCase } from "@angular/common";
import { MarkdownComponent } from "ngx-markdown";
import { NzSpinComponent } from "ng-zorro-antd/spin";
import { NzInputDirective, NzAutosizeDirective } from "ng-zorro-antd/input";
import { FormsModule } from "@angular/forms";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { ReActStepDetailModalComponent } from "../react-step-detail-modal/react-step-detail-modal.component";
import { NzModalComponent, NzModalContentDirective } from "ng-zorro-antd/modal";
import { NzTabsComponent, NzTabComponent } from "ng-zorro-antd/tabs";
import { NzSelectComponent, NzOptionComponent } from "ng-zorro-antd/select";
import { NzInputNumberComponent } from "ng-zorro-antd/input-number";
import { NzSwitchComponent } from "ng-zorro-antd/switch";

/**
 * One snapshot rendered as a clickable box in the snapshot tree (left rail).
 * A snapshot is the workflow state produced by an action-bearing ReAct step;
 * the empty root has no owning step.
 */
export interface SnapshotNode {
  /** Snapshot id (shown as the node label). */
  id: string;
  /** ReAct step whose actions produced this snapshot (undefined for root). */
  reactStepId?: string;
  /** Owning step's time as HH:MM:SS, shown next to the node ("" if unknown). */
  timeLabel: string;
  isRoot: boolean;
  /** True for the snapshot currently rendered on the canvas (HEAD's snapshot). */
  isActive: boolean;
  /** True for snapshots on the root→active path (drawn brighter). */
  isOnActivePath: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One row of the time axis drawn left of the tree: a rank's y and its clock time. */
export interface SnapshotTimeRow {
  y: number;
  label: string;
}

/**
 * One parent→child edge in the snapshot tree, expressed as an SVG path.
 */
export interface SnapshotEdge {
  sourceId: string;
  targetId: string;
  path: string;
  isOnActivePath: boolean;
}

/**
 * One action-bearing ReAct step rendered as a single-line row inside a card.
 */
export interface ChatCardRow {
  step: ReActStep;
  /** Index of this step within `visibleSteps` (for hover → operator highlight). */
  index: number;
  /** Agent thinking text (truncated with ellipsis in the template). */
  thinking: string;
  /** Action labels for the step's tool calls (e.g. "Add operator-3"). */
  actions: string[];
}

/**
 * A rendered item in the chat stream. Consecutive action-bearing agent steps
 * collapse into a single `card`; everything else (user messages, action-less
 * agent replies) renders as a regular `message`.
 */
export type ChatItem = { kind: "message"; step: ReActStep; index: number } | { kind: "card"; rows: ChatCardRow[] };

@UntilDestroy()
@Component({
  selector: "texera-agent-chat",
  templateUrl: "agent-chat.component.html",
  styleUrls: ["agent-chat.component.scss"],
  imports: [
    ɵNzTransitionPatchDirective,
    NzIconDirective,
    NzTooltipDirective,
    NzSpaceCompactItemDirective,
    NzButtonComponent,
    NgIf,
    NgFor,
    NgSwitch,
    NgSwitchCase,
    MarkdownComponent,
    NzSpinComponent,
    NzInputDirective,
    FormsModule,
    NzAutosizeDirective,
    NzWaveDirective,
    ReActStepDetailModalComponent,
    NzModalComponent,
    NzModalContentDirective,
    NzTabsComponent,
    NzTabComponent,
    NzInputNumberComponent,
    NzSwitchComponent,
    NzSelectComponent,
    NzOptionComponent,
  ],
})
export class AgentChatComponent implements OnInit, AfterViewChecked, OnDestroy, OnChanges {
  @Input() agentInfo!: AgentInfo;
  @Input() isActive: boolean = false;
  @ViewChild("messageContainer", { static: false }) messageContainer?: ElementRef;
  @ViewChild("messageInput", { static: false }) messageInput?: ElementRef;
  @ViewChild("timelineContainer", { static: false }) timelineContainer?: ElementRef;
  @ViewChild("treeViewport", { static: false }) treeViewport?: ElementRef<HTMLElement>;

  /** All steps (for timeline rendering) */
  public agentResponses: ReActStep[] = [];
  /** Steps on the HEAD path only (for chat rendering) */
  public visibleSteps: ReActStep[] = [];
  public currentMessage = "";
  private shouldScrollToBottom = false;
  public isDetailsModalVisible = false;
  public selectedResponse: ReActStep | null = null;
  public hoveredMessageIndex: number | null = null;
  public isSystemInfoModalVisible = false;
  public systemPrompt: string = "";
  public availableTools: Array<{ name: string; description: string; inputSchema: any }> = [];
  public agentState: AgentState = AgentState.UNAVAILABLE;

  /** True while a file is being dragged over the panel (drop-zone overlay). */
  public isFileDragOver = false;
  /** In-flight and just-finished drops, newest last; cleared a beat after they finish. */
  public fileUploads: AgentFileUpload[] = [];
  private fileDragDepth = 0;

  /**
   * Debug mode toggle. When true, the input bypasses the LLM:
   *   - `Function(name='...', arguments='...')` → parsed and executed as a
   *     single tool call (no LLM, no ReAct loop).
   *   - anything else → recorded as a plain user ReActStep (no LLM call).
   * Tool execution and post-step operator execution still happen, exactly as
   * if the LLM had produced the same tool call.
   */
  public debugMode = false;
  /** Panel-display preferences (per browser, persisted in localStorage). Both
   *  default to hidden: the next-step context preview and the User/Debug input
   *  toggle are power-user views, switched on from Settings → Parameters. */
  private static readonly SHOW_NEXT_CONTEXT_KEY = "agent-chat-show-next-context";
  private static readonly SHOW_DEBUG_TOGGLE_KEY = "agent-chat-show-debug-toggle";
  public showNextContextPanel: boolean = AgentChatComponent.readPref(AgentChatComponent.SHOW_NEXT_CONTEXT_KEY);
  public showDebugToggle: boolean = AgentChatComponent.readPref(AgentChatComponent.SHOW_DEBUG_TOGGLE_KEY);

  private static readPref(key: string): boolean {
    try {
      return localStorage.getItem(key) === "true";
    } catch {
      return false;
    }
  }

  private static writePref(key: string, value: boolean): void {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // storage unavailable (private mode / tests) — preference just isn't persisted
    }
  }

  public setShowNextContextPanel(show: boolean): void {
    this.showNextContextPanel = show;
    if (!show) this.showNextContext = false;
    AgentChatComponent.writePref(AgentChatComponent.SHOW_NEXT_CONTEXT_KEY, show);
  }

  public setShowDebugToggle(show: boolean): void {
    this.showDebugToggle = show;
    if (!show) this.debugMode = false; // hiding the toggle always returns to User mode
    AgentChatComponent.writePref(AgentChatComponent.SHOW_DEBUG_TOGGLE_KEY, show);
  }

  /** Placeholder shown in the input box, switches with debug mode. */
  public get inputPlaceholder(): string {
    return this.debugMode
      ? "Function(name='...', arguments='{...}') or plain text user step"
      : "Ask me anything about your data science tasks...";
  }

  /**
   * Preview of the next-step model context (markdown). Pushed by the agent
   * service whenever steps, HEAD, workflow, or settings change. Same code
   * path the LLM actually receives via prepareStep — useful in both User and
   * Debug modes for inspecting what the next turn will see.
   */
  public nextStepContext: string = "";
  /** Whether the "Next-Step Context" panel is expanded. Collapsed by default. */
  public showNextContext: boolean = false;

  // Current HEAD step ID in the version tree
  public currentHeadId: string | null = null;

  // Chat stream: action steps grouped into cards, everything else as messages.
  public chatItems: ChatItem[] = [];
  /** Id of the latest action-bearing step — its card row spins while generating. */
  public latestActionStepId: string | null = null;

  // Snapshot tree state (left rail)
  public snapshotTree: SnapshotTreeResponse | null = null;
  public snapshotNodes: SnapshotNode[] = [];
  public snapshotEdges: SnapshotEdge[] = [];
  /** Time axis rows (one per tree rank), rendered in the left gutter. */
  public snapshotTimeRows: SnapshotTimeRow[] = [];
  /** Width of the time-axis gutter in px; nodes are laid out to its right. */
  public readonly treeTimeAxisWidth = 58;
  /** Monotonic guard so a slow snapshot-tree fetch can't clobber a newer one. */
  private snapshotTreeSeq = 0;
  /** Step id to scroll/highlight once visibleSteps refreshes after a checkout. */
  private pendingScrollStepId: string | null = null;
  /** True while stepping through snapshots root→HEAD via the play button. */
  public isPlayingSnapshots = false;
  private snapshotPlaybackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Delay between snapshot checkouts during playback. */
  private readonly snapshotPlaybackIntervalMs = 900;
  /**
   * During playback, the set of snapshot ids revealed so far — the tree only
   * renders these, so snapshots appear progressively as the replay advances.
   * `null` when not playing, meaning the full tree is shown.
   */
  private playbackRevealedIds: Set<string> | null = null;
  public treeCanvasWidth: number = 200;
  public treeHeight: number = 100;
  public treePanelWidth: number = 260;
  public treePanelCollapsed: boolean = false;

  // System info modal state
  public settingsMaxCharLimit = 20000; // Default max characters for operator results
  public settingsMaxCellCharLimit = 4000; // Default max characters per cell
  public settingsToolTimeoutSeconds = 120; // 2 minutes default
  public settingsExecutionTimeoutMinutes = 10; // 10 minutes default
  public settingsMaxSteps = 10; // Default max steps per message
  public settingsAgentMode: "code" | "native" = "native"; // Agent operating mode
  public settingsContextMode: "delta" | "latest" = "delta"; // ReAct context selection policy
  public settingsParallelToolCalls: "enabled" | "disabled" = "enabled"; // Provider-side parallel tool calls
  public settingsDataEvidence: "enabled" | "disabled" = "enabled"; // Column/table facts on observed results
  public settingsFlowEvidence: "enabled" | "disabled" = "disabled"; // Input/output facts on observed results

  // Track if we disabled auto-persist so we can re-enable it on destroy
  private disabledAutoPersist = false;

  // Subject to control workflow subscription lifecycle
  private stopWorkflowSubscription$ = new Subject<void>();

  constructor(
    private agentService: AgentService,
    private workflowActionService: WorkflowActionService,
    private notificationService: NotificationService,
    private cdr: ChangeDetectorRef,
    private workflowPersistService: WorkflowPersistService,
    private agentFileUploadService: AgentFileUploadService
  ) {}

  ngOnInit(): void {
    if (!this.agentInfo) {
      return;
    }

    // Ensure workflow polling is started if we have a workflowId
    // This handles agents created via API that weren't created through the UI
    const workflowId = this.agentInfo.delegate?.workflowId;
    if (workflowId) {
      this.agentService.ensureWorkflowPolling(this.agentInfo.id, workflowId);
    }

    // Get the current state from manager service
    this.agentService
      .getAgentState(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(state => {
        this.agentState = state;
        // Immediately trigger change detection to show the current state
        this.cdr.detectChanges();
      });

    // Then subscribe to agent state changes (BehaviorSubject will immediately emit current value)
    this.agentService
      .getAgentStateObservable(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(state => {
        this.agentState = state;
        // Force immediate change detection
        this.cdr.detectChanges();
      });

    // Subscribe to ReActSteps
    this.agentService
      .getReActStepsObservable(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(steps => {
        this.agentResponses = steps;
        this.updateVisibleSteps();
        this.buildChatItems();
        this.shouldScrollToBottom = true;

        // The canvas highlight follows the pointer only — new steps never grab
        // it. Drop a hover that a checkout left pointing past the end.
        if (this.hoveredMessageIndex !== null && this.hoveredMessageIndex >= this.visibleSteps.length) {
          this.setHoveredMessage(null);
        }

        // Trigger change detection
        this.cdr.detectChanges();
        this.flushPendingScroll();
      });

    // Subscribe to HEAD changes
    this.agentService
      .getHeadIdObservable(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(headId => {
        this.currentHeadId = headId;
        this.updateVisibleSteps();
        this.buildChatItems();
        // HEAD moved (new step or checkout): the active snapshot and the tree
        // shape may both have changed — refetch and rebuild.
        this.refreshSnapshotTree();
        this.cdr.detectChanges();
        this.flushPendingScroll();
      });

    // Refresh the snapshot tree when the workflow snapshot changes. The agent
    // creates a snapshot AFTER emitting the action step (see
    // `maybeCreateSnapshotForHead`), broadcasting a `snapshot` WS frame that
    // lands here — so this is the reliable signal that a new snapshot exists.
    this.agentService
      .getWorkflowObservable(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        this.refreshSnapshotTree();
      });

    // Subscribe to the next-step context preview (markdown). Backend pushes
    // this on init and after every step / complete / clear / checkout /
    // settings change, so the panel always reflects what the LLM would see.
    this.agentService
      .getNextContextObservable(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(content => {
        this.nextStepContext = content;
        this.cdr.detectChanges();
      });

    // Subscribe to agent state changes to manage auto-persist
    // Disable auto-persist when agent is GENERATING, re-enable when AVAILABLE
    this.agentService
      .getAgentStateObservable(this.agentInfo.id)
      .pipe(startWith(AgentState.UNAVAILABLE), pairwise(), untilDestroyed(this))
      .subscribe(([previousState, currentState]) => {
        // When agent starts generating, disable auto-persist
        if (currentState === AgentState.GENERATING && previousState !== AgentState.GENERATING) {
          this.workflowPersistService.setWorkflowPersistFlag(false);
          this.disabledAutoPersist = true;
        }

        // When agent finishes (becomes AVAILABLE from GENERATING/STOPPING), re-enable auto-persist
        if (
          currentState === AgentState.AVAILABLE &&
          (previousState === AgentState.GENERATING || previousState === AgentState.STOPPING)
        ) {
          this.workflowPersistService.setWorkflowPersistFlag(true);
          this.disabledAutoPersist = false;
        }
      });

    // Note: Workflow subscription is started/stopped via ngOnChanges based on isActive
    // This prevents automatic workflow switching when multiple agents are running

    // Start workflow subscription if already active
    if (this.isActive) {
      this.startWorkflowSubscription();
    }

    // Subscribe to scroll-to-step requests
    this.agentService.scrollToStep$.pipe(untilDestroyed(this)).subscribe(({ agentId, messageId, stepId }) => {
      if (agentId === this.agentInfo.id) {
        this.scrollToStep(messageId, stepId);
      }
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["isActive"]) {
      if (this.isActive) {
        this.startWorkflowSubscription();
      } else {
        this.stopWorkflowSubscription();
      }
    }
  }

  /**
   * Start subscribing to workflow changes from the agent.
   * Only called when this agent tab is active.
   */
  private startWorkflowSubscription(): void {
    if (!this.agentInfo) {
      return;
    }

    // Stop any existing subscription first
    this.stopWorkflowSubscription$.next();

    this.agentService
      .getWorkflowObservable(this.agentInfo.id)
      .pipe(
        filter(workflow => workflow !== null),
        distinctUntilChanged((prev, curr) => {
          // Compare workflow content to avoid unnecessary reloads
          if (!prev || !curr) return false;
          return JSON.stringify(prev.content) === JSON.stringify(curr.content);
        }),
        takeUntil(this.stopWorkflowSubscription$),
        untilDestroyed(this)
      )
      .subscribe(workflow => {
        if (workflow) {
          this.workflowActionService.reloadWorkflow(workflow, false, false);
        }
      });
  }

  /**
   * Stop subscribing to workflow changes.
   * Called when switching away from this agent tab.
   */
  private stopWorkflowSubscription(): void {
    this.stopWorkflowSubscription$.next();
  }

  ngOnDestroy(): void {
    // Stop any in-progress snapshot playback timer. Done inline (rather than
    // via stopSnapshotPlayback) so we don't run change detection on a view
    // that's being torn down.
    this.isPlayingSnapshots = false;
    this.playbackRevealedIds = null;
    if (this.snapshotPlaybackTimer !== null) {
      clearTimeout(this.snapshotPlaybackTimer);
      this.snapshotPlaybackTimer = null;
    }

    // Stop workflow subscription
    this.stopWorkflowSubscription$.next();
    this.stopWorkflowSubscription$.complete();

    // Re-enable auto-persist if we disabled it
    if (this.disabledAutoPersist) {
      this.workflowPersistService.setWorkflowPersistFlag(true);
    }
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom();
      this.shouldScrollToBottom = false;
    }
  }

  // ============================================================================
  // Drag & drop file upload
  // ============================================================================

  /** How long a finished upload row stays visible before it clears itself. */
  private static readonly UPLOAD_ROW_LINGER_MS = 2500;

  /** Only file drags open the drop zone — dragging an operator must not. */
  private static isFileDrag(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    return !!types && Array.from(types).includes("Files");
  }

  public onFileDragEnter(event: DragEvent): void {
    if (!AgentChatComponent.isFileDrag(event)) {
      return;
    }
    event.preventDefault();
    this.fileDragDepth++;
    this.isFileDragOver = true;
  }

  public onFileDragOver(event: DragEvent): void {
    if (!AgentChatComponent.isFileDrag(event)) {
      return;
    }
    // Without preventDefault the browser navigates to the file on drop.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  }

  /**
   * `dragleave` fires for every child element the pointer crosses, so count
   * enters/leaves instead of clearing on the first one — otherwise the overlay
   * flickers as the pointer moves across the panel.
   */
  public onFileDragLeave(event: DragEvent): void {
    if (!AgentChatComponent.isFileDrag(event)) {
      return;
    }
    this.fileDragDepth = Math.max(0, this.fileDragDepth - 1);
    if (this.fileDragDepth === 0) {
      this.isFileDragOver = false;
    }
  }

  public onFileDrop(event: DragEvent): void {
    if (!AgentChatComponent.isFileDrag(event)) {
      return;
    }
    event.preventDefault();
    this.fileDragDepth = 0;
    this.isFileDragOver = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) {
      this.uploadDroppedFiles(files);
    }
  }

  /**
   * Upload dropped files into the user's `agent-uploads` dataset and append the
   * resulting dataset paths to the message being composed, so the next thing
   * the user types is the task for those files.
   */
  private uploadDroppedFiles(files: File[]): void {
    const pending: AgentFileUpload[] = files.map(file => ({
      fileName: AgentFileUploadService.sanitizeFileName(file.name),
      percentage: 0,
      status: "uploading",
    }));
    this.fileUploads = [...this.fileUploads, ...pending];
    this.cdr.detectChanges();

    this.agentFileUploadService
      .uploadFiles(files)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: update => {
          this.mergeUploadState(update);
          if (update.status === "done" && update.path) {
            this.appendToMessage(update.path);
          }
          this.cdr.detectChanges();
        },
        error: (err: unknown) => {
          const message = err instanceof HttpErrorResponse ? err.error?.message || err.message : String(err);
          this.notificationService.error(`File upload failed: ${message}`);
          pending.forEach(p => this.mergeUploadState({ ...p, status: "failed", error: message }));
          this.cdr.detectChanges();
          this.scheduleUploadRowCleanup();
        },
        complete: () => this.scheduleUploadRowCleanup(),
      });
  }

  private mergeUploadState(update: AgentFileUpload): void {
    const index = this.fileUploads.findIndex(u => u.fileName === update.fileName && u.status !== "done");
    if (index === -1) {
      this.fileUploads = [...this.fileUploads, update];
      return;
    }
    this.fileUploads = this.fileUploads.map((u, i) => (i === index ? { ...u, ...update } : u));
  }

  /** Append text to the composer, keeping whatever the user already typed. */
  private appendToMessage(text: string): void {
    const current = this.currentMessage.trimEnd();
    this.currentMessage = current.length > 0 ? `${current} ${text}` : text;
    this.messageInput?.nativeElement.focus();
  }

  private scheduleUploadRowCleanup(): void {
    setTimeout(() => {
      this.fileUploads = this.fileUploads.filter(u => u.status !== "done" && u.status !== "failed");
      this.cdr.detectChanges();
    }, AgentChatComponent.UPLOAD_ROW_LINGER_MS);
  }

  public setHoveredMessage(index: number | null): void {
    // Unhovering clears the canvas labels: the highlight is a pointer affordance,
    // nothing keeps it lit on its own.
    this.hoveredMessageIndex = index;
    const hoveredStep = index !== null && index >= 0 ? this.visibleSteps[index] : null;
    this.agentService.setHoveredMessage(this.agentInfo.id, hoveredStep);
  }

  public showResponseDetails(response: ReActStep): void {
    this.selectedResponse = response;
    this.isDetailsModalVisible = true;
  }

  public closeDetailsModal(): void {
    this.isDetailsModalVisible = false;
    this.selectedResponse = null;
  }

  public showSystemInfo(): void {
    this.refreshSystemInfo();
    this.isSystemInfoModalVisible = true;
  }

  /**
   * Refresh system info from the agent.
   */
  private refreshSystemInfo(): void {
    this.agentService
      .getSystemInfo(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(systemInfo => {
        this.systemPrompt = systemInfo.systemPrompt;
        this.availableTools = systemInfo.tools;
      });

    // Fetch settings from server
    this.agentService
      .getAgentSettings(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(settings => {
        this.settingsMaxCharLimit = settings.maxOperatorResultCharLimit ?? 20000;
        this.settingsMaxCellCharLimit = settings.maxOperatorResultCellCharLimit ?? 4000;
        this.settingsToolTimeoutSeconds = settings.toolTimeoutSeconds ?? 120;
        this.settingsExecutionTimeoutMinutes = settings.executionTimeoutMinutes ?? 10;
        this.settingsMaxSteps = settings.maxSteps ?? 10;
        this.settingsAgentMode = settings.agentMode ?? "native";
        this.settingsContextMode = settings.contextMode ?? "delta";
        // Backend default for `parallelToolCalls` is true (DEFAULT_AGENT_SETTINGS),
        // so a missing value here means "enabled" — not "disabled".
        this.settingsParallelToolCalls = settings.parallelToolCalls === false ? "disabled" : "enabled";
        // Backend defaults (DEFAULT_AGENT_SETTINGS): dataEvidence true, flowEvidence false.
        this.settingsDataEvidence = settings.dataEvidence === false ? "disabled" : "enabled";
        this.settingsFlowEvidence = settings.flowEvidence === true ? "enabled" : "disabled";
        // Keep the parent's @Input snapshot in sync so the rest of the UI
        // (System Prompt tab, registration display, etc.) sees the latest
        // values rather than the stale ones captured at agent creation.
        if (this.agentInfo.settings) {
          this.agentInfo.settings.agentMode = settings.agentMode;
          this.agentInfo.settings.contextMode = settings.contextMode;
          this.agentInfo.settings.parallelToolCalls = settings.parallelToolCalls;
          this.agentInfo.settings.dataEvidence = settings.dataEvidence;
          this.agentInfo.settings.flowEvidence = settings.flowEvidence;
        }
      });
  }

  public closeSystemInfoModal(): void {
    this.isSystemInfoModalVisible = false;
  }

  public getToolResult(response: ReActStep, toolCallIndex: number): any {
    if (!response.toolResults || toolCallIndex >= response.toolResults.length) {
      return null;
    }
    const toolResult = response.toolResults[toolCallIndex];
    return toolResult.output || toolResult.result || toolResult;
  }

  public getToolOperatorAccess(
    response: ReActStep,
    toolCallIndex: number
  ): { viewedOperatorIds: string[]; modifiedOperatorIds: string[] } | null {
    if (!response.operatorAccess) {
      return null;
    }
    return response.operatorAccess.get(toolCallIndex) || null;
  }

  public hasOperatorAccess(response: ReActStep): boolean {
    return !!response.operatorAccess && response.operatorAccess.size > 0;
  }

  /** Toggle the Next-Step Context preview panel. */
  public toggleNextContext(): void {
    this.showNextContext = !this.showNextContext;
  }

  /**
   * Copy the raw next-step context (the markdown source, not rendered HTML)
   * to the clipboard. Falls back to a hidden textarea + execCommand when the
   * async clipboard API is unavailable (e.g. in an insecure context).
   */
  public copyNextContext(event: Event): void {
    event.stopPropagation();
    if (!this.nextStepContext) {
      this.notificationService.warning("Next-step context is empty");
      return;
    }
    const text = this.nextStepContext;
    const done = () => this.notificationService.success(`Copied next-step context (${text.length} chars)`);
    const fail = (err: unknown) => {
      console.error("Copy failed:", err);
      this.notificationService.error("Failed to copy to clipboard");
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(done)
        .catch(() => {
          if (this.fallbackCopy(text)) done();
          else fail(new Error("clipboard API rejected and fallback failed"));
        });
    } else if (this.fallbackCopy(text)) {
      done();
    } else {
      fail(new Error("no clipboard API available"));
    }
  }

  /** Synchronous clipboard write — used when navigator.clipboard is unavailable. */
  private fallbackCopy(text: string): boolean {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  public sendMessage(): void {
    // A new message advances HEAD; stop any snapshot playback first.
    this.stopSnapshotPlayback();
    if (!this.currentMessage.trim() || !this.canSendMessage()) {
      return;
    }

    const userMessage = this.currentMessage.trim();
    this.currentMessage = "";

    // Fire-and-forget; responses stream in via the WebSocket subscription.
    // Debug mode dispatches a `type:"debug"` WS frame instead, which bypasses
    // the LLM and either records the input as a user step or parses it as a
    // Function(...) tool call.
    if (this.debugMode) {
      this.agentService.sendDebugInput(this.agentInfo.id, userMessage);
    } else {
      this.agentService.sendMessage(this.agentInfo.id, userMessage);
    }
  }

  /**
   * Check if messages can be sent (only when agent is available).
   */
  public canSendMessage(): boolean {
    return this.agentState === AgentState.AVAILABLE;
  }

  /**
   * Get the NG-ZORRO icon type based on current agent state.
   */
  public getStateIcon(): string {
    switch (this.agentState) {
      case AgentState.AVAILABLE:
        return "check-circle";
      case AgentState.GENERATING:
      case AgentState.STOPPING:
        return "sync";
      case AgentState.UNAVAILABLE:
      default:
        return "close-circle";
    }
  }

  /**
   * Get the icon color based on current agent state.
   */
  public getStateIconColor(): string {
    switch (this.agentState) {
      case AgentState.AVAILABLE:
        return "#52c41a";
      case AgentState.GENERATING:
      case AgentState.STOPPING:
        return "#1890ff";
      case AgentState.UNAVAILABLE:
      default:
        return "#ff4d4f";
    }
  }

  /**
   * Get the tooltip text for the state icon.
   */
  public getStateTooltip(): string {
    switch (this.agentState) {
      case AgentState.AVAILABLE:
        return "Agent is ready";
      case AgentState.GENERATING:
        return "Agent is generating response...";
      case AgentState.STOPPING:
        return "Agent is stopping...";
      case AgentState.UNAVAILABLE:
        return "Agent is unavailable";
      default:
        return "Agent status unknown";
    }
  }

  public onEnterPress(event: KeyboardEvent): void {
    if (!event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  private scrollToBottom(): void {
    if (this.messageContainer) {
      const element = this.messageContainer.nativeElement;
      element.scrollTop = element.scrollHeight;
    }
  }

  public stopGeneration(): void {
    this.agentService.stopGeneration(this.agentInfo.id);
  }

  public clearMessages(): void {
    this.agentService.clearMessages(this.agentInfo.id);
  }

  /**
   * Export the ReAct steps as a JSON file.
   * Fetches steps from the backend to get clean JSON (without Map objects).
   */
  public exportReActSteps(): void {
    if (this.visibleSteps.length === 0) {
      this.notificationService.warning("No ReAct steps to export");
      return;
    }

    this.agentService
      .getReActSteps(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: (steps: ReActStep[]) => {
          // Convert steps to plain objects (handle Map -> object for operatorAccess)
          const exportSteps = steps.map(step => {
            const plain: any = { ...step };
            if (step.operatorAccess) {
              const accessObj: Record<string, any> = {};
              step.operatorAccess.forEach((value, key) => {
                accessObj[key] = value;
              });
              plain.operatorAccess = accessObj;
            }
            return plain;
          });

          const exportData = {
            agentId: this.agentInfo.id,
            agentName: this.agentInfo.name,
            modelType: this.agentInfo.modelType,
            exportedAt: new Date().toISOString(),
            stepCount: exportSteps.length,
            steps: exportSteps,
          };

          const jsonString = JSON.stringify(exportData, null, 2);
          const blob = new Blob([jsonString], { type: "application/json" });
          const url = URL.createObjectURL(blob);

          const link = document.createElement("a");
          link.href = url;
          link.download = `${this.agentInfo.name}-react-steps-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);

          URL.revokeObjectURL(url);

          this.notificationService.success(`Exported ${exportSteps.length} ReAct steps`);
        },
        error: (err: unknown) => {
          console.error("Failed to export ReAct steps:", err);
          this.notificationService.error("Failed to export ReAct steps");
        },
      });
  }

  /**
   * Handler for the hidden <input type="file"> next to the import button.
   * Reads the selected JSON, validates it carries a `steps` array, then POSTs
   * to /agents/:id/import-react-steps. The backend broadcasts headChange +
   * nextContext on success, so timeline / DAG / context panel refresh
   * automatically via existing WS subscriptions.
   */
  public onReActStepsFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Reset the input so re-selecting the same file fires `change` again.
    input.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => {
      this.notificationService.error("Failed to read file");
    };
    reader.onload = () => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(reader.result ?? ""));
      } catch (e) {
        this.notificationService.error("File is not valid JSON");
        return;
      }
      const steps = Array.isArray(parsed?.steps) ? parsed.steps : Array.isArray(parsed) ? parsed : null;
      if (!steps || steps.length === 0) {
        this.notificationService.error("JSON does not contain a non-empty `steps` array");
        return;
      }
      this.agentService
        .importReActSteps(this.agentInfo.id, steps)
        .pipe(untilDestroyed(this))
        .subscribe({
          next: result => {
            this.notificationService.success(`Imported ${result.importedCount} ReAct steps`);
          },
          error: err => {
            console.error("Failed to import ReAct steps:", err);
            const detail = err?.error?.message || err?.message || "Unknown error";
            this.notificationService.error(`Import failed: ${detail}`);
          },
        });
    };
    reader.readAsText(file);
  }

  public isGenerating(): boolean {
    return this.agentState === AgentState.GENERATING;
  }

  public isAvailable(): boolean {
    return this.agentState === AgentState.AVAILABLE;
  }

  public isConnected(): boolean {
    return this.agentState !== AgentState.UNAVAILABLE;
  }

  public isStopping(): boolean {
    return this.agentState === AgentState.STOPPING;
  }

  /**
   * Recompute visibleSteps: only steps on the ancestor path from root to HEAD.
   */
  private updateVisibleSteps(): void {
    if (!this.currentHeadId || this.agentResponses.length === 0) {
      this.visibleSteps = this.agentResponses;
      return;
    }
    const stepMap = new Map(this.agentResponses.map(s => [s.id, s]));
    const ancestorIds = new Set<string>();
    let current: string | undefined = this.currentHeadId;
    while (current) {
      ancestorIds.add(current);
      current = stepMap.get(current)?.parentId;
    }
    this.visibleSteps = this.agentResponses.filter(s => ancestorIds.has(s.id));
  }

  // ============================================================================
  // Chat stream — group action steps into cards
  // ============================================================================

  /**
   * Rebuild `chatItems` from `visibleSteps`. Consecutive action-bearing agent
   * steps (those with tool calls) collapse into a single card of single-line
   * rows; user messages and action-less agent replies stay regular messages.
   * Also records `latestActionStepId` so the most recent action row can show a
   * live spinner while the agent is still generating.
   */
  private buildChatItems(): void {
    const items: ChatItem[] = [];
    let currentCard: ChatCardRow[] | null = null;

    this.visibleSteps.forEach((step, index) => {
      if (this.isActionStep(step)) {
        const row: ChatCardRow = {
          step,
          index,
          // `content` is the model's visible preamble; reasoning models often
          // emit tool calls with none, and only expose a reasoning summary.
          thinking: (step.content || step.reasoningText || "").trim(),
          actions: this.getActionLabels(step),
        };
        if (currentCard) {
          currentCard.push(row);
        } else {
          currentCard = [row];
          items.push({ kind: "card", rows: currentCard });
        }
      } else {
        currentCard = null;
        items.push({ kind: "message", step, index });
      }
    });

    this.chatItems = items;

    let latest: string | null = null;
    for (const step of this.visibleSteps) {
      if (this.isActionStep(step)) latest = step.id;
    }
    this.latestActionStepId = latest;
  }

  /** An agent step that performed at least one tool call (action). */
  public isActionStep(step: ReActStep): boolean {
    return step.role === "agent" && Array.isArray(step.toolCalls) && step.toolCalls.length > 0;
  }

  /**
   * Whether a card row should show the live spinner: the latest action step,
   * either while the agent is generating or while replaying snapshots (where
   * the latest visible action step is the snapshot currently being played).
   * All other rows show a checkmark.
   */
  public isRowRunning(row: ChatCardRow): boolean {
    return (this.isGenerating() || this.isPlayingSnapshots) && row.step.id === this.latestActionStepId;
  }

  /** Template type-guard — returns the card variant of a ChatItem, else null. */
  public asCard(item: ChatItem): { rows: ChatCardRow[] } | null {
    return item.kind === "card" ? item : null;
  }

  /** Template type-guard — returns the message variant of a ChatItem, else null. */
  public asMessage(item: ChatItem): { step: ReActStep; index: number } | null {
    return item.kind === "message" ? item : null;
  }

  /**
   * Aggregated action labels for a step's tool calls. Calls are grouped by
   * verb and counted, so a step that adds three operators reads "Add 3
   * operators" rather than three separate per-id chips — keeps the row compact
   * regardless of how long individual operator ids are. Verbs keep their
   * first-seen order.
   */
  private getActionLabels(step: ReActStep): string[] {
    if (!step.toolCalls || step.toolCalls.length === 0) return [];
    const counts = new Map<string, number>();
    for (const tc of step.toolCalls as any[]) {
      const verb = this.getToolLabel(tc.toolName);
      counts.set(verb, (counts.get(verb) ?? 0) + 1);
    }
    return [...counts].map(([verb, count]) => `${verb} ${count} operator${count === 1 ? "" : "s"}`);
  }

  // ============================================================================
  // Snapshot tree (left rail) — the workflow-snapshot version tree
  // ============================================================================

  /**
   * Refetch the agent's snapshot tree and rebuild the rail. A monotonic
   * sequence guard drops responses that are superseded by a newer fetch.
   */
  private refreshSnapshotTree(): void {
    if (!this.agentInfo) return;
    const seq = ++this.snapshotTreeSeq;
    this.agentService
      .getSnapshotTree(this.agentInfo.id)
      .pipe(untilDestroyed(this))
      .subscribe(tree => {
        if (seq !== this.snapshotTreeSeq) return;
        this.snapshotTree = tree;
        this.buildSnapshotTree();
        this.cdr.detectChanges();
      });
  }

  /**
   * Lay out the snapshot tree as a time line (top-to-bottom): the y axis is
   * chronological, so **every snapshot gets its own row** — two snapshots never
   * share a level, even when they are siblings on different branches. Branches
   * are separated on the x axis instead, each fork taking the next free lane
   * (git-log style). Rows are ordered by timestamp under the constraint that a
   * parent is always placed above its children.
   *
   * Every node shows its snapshot id; all nodes share one colour except the
   * active one (the snapshot currently rendered on the canvas — HEAD's
   * snapshot), which gets a distinct fill plus a dashed outline. Snapshots on
   * the root→active path are drawn brighter.
   *
   * The synthetic empty-root snapshot (the backend's "S0") is excluded by the
   * agent service, so every node here is a real, step-owned snapshot; its
   * children surface as the visible top-level nodes.
   */
  public buildSnapshotTree(): void {
    const tree = this.snapshotTree;
    // During playback only the snapshots revealed so far are shown, so they
    // appear progressively; otherwise the full tree is rendered.
    const allNodes = tree ? tree.nodes : [];
    const nodes = this.playbackRevealedIds ? allNodes.filter(n => this.playbackRevealedIds!.has(n.id)) : allNodes;
    if (!tree || nodes.length === 0) {
      this.snapshotNodes = [];
      this.snapshotEdges = [];
      this.snapshotTimeRows = [];
      this.treeCanvasWidth = 200;
      this.treeHeight = 100;
      return;
    }

    const activeId = this.computeActiveSnapshotId(nodes);

    // Snapshots on the path from root to the active node (brighter edges/nodes).
    const byId = new Map(nodes.map(n => [n.id, n]));
    const activePath = new Set<string>();
    let cursor: string | undefined = activeId;
    while (cursor) {
      activePath.add(cursor);
      cursor = byId.get(cursor)?.parentId;
    }

    // Compact pills: one line (the snapshot id). The timestamp lives on the
    // time axis to the left, one label per row, so rows stay short.
    const minNodeWidth = 40;
    const maxNodeWidth = 160;
    const charWidth = 7;
    const horizontalPadding = 14;
    const nodeHeight = 22;
    const rowPitch = nodeHeight + 8;
    // Wide enough that a lane's pills clear the vertical edge line of the lane
    // to their left, so parallel branches read as separate columns.
    const laneIndent = 34;
    const marginX = 10;
    const marginY = 10;

    const nodeWidths = new Map<string, number>();
    for (const n of nodes) {
      const width = Math.max(minNodeWidth, Math.min(maxNodeWidth, n.id.length * charWidth + horizontalPadding));
      nodeWidths.set(n.id, width);
    }

    const ordered = AgentChatComponent.orderSnapshotsByTime(nodes);
    const lanes = AgentChatComponent.assignSnapshotLanes(ordered);

    this.snapshotNodes = ordered.map((n, row) => ({
      id: n.id,
      reactStepId: n.reactStepId,
      timeLabel: AgentChatComponent.formatClockTime(n.timestamp),
      isRoot: !n.parentId,
      isActive: n.id === activeId,
      isOnActivePath: activePath.has(n.id),
      x: this.treeTimeAxisWidth + marginX + lanes.get(n.id)! * laneIndent + nodeWidths.get(n.id)! / 2,
      y: marginY + nodeHeight / 2 + row * rowPitch,
      width: nodeWidths.get(n.id)!,
      height: nodeHeight,
    }));

    // Time axis: one label per row, since each row holds exactly one snapshot.
    // Consecutive rows with the same clock time show the label once, so bursts
    // of snapshots inside the same second don't repeat it.
    let lastLabel = "";
    this.snapshotTimeRows = this.snapshotNodes.map(n => {
      const label = n.timeLabel === lastLabel ? "" : n.timeLabel;
      lastLabel = n.timeLabel;
      return { y: n.y, label };
    });

    const nodeMap = new Map(this.snapshotNodes.map(n => [n.id, n]));
    this.snapshotEdges = ordered
      .filter(n => n.parentId && nodeMap.has(n.parentId))
      .map(n => {
        const source = nodeMap.get(n.parentId!)!;
        const target = nodeMap.get(n.id)!;
        const onPath = activePath.has(n.parentId!) && activePath.has(n.id);
        const startY = source.y + source.height / 2;
        const endY = target.y - target.height / 2;
        // Same lane: a straight drop. Different lane (a fork): peel off right
        // below the parent, then run down the child's own lane — so the split
        // is visible at the fork point instead of the branch shadowing its
        // sibling's column for several rows before stepping sideways.
        const peelY = Math.min(startY + Math.min(14, (endY - startY) / 2), endY);
        const path =
          source.x === target.x
            ? `M ${source.x} ${startY} L ${target.x} ${endY}`
            : `M ${source.x} ${startY} C ${source.x} ${peelY}, ${target.x} ${startY}, ${target.x} ${peelY} ` +
              `L ${target.x} ${endY}`;
        return { sourceId: n.parentId!, targetId: n.id, path, isOnActivePath: onPath };
      });

    const maxX = Math.max(...this.snapshotNodes.map(n => n.x + n.width / 2), 180);
    const maxY = Math.max(...this.snapshotNodes.map(n => n.y + n.height / 2), 80);
    this.treeCanvasWidth = Math.max(180, maxX + marginX);
    this.treeHeight = maxY + marginY;
    setTimeout(() => this.scrollActiveSnapshotIntoView(), 0);
  }

  /**
   * Keep the active snapshot visible in the rail. One row per snapshot means a
   * long session scrolls past the viewport, so centre the active row whenever it
   * sits outside the visible band — and leave the scroll alone when it doesn't,
   * so this never fights a user who scrolled back through history.
   */
  private scrollActiveSnapshotIntoView(): void {
    const viewport = this.treeViewport?.nativeElement;
    const active = this.snapshotNodes.find(n => n.isActive);
    if (!viewport || !active || viewport.clientHeight === 0) {
      return;
    }
    const top = active.y - active.height / 2;
    const bottom = active.y + active.height / 2;
    if (top < viewport.scrollTop || bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = Math.max(0, active.y - viewport.clientHeight / 2);
    }
  }

  /** Format an epoch-ms timestamp as HH:MM:SS, or "" when unknown. */
  private static formatClockTime(timestamp?: number | null): string {
    if (timestamp === undefined || timestamp === null) {
      return "";
    }
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) {
      return "";
    }
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /**
   * Chronological row order for the snapshot tree: repeatedly take the oldest
   * snapshot whose parent is already placed, so rows read as a time line while
   * a parent never lands below one of its children (timestamps come from the
   * owning ReAct step and can tie or be missing). Snapshots with no timestamp
   * sort last among the currently placeable ones; the input order breaks ties.
   */
  public static orderSnapshotsByTime(nodes: SnapshotTreeResponse["nodes"]): SnapshotTreeResponse["nodes"] {
    const ids = new Set(nodes.map(n => n.id));
    const remaining = nodes.map((node, inputIndex) => ({ node, inputIndex }));
    const placed = new Set<string>();
    const ordered: SnapshotTreeResponse["nodes"] = [];

    while (remaining.length > 0) {
      const ready = remaining.filter(
        ({ node }) => !node.parentId || !ids.has(node.parentId) || placed.has(node.parentId)
      );
      // Cycle or a parent outside the node set: fall back to input order so the
      // rail still renders every snapshot instead of dropping the rest.
      const pool = ready.length > 0 ? ready : remaining;
      let best = pool[0];
      for (const candidate of pool) {
        const a = candidate.node.timestamp ?? Number.POSITIVE_INFINITY;
        const b = best.node.timestamp ?? Number.POSITIVE_INFINITY;
        if (a < b || (a === b && candidate.inputIndex < best.inputIndex)) {
          best = candidate;
        }
      }
      ordered.push(best.node);
      placed.add(best.node.id);
      remaining.splice(
        remaining.findIndex(entry => entry === best),
        1
      );
    }
    return ordered;
  }

  /**
   * Lane (x column) per snapshot, assigned over the chronological row order: a
   * parent's **chronologically first** child continues its lane, every later
   * child — i.e. every fork — opens the next lane to the right, and roots each
   * get their own lane.
   *
   * Deliberately independent of HEAD: lanes depend only on the snapshots and
   * their timestamps, so checking out another snapshot leaves the tree's shape
   * untouched and moves only the highlight. Layout therefore grows
   * append-only — an existing node never changes column or row.
   */
  public static assignSnapshotLanes(ordered: SnapshotTreeResponse["nodes"]): Map<string, number> {
    const firstChild = new Map<string, string>();
    for (const node of ordered) {
      if (node.parentId !== undefined && !firstChild.has(node.parentId)) {
        firstChild.set(node.parentId, node.id);
      }
    }

    const lanes = new Map<string, number>();
    let nextFreeLane = 0;
    for (const node of ordered) {
      const parentLane = node.parentId === undefined ? undefined : lanes.get(node.parentId);
      const continuesParent = node.parentId !== undefined && firstChild.get(node.parentId) === node.id;
      lanes.set(node.id, parentLane !== undefined && continuesParent ? parentLane : nextFreeLane++);
    }
    return lanes;
  }

  /**
   * The snapshot currently rendered on the canvas: walk the ReAct ancestor
   * chain from HEAD and return the first snapshot owned by one of those steps.
   * Falls back to the empty root when no ancestor owns a snapshot.
   */
  private computeActiveSnapshotId(nodes: SnapshotTreeResponse["nodes"]): string {
    const snapshotByOwner = new Map<string, string>();
    for (const n of nodes) {
      if (n.reactStepId) snapshotByOwner.set(n.reactStepId, n.id);
    }
    const stepMap = new Map(this.agentResponses.map(s => [s.id, s]));
    let current: string | undefined = this.currentHeadId ?? undefined;
    while (current) {
      const sid = snapshotByOwner.get(current);
      if (sid) return sid;
      current = stepMap.get(current)?.parentId;
    }
    return this.snapshotTree?.rootId ?? "";
  }

  /** Short verb for a tool call name. */
  private getToolLabel(toolName: string): string {
    switch (toolName) {
      case "addOperator":
        return "Add";
      case "modifyOperator":
        return "Modify";
      case "createOrModifyOperator":
        // CODE-mode unified tool — verb depends on whether the op already existed,
        // which we can't tell from the call alone. "Edit" reads correctly for both.
        return "Edit";
      case "deleteOperator":
        return "Delete";
      case "executeOperator":
        return "Execute";
      default:
        return toolName;
    }
  }

  /**
   * Click on a snapshot node → navigate to the ReAct steps that produced it.
   * A snapshot may correspond to multiple steps (the action-bearing step plus
   * any trailing action-less replies that resolve to it); we checkout the
   * deepest of those so all of them become visible on the HEAD path, which
   * also moves the "currently rendered" highlight to this snapshot and
   * restores its workflow on the canvas. The chat then scrolls to the first
   * of the snapshot's steps.
   */
  public onSnapshotNodeClick(node: SnapshotNode): void {
    this.stopSnapshotPlayback();
    this.checkoutSnapshot(node.reactStepId, node.id);
  }

  /**
   * Checkout the snapshot owned by `reactStepId`. A snapshot may correspond to
   * multiple steps (the action-bearing step plus any trailing action-less
   * replies that resolve to it); we checkout the deepest of those so all of
   * them land on the HEAD path and become visible, moving the "currently
   * rendered" highlight to this snapshot and restoring its workflow on the
   * canvas, then scroll to the first. If the group is empty — e.g. the first
   * snapshot whose only owning step is the hidden bootstrap step — fall back to
   * the owning step itself so the node still restores its workflow.
   */
  private checkoutSnapshot(reactStepId: string | undefined, label: string): void {
    const group = this.getSnapshotReactSteps(reactStepId);
    const targetStepId = group.length > 0 ? group[group.length - 1].id : reactStepId;
    if (!targetStepId) return;
    this.pendingScrollStepId = group.length > 0 ? group[0].id : null;
    this.agentService.checkoutStep(this.agentInfo.id, targetStepId).subscribe({
      next: () => {},
      error: () => {
        this.pendingScrollStepId = null;
        this.notificationService.error(`Checkout to snapshot ${label} failed`);
      },
    });
  }

  /**
   * The ReAct steps that correspond to a snapshot: every step whose nearest
   * action-bearing ancestor (inclusive) is the given owning step. For the
   * empty root that's the steps with no action-bearing ancestor. Ordered
   * chronologically (earliest first).
   */
  private getSnapshotReactSteps(reactStepId: string | undefined): ReActStep[] {
    const owners = new Set<string>();
    for (const n of this.snapshotTree?.nodes ?? []) {
      if (n.reactStepId) owners.add(n.reactStepId);
    }
    const stepMap = new Map(this.agentResponses.map(s => [s.id, s]));
    const associatedOwner = (stepId: string): string | undefined => {
      let current: string | undefined = stepId;
      while (current) {
        if (owners.has(current)) return current;
        current = stepMap.get(current)?.parentId;
      }
      return undefined;
    };
    const ownerStep = reactStepId ? stepMap.get(reactStepId) : undefined;
    return (
      this.agentResponses
        .filter(s => associatedOwner(s.id) === reactStepId)
        // A group must never cross a turn boundary. Only action-bearing steps own
        // snapshots, so the *next* turn's request — a user message — resolves to
        // this turn's snapshot; checking out the deepest member would then park
        // HEAD on a question this snapshot predates, showing it in the transcript
        // and branching the following turn off it. Every step of a turn carries
        // that turn's `messageId`, so the owner's id fences the group.
        .filter(s => !ownerStep || s.messageId === ownerStep.messageId)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    );
  }

  /** Whether the play button is enabled: snapshots exist and the agent is idle. */
  public canPlaySnapshots(): boolean {
    return this.snapshotNodes.length > 0 && !this.isGenerating();
  }

  /**
   * Play through the snapshots from the root down to the currently active
   * (HEAD) snapshot, checking each out in turn so the canvas animates the
   * dataflow building up, then stops at HEAD. Clicking again stops early.
   */
  public playSnapshots(): void {
    if (this.isPlayingSnapshots) {
      this.stopSnapshotPlayback();
      return;
    }
    const nodes = this.snapshotTree?.nodes ?? [];
    if (nodes.length === 0) {
      return;
    }
    // Build the root→active path of snapshots via parentId. The empty root is
    // already excluded from `nodes`, so the path starts at the first real
    // snapshot and ends at the active (HEAD) one.
    const byId = new Map(nodes.map(n => [n.id, n]));
    const path: SnapshotTreeResponse["nodes"] = [];
    let cursor: string | undefined = this.computeActiveSnapshotId(nodes);
    while (cursor) {
      const node = byId.get(cursor);
      if (!node) break;
      path.unshift(node);
      cursor = node.parentId;
    }
    if (path.length === 0) {
      return;
    }

    this.isPlayingSnapshots = true;
    // Start with nothing revealed; each step reveals the next snapshot so the
    // tree grows progressively rather than showing every node up front.
    this.playbackRevealedIds = new Set<string>();
    let i = 0;
    const advance = () => {
      if (!this.isPlayingSnapshots || i >= path.length) {
        this.stopSnapshotPlayback();
        return;
      }
      const node = path[i++];
      this.playbackRevealedIds!.add(node.id);
      this.buildSnapshotTree(); // reveal the newly-played snapshot in the tree
      this.checkoutSnapshot(node.reactStepId, node.id); // animate canvas + move HEAD
      this.cdr.detectChanges();
      this.snapshotPlaybackTimer = setTimeout(advance, this.snapshotPlaybackIntervalMs);
    };
    advance();
  }

  /**
   * Stop snapshot playback (also called on manual checkout, send, and
   * teardown). Restores the full snapshot tree if playback had been hiding
   * not-yet-revealed nodes.
   */
  public stopSnapshotPlayback(): void {
    this.isPlayingSnapshots = false;
    if (this.snapshotPlaybackTimer !== null) {
      clearTimeout(this.snapshotPlaybackTimer);
      this.snapshotPlaybackTimer = null;
    }
    if (this.playbackRevealedIds !== null) {
      this.playbackRevealedIds = null;
      this.buildSnapshotTree();
      this.cdr.detectChanges();
    }
  }

  /**
   * After a checkout-driven visibleSteps refresh, scroll the chat to (and
   * highlight) the pending step. Runs from the steps/HEAD subscriptions once
   * the new path is in place.
   */
  private flushPendingScroll(): void {
    if (!this.pendingScrollStepId) return;
    const stepId = this.pendingScrollStepId;
    const index = this.visibleSteps.findIndex(s => s.id === stepId);
    if (index < 0) return;
    this.pendingScrollStepId = null;
    this.setHoveredMessage(index);
    setTimeout(() => this.scrollToStepId(stepId), 0);
  }

  /** Scroll a rendered step (card row or message) into view by its step id. */
  private scrollToStepId(stepId: string): void {
    const container = this.messageContainer?.nativeElement;
    if (!container) return;
    const el = container.querySelector(`[data-step-id="${stepId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /** Drag the splitter between the timeline rail and the chat column. */
  public onResizeStart(event: MouseEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.treePanelWidth;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      this.treePanelWidth = Math.max(120, Math.min(500, startWidth + delta));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  /**
   * Save the max character limit.
   */
  public saveMaxCharLimit(): void {
    this.agentService
      .updateAgentSettings(this.agentInfo.id, {
        maxOperatorResultCharLimit: this.settingsMaxCharLimit,
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => this.notificationService.success("Max character limit saved"),
        error: () => {}, // Error already handled by service
      });
  }

  /**
   * Save the max cell character limit.
   */
  public saveMaxCellCharLimit(): void {
    this.agentService
      .updateAgentSettings(this.agentInfo.id, {
        maxOperatorResultCellCharLimit: this.settingsMaxCellCharLimit,
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => this.notificationService.success("Max cell character limit saved"),
        error: () => {}, // Error already handled by service
      });
  }

  /**
   * Save the tool execution timeout.
   */
  public saveToolTimeout(): void {
    this.agentService
      .updateAgentSettings(this.agentInfo.id, {
        toolTimeoutSeconds: this.settingsToolTimeoutSeconds,
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => this.notificationService.success("Tool timeout saved"),
        error: () => {}, // Error already handled by service
      });
  }

  /**
   * Save the workflow execution timeout.
   */
  public saveExecutionTimeout(): void {
    this.agentService
      .updateAgentSettings(this.agentInfo.id, {
        executionTimeoutMinutes: this.settingsExecutionTimeoutMinutes,
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => this.notificationService.success("Execution timeout saved"),
        error: () => {}, // Error already handled by service
      });
  }

  /**
   * Save the max steps per message setting.
   */
  public saveMaxSteps(): void {
    this.agentService
      .updateAgentSettings(this.agentInfo.id, {
        maxSteps: this.settingsMaxSteps,
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => this.notificationService.success("Max steps saved"),
        error: () => {}, // Error already handled by service
      });
  }

  /**
   * Save the agent mode (code | general). Triggers a system-info refresh so
   * the System Prompt and Tools tabs reflect the new tool surface.
   */
  public saveAgentMode(): void {
    this.agentService
      .updateAgentSettings(this.agentInfo.id, {
        agentMode: this.settingsAgentMode,
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => {
          this.notificationService.success(`Agent mode set to ${this.settingsAgentMode}`);
          this.refreshSystemInfo();
        },
        error: () => {}, // Error already handled by service
      });
  }

  /**
   * Save the ReAct context-selection policy (Latest / Full / Delta).
   *
   * Affects the assembled context the LLM sees on the next prepareStep, but
   * does not rebuild the system prompt (the prompt is mode-agnostic), so
   * no need to call refreshSystemInfo() for prompt content. We still call
   * it to keep the Parameters tab values in sync after a round-trip.
   */
  public saveContextMode(): void {
    this.agentService
      .updateAgentSettings(this.agentInfo.id, {
        contextMode: this.settingsContextMode,
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => {
          this.notificationService.success(`Context mode set to ${this.settingsContextMode}`);
          this.refreshSystemInfo();
        },
        error: () => {}, // Error already handled by service
      });
  }

  /**
   * Save the parallel-tool-calls setting. When enabled, the model may emit
   * multiple tool calls in one assistant turn; the agent serializes them
   * topologically via `ToolCallScheduler`. The choice does not change the
   * system prompt — `refreshSystemInfo()` is still called to keep the
   * Parameters tab values in sync after the round-trip.
   */
  public saveParallelToolCalls(): void {
    const enabled = this.settingsParallelToolCalls === "enabled";
    this.agentService
      .updateAgentSettings(this.agentInfo.id, {
        parallelToolCalls: enabled,
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => {
          this.notificationService.success(`Parallel tool calls ${enabled ? "enabled" : "disabled"}`);
          this.refreshSystemInfo();
        },
        error: () => {}, // Error already handled by service
      });
  }

  /**
   * Save the data-evidence setting. When enabled, results the agent observes
   * carry bounded column/table facts — null and distinct counts, ranges, top
   * values. The native prompt documents the evidence kinds that are on, so the
   * system info is refreshed.
   */
  public saveDataEvidence(): void {
    const enabled = this.settingsDataEvidence === "enabled";
    this.agentService
      .updateAgentSettings(this.agentInfo.id, {
        dataEvidence: enabled,
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => {
          this.notificationService.success(`Data evidence ${enabled ? "enabled" : "disabled"}`);
          this.refreshSystemInfo();
        },
        error: () => {}, // Error already handled by service
      });
  }

  /**
   * Save the flow-evidence setting. When enabled, results the agent observes
   * carry version-matched input/output facts — rows kept, keys matched — tying
   * each output to its inputs.
   */
  public saveFlowEvidence(): void {
    const enabled = this.settingsFlowEvidence === "enabled";
    this.agentService
      .updateAgentSettings(this.agentInfo.id, {
        flowEvidence: enabled,
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: () => {
          this.notificationService.success(`Flow evidence ${enabled ? "enabled" : "disabled"}`);
          this.refreshSystemInfo();
        },
        error: () => {}, // Error already handled by service
      });
  }

  /**
   * Scroll to a specific step in the chat by messageId and stepId.
   */
  private scrollToStep(messageId: string, stepId: number): void {
    // Find the step in visibleSteps
    const stepIndex = this.visibleSteps.findIndex(step => step.messageId === messageId && step.stepId === stepId);

    if (stepIndex >= 0) {
      // Highlight the message briefly, then scroll its rendered row into view.
      this.setHoveredMessage(stepIndex);
      this.scrollToStepId(this.visibleSteps[stepIndex].id);
    }
  }
}
