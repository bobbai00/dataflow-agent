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

import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit } from "@angular/core";
import { combineLatest, fromEvent, merge, Subject } from "rxjs";
import { NzModalCommentBoxComponent } from "./comment-box-modal/nz-modal-comment-box.component";
import { NzModalRef, NzModalService } from "ng-zorro-antd/modal";
import { DragDropService } from "../../service/drag-drop/drag-drop.service";
import { DynamicSchemaService } from "../../service/dynamic-schema/dynamic-schema.service";
import { ExecuteWorkflowService } from "../../service/execute-workflow/execute-workflow.service";
import { fromJointPaperEvent, JointUIService, linkPathStrokeColor } from "../../service/joint-ui/joint-ui.service";
import { Validation, ValidationWorkflowService } from "../../service/validation/validation-workflow.service";
import { WorkflowActionService } from "../../service/workflow-graph/model/workflow-action.service";
import { WorkflowStatusService } from "../../service/workflow-status/workflow-status.service";
import { ExecutionState, OperatorState } from "../../types/execute-workflow.interface";
import { LogicalPort, OperatorLink, OperatorPredicate } from "../../types/workflow-common.interface";
import { auditTime, filter, map, takeUntil, withLatestFrom } from "rxjs/operators";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { UndoRedoService } from "../../service/undo-redo/undo-redo.service";
import { WorkflowVersionService } from "../../../dashboard/service/user/workflow-version/workflow-version.service";
import { OperatorMenuService } from "../../service/operator-menu/operator-menu.service";
import { NzContextMenuService, NzDropdownMenuComponent } from "ng-zorro-antd/dropdown";
import { ActivatedRoute, Router } from "@angular/router";
import * as _ from "lodash";
import * as joint from "jointjs";
import { isDefined } from "../../../common/util/predicate";
import { GuiConfigService } from "../../../common/service/gui-config.service";
import { line, curveCatmullRomClosed } from "d3-shape";
import concaveman from "concaveman";
import { OperatorResultSummary, AgentService } from "../../service/agent/agent.service";
import { isNativeOperator } from "../../service/agent/native-operator";
import { NzNoAnimationDirective } from "ng-zorro-antd/core/animation";
import { ContextMenuComponent } from "./context-menu/context-menu/context-menu.component";
import { NgIf } from "@angular/common";
import { AgentInteractionComponent } from "../agent/agent-interaction/agent-interaction.component";
import { JupyterPanelService } from "../../service/jupyter-panel/jupyter-panel.service";

// jointjs interactive options for enabling and disabling interactivity
// https://resources.jointjs.com/docs/jointjs/v3.2/joint.html#dia.Paper.prototype.options.interactive
const defaultInteractiveOption = { vertexAdd: false, labelMove: false };
const disableInteractiveOption = {
  linkMove: false,
  labelMove: false,
  arrowheadMove: false,
  vertexMove: false,
  vertexAdd: false,
  vertexRemove: false,
  elementMove: false, // TODO: This is only a temporary change, will introduce another level of disable option.
  addLinkFromMagnet: false,
};

export const MAIN_CANVAS = {
  xMin: -960,
  xMax: 2688, // xMin * 2.8
  yMin: -540,
  yMax: 1512, // yMin * 2.8
};

/**
 * WorkflowEditorComponent is the component for the main workflow editor part of the UI.
 *
 * This component is bound with the JointJS paper. JointJS handles the operations of the main workflow.
 * The JointJS UI events are wrapped into observables and exposed to other components / services.
 *
 * See JointJS documentation for the list of events that can be captured on the JointJS paper view.
 * https://resources.jointjs.com/docs/jointjs/v2.0/joint.html#dia.Paper.events
 *
 * @author Zuozhi Wang
 * @author Henry Chen
 *
 */
@UntilDestroy()
@Component({
  selector: "texera-workflow-editor",
  templateUrl: "workflow-editor.component.html",
  styleUrls: ["workflow-editor.component.scss"],
  imports: [NzDropdownMenuComponent, NzNoAnimationDirective, ContextMenuComponent, NgIf, AgentInteractionComponent],
})
export class WorkflowEditorComponent implements OnInit, AfterViewInit, OnDestroy {
  editor!: HTMLElement;
  editorWrapper!: HTMLElement;
  paper!: joint.dia.Paper;
  private interactive: boolean = true;
  private _onProcessKeyboardActionObservable: Subject<void> = new Subject();
  private wrapper;
  private currentOpenedOperatorID: string | null = null;
  private removeButton!: new () => joint.linkTools.Button;
  private breakpointButton!: new () => joint.linkTools.Button;

  /** Screen-space gap between an operator's bottom edge and its panel: room for the caret, and for the
   *  status pill below the operator. */
  private static readonly CHAT_POPOVER_GAP_PX = 32;

  /** Agent action labels currently drawn on the canvas (see
   *  `applyAgentActionHighlight`); kept so the paint can be redone when the
   *  canvas catches up with the agent's steps. */
  private agentActionHighlight: {
    agentName: string;
    operatorIds: { viewedOperatorIds: string[]; addedOperatorIds: string[]; modifiedOperatorIds: string[] };
  } | null = null;

  // Chat popover state (operator chat button). For a native operator it is the
  // operator's panel (Run / Edit / Feedback), opened by selecting the operator.
  public chatPopoverOperator: {
    operatorId: string;
    displayName: string;
    position: { x: number; y: number };
    native?: boolean;
    /** "feedback": opened from the operator's chat button. */
    mode?: "actions" | "feedback";
  } | null = null;

  // Cached agent result summaries for port label display

  constructor(
    private workflowActionService: WorkflowActionService,
    private dynamicSchemaService: DynamicSchemaService,
    private dragDropService: DragDropService,
    private validationWorkflowService: ValidationWorkflowService,
    private jointUIService: JointUIService,
    private workflowStatusService: WorkflowStatusService,
    private executeWorkflowService: ExecuteWorkflowService,
    private nzModalService: NzModalService,
    private changeDetectorRef: ChangeDetectorRef,
    private undoRedoService: UndoRedoService,
    private workflowVersionService: WorkflowVersionService,
    private operatorMenu: OperatorMenuService,
    private route: ActivatedRoute,
    private router: Router,
    public nzContextMenu: NzContextMenuService,
    private elementRef: ElementRef,
    private config: GuiConfigService,
    private agentService: AgentService,
    private jupyterPanelService: JupyterPanelService
  ) {
    this.wrapper = this.workflowActionService.getJointGraphWrapper();
  }

  private operatorSummaries: Map<string, OperatorResultSummary> = new Map();
  /** Operators an agent's run is computing right now. */
  private runningOperators: ReadonlySet<string> = new Set();

  ngOnInit(): void {
    // Cache the tool constructors
    this.removeButton = WorkflowEditorComponent.getRemoveButton();
    this.breakpointButton = WorkflowEditorComponent.getBreakpointButton();

    this.agentService.operatorResultSummaries$.pipe(untilDestroyed(this)).subscribe(summaries => {
      this.operatorSummaries = summaries;
      // Render the snapshot's per-operator state + port tuple counts on the
      // canvas (the agent panel has no live execution stream to drive these).
      this.applyAgentOperatorSummaries();
      if (this.chatPopoverOperator) {
        this.changeDetectorRef.detectChanges();
      }
    });
    // An agent's run: its operators show they are computing until their results arrive.
    this.agentService.runningOperators$.pipe(untilDestroyed(this)).subscribe(running => {
      this.runningOperators = running;
      this.applyAgentOperatorSummaries();
    });
  }

  /** Operators currently showing an agent snapshot result (state + port counts). */
  private appliedSnapshotOps = new Set<string>();

  /**
   * Paint every operator with the result recorded in the current snapshot:
   * executed operators get their state colour and status pill (green "done",
   * blue "cached", red "failed") and input/output tuple counts on their ports;
   * operators an agent's run is computing show "Running"; operators that
   * previously showed a result but no longer have one are reset to the
   * uninitialized look.
   *
   * Driven by `operatorResultSummaries$` and `runningOperators$`, which the
   * agent service refreshes as the agent's progress plays, and on init /
   * checkout / completion.
   */
  private applyAgentOperatorSummaries(): void {
    if (!this.paper) {
      return;
    }
    // When the snapshot carries any operator results we're in agent-snapshot
    // mode: executed operators get their state + counts, and every other
    // operator is reset to the uninitialized look. The reset clears any stale
    // state a prior live run may have left (e.g. an operator stuck "Running")
    // so nothing lingers yellow on a snapshot where it wasn't executed.
    const resetOthers = this.operatorSummaries.size > 0 || this.runningOperators.size > 0;
    const applied = new Set<string>();
    this.workflowActionService
      .getTexeraGraph()
      .getAllOperators()
      .forEach(op => {
        if (this.paintAgentResult(op.operatorID)) applied.add(op.operatorID);
        else if (resetOthers || this.appliedSnapshotOps.has(op.operatorID))
          this.jointUIService.clearOperatorSnapshotResult(this.paper, op.operatorID);
      });

    // Operators removed from the graph since the last apply need no reset (they
    // are gone); current operators were handled in the loop above.
    this.appliedSnapshotOps = applied;
  }

  /** Paint one operator as the agent's run shows it: computing, or its
   * recorded result. False when the agent has neither for it. */
  private paintAgentResult(operatorId: string): boolean {
    if (this.runningOperators.has(operatorId)) {
      this.jointUIService.changeOperatorState(this.paper, operatorId, OperatorState.Running);
      return true;
    }
    const summary = this.operatorSummaries.get(operatorId);
    if (!summary) return false;
    const inputPortCounts: Record<string, number> = {};
    if (summary.inputPortShapes && summary.inputPortShapes.length > 0) {
      for (const shape of summary.inputPortShapes) {
        inputPortCounts[String(shape.portIndex)] = shape.rows;
      }
    } else if (summary.inputTuples) {
      inputPortCounts["0"] = summary.inputTuples;
    }
    // Most operators have a single output port; the summary carries the
    // total output tuple count rather than a per-port breakdown.
    const outputPortCounts: Record<string, number> = { "0": summary.outputTuples ?? summary.totalRowCount ?? 0 };
    this.jointUIService.setOperatorSnapshotResult(
      this.paper,
      operatorId,
      WorkflowEditorComponent.mapSummaryStateToOperatorState(summary.state, summary.error),
      inputPortCounts,
      outputPortCounts,
      summary.error ? "failed" : summary.cached ? "cached" : undefined
    );
    return true;
  }

  /**
   * Map an agent snapshot's operator-result state string (mixed case across
   * sources: "Completed"/"completed", "Failed"/"Error", …) onto an
   * `OperatorState`. An operator that carries an error is never shown as
   * Completed, so only genuinely successful operators get the green border.
   */
  private static mapSummaryStateToOperatorState(state: string, error?: string): OperatorState {
    if (error) {
      return OperatorState.Uninitialized;
    }
    const s = (state || "").toLowerCase();
    if (s.includes("complet")) return OperatorState.Completed;
    if (s.includes("run")) return OperatorState.Running;
    if (s.includes("paus")) return OperatorState.Paused;
    if (s.includes("ready")) return OperatorState.Ready;
    return OperatorState.Uninitialized;
  }

  /**
   * This function is provided to JointJS to disallow links starting from an in port.
   *
   * https://resources.jointjs.com/docs/jointjs/v2.0/joint.html#dia.Paper.prototype.options.validateMagnet
   */
  private static validateOperatorMagnet(
    cellView: joint.dia.CellView,
    magnet: SVGElement,
    event: joint.dia.Event
  ): boolean {
    return magnet && magnet.getAttribute("port-group") === "out";
  }

  ngAfterViewInit() {
    this.editor = document.getElementById("workflow-editor")!;
    this.editorWrapper = document.getElementById("workflow-editor-wrapper")!;
    document.addEventListener("keydown", this._handleKeyboardAction.bind(this));
    this.initializeJointPaper();
    this.handleDisableJointPaperInteractiveness();
    this.handleOperatorValidation();
    this.handlePaperRestoreDefaultOffset();
    this.handlePaperZoom();
    this.handleWindowResize();
    this.handleViewDeleteOperator();
    if (this.workflowActionService.getHighlightingEnabled()) {
      this.handleCellHighlight();
    }
    this.handleDisableOperator();
    this.handleViewOperatorResult();
    this.handleReuseCacheOperator();
    this.registerOperatorDisplayNameChangeHandler();
    this.handleViewDeleteLink();
    this.handleViewAddPort();
    this.handleViewRemovePort();
    this.handlePortClick();
    this.handlePaperPan();
    this.handleOperatorSelectionEvents();
    this.handlePortHighlightEvent();
    this.registerPortDisplayNameChangeHandler();
    this.handleOperatorStatisticsUpdate();
    this.handleRegionEvents();
    this.handleOperatorSuggestionHighlightEvent();
    this.handleAgentHoverHighlight();
    this.handleElementDelete();
    this.handleElementSelectAll();
    this.handleElementCopy();
    this.handleElementCut();
    this.handleElementPaste();
    this.handleLinkCursorHover();
    if (this.config.env.linkBreakpointEnabled && this.workflowActionService.getHighlightingEnabled()) {
      this.handleLinkBreakpoint();
    }
    this.handlePointerEvents();
    this.handleURLFragment();
    this.invokeResize();
    this.handleCenterEvent();
    this.handleOperatorChatButton();
    this.handleNativeOperatorPanel();
  }

  ngOnDestroy(): void {
    document.removeEventListener("keydown", this._handleKeyboardAction.bind(this));
  }

  private _handleKeyboardAction(event: any) {
    this._onProcessKeyboardActionObservable = new Subject();
    this.workflowVersionService
      .getDisplayParticularVersionStream()
      .pipe(takeUntil(this._onProcessKeyboardActionObservable))
      .subscribe(displayParticularWorkflowVersion => {
        if (!displayParticularWorkflowVersion) {
          // cmd/ctrl+z undo ; ctrl+y or cmd/ctrl + shift+z for redo
          if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
            // UNDO
            if (this.undoRedoService.canUndo()) {
              this.undoRedoService.undoAction();
            }
          } else if (
            ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "y") ||
            ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "z")
          ) {
            // redo
            if (this.undoRedoService.canRedo()) {
              this.undoRedoService.redoAction();
            }
          }
          // below for future hotkeys
        }
        this._onProcessKeyboardActionObservable.complete();
      });
  }

  private initializeJointPaper(): void {
    // attach the JointJS graph (model) to the paper (view)
    this.paper = this.wrapper.attachMainJointPaper({
      el: this.editor,
      background: { color: "#F6F6F6" },
      // enable jointjs feature that automatically snaps a link to the closest port with a radius of 30px
      snapLinks: { radius: 40 },
      // disable jointjs default action that can make a link not connect to an operator
      linkPinning: false,
      // provide a validation to determine if two ports could be connected (only output connect to input is allowed)
      validateConnection: (...args) => this.validateJointOperatorConnection(...args),
      // provide a validation to determine if the port where link starts from is an out port
      validateMagnet: (...args) => WorkflowEditorComponent.validateOperatorMagnet(...args),
      // marks all the available magnets or elements when a link is dragged
      markAvailable: true,
      // disable jointjs default action of adding vertexes to the link
      interactive: defaultInteractiveOption,
      // set a default link element used by jointjs when user creates a link on UI
      defaultLink: JointUIService.getDefaultLinkCell(),
      // disable jointjs default action that stops propagate click events on jointjs paper
      preventDefaultBlankAction: false,
      // prevents normal right click menu showing up on jointjs paper
      preventContextMenu: true,
      // draw dots in the background of the paper
      drawGrid: {
        name: "fixedDot",
        args: { color: "black", scaleFactor: 8, thickness: 1.2 },
      },
      gridSize: 1,
      // use approximate z-index sorting, this is a workaround of a bug in async rendering mode
      // see https://github.com/clientIO/joint/issues/1320
      sorting: joint.dia.Paper.sorting.APPROX,
      width: this.editor.offsetWidth,
      height: this.editor.offsetHeight,
    });
    this.editor.classList.add("hide-worker-count");
    this.editor.classList.add("hide-operator-status");
  }

  private handleDisableJointPaperInteractiveness(): void {
    this.workflowActionService
      .getWorkflowModificationEnabledStream()
      .pipe(untilDestroyed(this))
      .subscribe(enabled => {
        if (enabled) {
          this.interactive = true;
          this.paper.setInteractivity(defaultInteractiveOption);
        } else {
          this.interactive = false;
          this.paper.setInteractivity(disableInteractiveOption);
        }
        this.changeDetectorRef.detectChanges();
      });
  }

  /**
   * This method subscribe to workflowStatusService's status stream
   * for Each processStatus that has been emitted
   *    1. enable operatorStatusTooltipDisplay because tooltip will not be empty
   *    2. for each operator in current texeraGraph:
   *        - find its Statistics in processStatus, thrown an error if not found
   *        - generate its corresponding tooltip's id
   *        - pass the tooltip id and Statistics to jointUIService
   *          the specific tooltip content will be updated
   *          - if operator is in a group, save statistics in group's operatorInfo
   *    3. Whenever a group is expanded
   *        - for each operatorInfo, display statistics if there are some saved.
   */
  private handleOperatorStatisticsUpdate(): void {
    this.workflowStatusService
      .getStatusUpdateStream()
      .pipe(untilDestroyed(this))
      .subscribe(status => {
        this.workflowActionService
          .getTexeraGraph()
          .getAllOperators()
          // An agent's native operators show the agent's runs, as its progress plays.
          .filter(op => !isNativeOperator(op))
          .forEach(op => {
            if (
              isDefined(status[op.operatorID]) &&
              this.executeWorkflowService.getExecutionState().state === ExecutionState.Recovering
            ) {
              status[op.operatorID] = {
                ...status[op.operatorID],
                operatorState: OperatorState.Recovering,
              };
            }

            this.jointUIService.changeOperatorStatistics(
              this.paper,
              op.operatorID,
              status[op.operatorID],
              this.isSource(op.operatorID),
              this.isSink(op.operatorID)
            );
          });
      });

    this.executeWorkflowService
      .getExecutionStateStream()
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        if (event.previous.state === ExecutionState.Recovering) {
          let operatorState: OperatorState;
          if (event.current.state === ExecutionState.Paused) {
            operatorState = OperatorState.Paused;
          } else if (event.current.state === ExecutionState.Completed) {
            operatorState = OperatorState.Completed;
          } else if (event.current.state === ExecutionState.Running) {
            operatorState = OperatorState.Running;
          } else {
            throw new Error("unknown state transition from recovering state: " + event.current.state);
          }
          this.workflowActionService
            .getTexeraGraph()
            .getAllOperators()
            .forEach(op => {
              this.jointUIService.changeOperatorState(this.paper, op.operatorID, operatorState);
            });
        }
      });

    // When operators are (re)added to the graph — e.g. after navigating back to
    // the workflow page, where WorkspaceComponent calls reloadWorkflow and
    // operators are recreated from the workflow JSON — restore their visual
    // state from the cached status so completed runs don't appear to reset.
    // Restores port labels / worker count via changeOperatorStatistics, then
    // delegates the final border color to applyOperatorBorder so the same
    // priority rules apply as for the validation pass.
    this.workflowActionService
      .getTexeraGraph()
      .getOperatorAddStream()
      .pipe(untilDestroyed(this))
      .subscribe(operator => {
        const statistics = isNativeOperator(operator)
          ? undefined
          : this.workflowStatusService.getCurrentStatus()[operator.operatorID];
        if (statistics) {
          this.jointUIService.changeOperatorStatistics(
            this.paper,
            operator.operatorID,
            statistics,
            this.isSource(operator.operatorID),
            this.isSink(operator.operatorID)
          );
        }
        this.applyOperatorBorder(
          operator.operatorID,
          this.validationWorkflowService.validateOperator(operator.operatorID)
        );
      });
  }

  /**
   * Single source of truth for the operator's border color. Both the
   * validation stream and the operator-add stream route through here so
   * the priority order is consistent regardless of which event fires last:
   *   1. Invalid operator → red (validation takes priority).
   *   2. Valid operator an agent computed or is computing → the agent's
   *      outcome (paintAgentResult). An agent's native operator never takes
   *      the engine's live status: the agent's progress plays behind it.
   *   3. Valid operator with a cached execution status → execution-state color.
   *   4. Valid operator with no cached status → default valid (gray).
   *
   * Centralizing this here avoids the race where the validation pass
   * overwrites a state-derived stroke (or vice versa) for an operator that
   * is both invalid and has a cached execution status.
   *
   * Both callers obtain the Validation themselves and pass it in: the
   * validation-stream subscriber forwards the result the stream just emitted,
   * and the operator-add subscriber computes it via validateOperator. Keeping
   * the parameter required means the color decision never silently depends on
   * a recompute hidden inside this helper.
   */
  private applyOperatorBorder(operatorID: string, validation: Validation): void {
    if (!validation.isValid) {
      this.jointUIService.changeOperatorColor(this.paper, operatorID, false);
      return;
    }
    // An operator the agent computed, or is computing, shows that.
    if (this.paintAgentResult(operatorID)) return;
    const operator = this.workflowActionService.getTexeraGraph().getOperator(operatorID);
    const statistics = isNativeOperator(operator)
      ? undefined
      : this.workflowStatusService.getCurrentStatus()[operatorID];
    if (statistics) {
      this.jointUIService.changeOperatorState(this.paper, operatorID, statistics.operatorState);
    } else {
      this.jointUIService.changeOperatorColor(this.paper, operatorID, true);
    }
  }

  private handleRegionEvents(): void {
    const Region = joint.dia.Element.define(
      "region",
      {
        attrs: {
          body: {
            fill: "rgba(158,158,158,0.2)",
            pointerEvents: "none",
            // Regions start hidden and are revealed via the View > Regions toggle. Driving visibility
            // through this model attribute keeps the main canvas and the mini-map in sync (see #4027).
            visibility: "hidden",
          },
        },
      },
      {
        markup: [{ tagName: "path", selector: "body" }],
      }
    );

    // A region plan names operators by id, and they need not be on the canvas when it arrives:
    // an agent's run reports its plan before the agent's new operators are synced to the canvas,
    // and an agent checkout can replace the DAG. Each region keeps its ids and is redrawn from
    // whichever of them are on the canvas, as operators come and go.
    let regionMap: { regionElement: joint.dia.Element; operatorIds: string[]; operators: joint.dia.Cell[] }[] = [];
    const drawRegion = (region: (typeof regionMap)[number]) => {
      region.operators = region.operatorIds
        .map(id => this.paper.getModelById(id))
        .filter((cell): cell is joint.dia.Cell => !!cell);
      this.updateRegionElement(region.regionElement, region.operators);
    };
    // update region elements on execution
    this.executeWorkflowService
      .getRegionUpdateStream()
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        this.paper.model
          .getCells()
          .filter(element => element instanceof Region)
          .forEach(element => element.remove());

        regionMap = event.regions.map(([id, operatorIds]) => {
          const region = { regionElement: new Region({ id: "region-" + id }), operatorIds, operators: [] };
          this.paper.model.addCell(region.regionElement);
          drawRegion(region);
          return region;
        });
        // regions are recreated on every update, so reapply the current toggle state to the new elements
        this.setRegionsVisibility(this.wrapper.getRegionsDisplayed());
      });

    // apply the View > Regions toggle to all existing region elements (canvas and mini-map share the model)
    this.wrapper
      .getRegionsDisplayedStream()
      .pipe(untilDestroyed(this))
      .subscribe(displayed => this.setRegionsVisibility(displayed));

    this.paper.model.on("add remove", (cell: joint.dia.Cell) => {
      if (cell instanceof Region) return;
      regionMap.filter(region => region.operatorIds.includes(String(cell.id))).forEach(drawRegion);
    });

    this.paper.model.on("change:position", operator => {
      regionMap
        .filter(region => region.operators.includes(operator))
        .forEach(region => this.updateRegionElement(region.regionElement, region.operators));
    });

    // update region element colors on execution
    this.executeWorkflowService
      .getRegionStateStream()
      .pipe(untilDestroyed(this))
      .subscribe(region => {
        const colorMap: Record<string, string> = {
          ExecutingDependeePortsPhase: "rgba(33,150,243,0.2)",
          ExecutingNonDependeePortsPhase: "rgba(255,213,79,0.2)",
          Completed: "rgba(76,175,80,0.2)",
        };
        // a state can trail its region, which a newer plan may already have replaced
        this.paper.getModelById("region-" + region.id)?.attr("body/fill", colorMap[region.state]);
      });
  }

  private setRegionsVisibility(displayed: boolean): void {
    this.paper.model
      .getElements()
      .filter(element => element.get("type") === "region")
      .forEach(element => element.attr("body/visibility", displayed ? "visible" : "hidden"));
  }

  private updateRegionElement(regionElement: joint.dia.Element, operators: joint.dia.Cell[]) {
    // None of the region's operators is on the canvas (yet): draw nothing. concaveman throws
    // on an empty point set.
    if (operators.length === 0) {
      regionElement.attr("body/d", "");
      return;
    }
    const points = operators.flatMap(op => {
      const { x, y, width, height } = op.getBBox(),
        padding = 15;
      return [
        [x - padding, y - padding],
        [x + width + padding, y - padding],
        [x - padding, y + height + padding + 10],
        [x + width + padding, y + height + padding + 10],
      ];
    });
    regionElement.attr("body/d", line().curve(curveCatmullRomClosed)(concaveman(points, 2, 0) as [number, number][]));
  }

  /**
   * Handles restore offset default event by translating jointJS paper
   *  back to original position
   */
  private handlePaperRestoreDefaultOffset(): void {
    this.wrapper
      .getRestorePaperOffsetStream()
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        this.wrapper.setZoomProperty(1);
        this.paper.translate(0, 0);
      });
  }

  /**
   * Handles zoom events to make the jointJS paper larger or smaller.
   */
  private handlePaperZoom(): void {
    this.wrapper
      .getWorkflowEditorZoomStream()
      .pipe(untilDestroyed(this))
      .subscribe(newRatio => this.paper.scale(newRatio, newRatio));
  }

  private handlePaperPan(): void {
    fromJointPaperEvent(this.paper, "blank:pointerdown")
      .pipe(untilDestroyed(this))
      .subscribe(() =>
        fromEvent<MouseEvent>(document, "mousemove")
          .pipe(takeUntil(fromEvent(document, "mouseup")))
          .subscribe(event =>
            this.paper.translate(
              this.paper.translate().tx + event.movementX / this.paper.scale().sx,
              this.paper.translate().ty + event.movementY / this.paper.scale().sy
            )
          )
      );
  }

  /**
   * This is the handler for window resize event
   * When the window is resized, trigger an event to set papaer offset and dimension
   *  and limit the event to at most one every 30ms.
   *
   * When user open the result panel and resize, the paper will resize to the size relative
   *  to the result panel, therefore we also need to listen to the event from opening
   *  and closing of the result panel.
   */
  private handleWindowResize(): void {
    // when the window is resized (limit to at most one event every 30ms).
    merge(fromEvent(window, "resize").pipe(auditTime(30)))
      .pipe(untilDestroyed(this))
      .subscribe(() => this.paper.setDimensions(this.editorWrapper.offsetWidth, this.editorWrapper.offsetHeight));
  }

  private handleCellHighlight(): void {
    this.handleHighlightMouseDBClickInput();
    this.handleHighlightMouseInput();
    this.handleElementHightlightEvent();
  }

  private handleDisableOperator(): void {
    this.workflowActionService
      .getTexeraGraph()
      .getDisabledOperatorsChangedStream()
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        event.newDisabled.concat(event.newEnabled).forEach(opID => {
          const op = this.workflowActionService.getTexeraGraph().getOperator(opID);
          this.jointUIService.changeOperatorDisableStatus(this.paper, op);
        });
      });
  }

  private handleViewOperatorResult(): void {
    this.workflowActionService
      .getTexeraGraph()
      .getViewResultOperatorsChangedStream()
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        event.newViewResultOps.concat(event.newUnviewResultOps).forEach(opID => {
          const op = this.workflowActionService.getTexeraGraph().getOperator(opID);
          this.jointUIService.changeOperatorViewResultStatus(this.paper, op, op.viewResult);
        });
      });
  }

  private handleReuseCacheOperator(): void {
    this.workflowActionService
      .getTexeraGraph()
      .getReuseCacheOperatorsChangedStream()
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        event.newReuseCacheOps.concat(event.newUnreuseCacheOps).forEach(opID => {
          const op = this.workflowActionService.getTexeraGraph().getOperator(opID);
          this.jointUIService.changeOperatorReuseCacheStatus(this.paper, op);
        });
      });
  }

  private registerOperatorDisplayNameChangeHandler(): void {
    this.workflowActionService
      .getTexeraGraph()
      .getOperatorDisplayNameChangedStream()
      .pipe(untilDestroyed(this))
      .subscribe(({ operatorID, newDisplayName }) => {
        const op = this.workflowActionService.getTexeraGraph().getOperator(operatorID);
        this.jointUIService.changeOperatorJointDisplayName(op, this.paper, newDisplayName);
      });
  }

  private registerPortDisplayNameChangeHandler(): void {
    this.workflowActionService
      .getTexeraGraph()
      .getPortDisplayNameChangedSubject()
      .pipe(untilDestroyed(this))
      .subscribe(({ operatorID, portID, newDisplayName }) => {
        const operatorJointElement = <joint.dia.Element>this.workflowActionService.getJointGraph().getCell(operatorID);
        operatorJointElement.portProp(portID, "attrs/.port-label", {
          text: newDisplayName,
        });
      });
  }

  private handleHighlightMouseDBClickInput(): void {
    // on user mouse double-clicks a comment box, open that comment box
    // on user mouse double-clicks an operator, highlight it and open its panel
    fromJointPaperEvent(this.paper, "cell:pointerdblclick")
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        const clickedElement = event[0].model;
        if (clickedElement.isElement()) {
          const elementID = clickedElement.id.toString();
          this.wrapper.setMultiSelectMode(<boolean>event[1].shiftKey);

          if (this.workflowActionService.getTexeraGraph().hasCommentBox(elementID)) {
            this.openCommentBox(elementID);
          } else if (this.workflowActionService.getTexeraGraph().hasOperator(elementID)) {
            this.openOperatorPanel(elementID, "actions");
          }
        }
      });
  }

  /**
   * Handles user mouse down events to trigger logically highlight and unhighlight an operator or group.
   * If user clicks the operator/group while pressing the shift key, multiselect mode is turned on.
   * When pressing the shift key, user can unhighlight a highlighted operator/group by clicking on it.
   * User can also unhighlight all operators and groups by clicking on the blank area of the graph.
   */
  private handleHighlightMouseInput(): void {
    // on user mouse clicks an operator/group cell, highlight that operator/group
    // operator status tooltips should never be highlighted
    merge(fromJointPaperEvent(this.paper, "cell:pointerdown"), fromJointPaperEvent(this.paper, "cell:contextmenu"))
      // event[0] is the JointJS CellView; event[1] is the original JQuery Event
      .pipe(
        filter(event => event[0].model.isElement()),
        filter(
          event =>
            this.workflowActionService.getTexeraGraph().hasOperator(event[0].model.id.toString()) ||
            this.workflowActionService.getTexeraGraph().hasCommentBox(event[0].model.id.toString())
        )
      )
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        // multiselect mode on if holding shift
        this.wrapper.setMultiSelectMode(<boolean>event[1].shiftKey);

        const elementID = event[0].model.id.toString();
        const highlightedOperatorIDs = this.wrapper.getCurrentHighlightedOperatorIDs();
        const highlightedCommentBoxIDs = this.wrapper.getCurrentHighlightedCommentBoxIDs();
        if (this.workflowActionService.getTexeraGraph().hasOperator(elementID)) {
          this.jupyterPanelService.onWorkflowComponentClick(elementID); // highlight corresponding Jupyter notebook cell
        }
        if (event[1].shiftKey) {
          // if in multiselect toggle highlights on click
          if (highlightedOperatorIDs.includes(elementID)) {
            this.workflowActionService.unhighlightOperators(elementID);
          } else if (this.workflowActionService.getTexeraGraph().hasOperator(elementID)) {
            this.workflowActionService.highlightOperators(<boolean>event[1].shiftKey, elementID);
          }
          if (highlightedCommentBoxIDs.includes(elementID)) {
            this.wrapper.unhighlightCommentBoxes(elementID);
          } else if (this.workflowActionService.getTexeraGraph().hasCommentBox(elementID)) {
            this.workflowActionService.highlightCommentBoxes(<boolean>event[1].shiftKey, elementID);
          }
          // if in the multiselect mode, also highlight the links in between two highlighted operators
          const allLinks: OperatorLink[] = this.workflowActionService.getTexeraGraph().getAllLinks();
          const linksToBeHighlighted: string[] = allLinks
            .filter(link => {
              const currentHighlightedOperatorIDs = this.wrapper.getCurrentHighlightedOperatorIDs();
              for (let sourceOperatorID of currentHighlightedOperatorIDs) {
                // first make sure the link is not already highlighted
                if (!(link.linkID in this.wrapper.getCurrentHighlightedLinkIDs)) {
                  if (sourceOperatorID === link.source.operatorID) {
                    // iterate through all the other highlighted operators
                    for (let targetOperatorID of currentHighlightedOperatorIDs.filter(
                      each => each != sourceOperatorID
                    )) {
                      if (targetOperatorID === link.target.operatorID) {
                        return true;
                      }
                    }
                  }
                }
              }
            })
            .map(link => link.linkID);
          this.workflowActionService.highlightLinks(<boolean>event[1].shiftKey, ...linksToBeHighlighted);
        } else {
          // else only highlight a single operator or group
          if (this.workflowActionService.getTexeraGraph().hasOperator(elementID)) {
            this.workflowActionService.highlightOperators(<boolean>event[1].shiftKey, elementID);
          } else if (this.workflowActionService.getTexeraGraph().hasCommentBox(elementID)) {
            this.wrapper.highlightCommentBoxes(elementID);
          }
        }
      });

    // on user mouse clicks on blank area, unhighlight all operators and groups
    merge(fromJointPaperEvent(this.paper, "blank:pointerdown"), fromJointPaperEvent(this.paper, "blank:contextmenu"))
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        this.wrapper.unhighlightElements(this.wrapper.getCurrentHighlights());
      });
  }

  private handleElementHightlightEvent(): void {
    // handle logical operator and group highlight / unhighlight events to let JointJS
    //  use our own custom highlighter
    const highlightOptions = {
      name: "stroke",
      options: {
        attrs: {
          "stroke-width": 2,
          stroke: "#4A95FF",
        },
      },
    };

    // highlight on OperatorHighlightStream or GroupHighlightStream or CommentBoxHighlightStream
    merge(
      this.wrapper.getJointOperatorHighlightStream(),
      this.wrapper.getJointGroupHighlightStream(),
      this.wrapper.getJointCommentBoxHighlightStream()
    )
      .pipe(untilDestroyed(this))
      .subscribe(elementIDs =>
        elementIDs.forEach(elementID => {
          this.paper.findViewByModel(elementID).highlight("rect.body", { highlighter: highlightOptions });
        })
      );

    // unhighlight on OperatorUnhighlightStream or GroupUnhighlightStream or CommentBoxUnhighlightStream
    merge(
      this.wrapper.getJointOperatorUnhighlightStream(),
      this.wrapper.getJointGroupUnhighlightStream(),
      this.wrapper.getJointCommentBoxUnhighlightStream()
    )
      .pipe(untilDestroyed(this))
      .subscribe(elementIDs =>
        elementIDs.forEach(elementID => {
          const elem = this.paper.findViewByModel(elementID);
          if (elem !== undefined) {
            elem.unhighlight("rect.body", { highlighter: highlightOptions });
          }
        })
      );
  }

  private handlePortHighlightEvent(): void {
    this.wrapper
      .getJointPortHighlightStream()
      .pipe(untilDestroyed(this))
      .subscribe(operatorPortIDs => {
        operatorPortIDs.forEach(operatorPortID => {
          const operatorJointElement = <joint.dia.Element>(
            this.workflowActionService.getJointGraph().getCell(operatorPortID.operatorID)
          );
          operatorJointElement.portProp(operatorPortID.portID, "attrs/.port-body", {
            r: 8,
            stroke: "#4A95FF",
            "stroke-width": 3,
          });
        });
      });

    this.wrapper
      .getJointPortUnhighlightStream()
      .pipe(untilDestroyed(this))
      .subscribe(operatorPortIDs => {
        operatorPortIDs.forEach(operatorPortID => {
          const operatorJointElement = <joint.dia.Element>(
            this.workflowActionService.getJointGraph().getCell(operatorPortID.operatorID)
          );
          operatorJointElement.portProp(operatorPortID.portID, "attrs/.port-body", {
            r: 5,
            stroke: "none",
          });
        });
      });
  }

  private openCommentBox(commentBoxID: string): void {
    const commentBox = this.workflowActionService.getTexeraGraph().getSharedCommentBoxType(commentBoxID);
    const modalRef: NzModalRef = this.nzModalService.create({
      // modal title
      nzTitle: "Comments",
      nzContent: NzModalCommentBoxComponent,
      // set component @Input attributes
      nzData: { commentBox: commentBox }, // set the index value and page size to the modal for navigation
      // prevent browser focusing close button (ugly square highlight)
      nzAutofocus: null,
      // modal footer buttons
      nzFooter: null,
    });
    modalRef.afterClose.pipe(untilDestroyed(this)).subscribe(() => {
      this.wrapper.unhighlightCommentBoxes(commentBoxID);
      this.setURLFragment(null);
    });
  }

  private handleOperatorSuggestionHighlightEvent(): void {
    const highlightOptions = {
      name: "stroke",
      options: {
        attrs: {
          "stroke-width": 5,
          stroke: "#551A8B70",
        },
      },
    };

    this.dragDropService
      .getOperatorSuggestionHighlightStream()
      .pipe(untilDestroyed(this))
      .subscribe(value => this.paper.findViewByModel(value).highlight("rect.body", { highlighter: highlightOptions }));

    this.dragDropService
      .getOperatorSuggestionUnhighlightStream()
      .pipe(untilDestroyed(this))
      .subscribe(value =>
        this.paper.findViewByModel(value).unhighlight("rect.body", { highlighter: highlightOptions })
      );
  }

  /**
   * Handles the event where the Delete button is clicked for an Operator,
   *  and call workflowAction to delete the corresponding operator.
   *
   * JointJS doesn't have delete button built-in with an operator element,
   *  the delete button is Texera's own customized element.
   * Therefore JointJS doesn't come with default handler for delete an operator,
   *  we need to handle the callback event `element:delete`.
   * The name of this callback event is registered in `JointUIService.getCustomOperatorStyleAttrs`
   */
  private handleViewDeleteOperator(): void {
    // bind the delete button event to call the delete operator function in joint model action
    fromJointPaperEvent(this.paper, "element:delete")
      .pipe(
        filter(() => this.interactive),
        map(value => value[0])
      )
      .pipe(untilDestroyed(this))
      .subscribe(elementView => {
        if (this.workflowActionService.getTexeraGraph().hasOperator(elementView.model.id.toString())) {
          this.workflowActionService.deleteOperator(elementView.model.id.toString());
        }
        if (this.workflowActionService.getTexeraGraph().hasCommentBox(elementView.model.id.toString())) {
          this.workflowActionService.deleteCommentBox(elementView.model.id.toString());
        }
      });
  }

  private handleViewAddPort(): void {
    fromJointPaperEvent(this.paper, "element:add-input-port")
      .pipe(
        filter(() => this.interactive),
        map(value => value[0])
      )
      .pipe(untilDestroyed(this))
      .subscribe(elementView => {
        if (this.workflowActionService.getTexeraGraph().hasOperator(elementView.model.id.toString())) {
          this.workflowActionService.addPort(elementView.model.id.toString(), true, false);
        }
      });
    fromJointPaperEvent(this.paper, "element:add-output-port")
      .pipe(
        filter(() => this.interactive),
        map(value => value[0])
      )
      .pipe(untilDestroyed(this))
      .subscribe(elementView => {
        if (this.workflowActionService.getTexeraGraph().hasOperator(elementView.model.id.toString())) {
          this.workflowActionService.addPort(elementView.model.id.toString(), false);
        }
      });
  }

  private handleViewRemovePort(): void {
    fromJointPaperEvent(this.paper, "element:remove-input-port")
      .pipe(
        filter(() => this.interactive),
        map(value => value[0])
      )
      .pipe(untilDestroyed(this))
      .subscribe(elementView => {
        if (this.workflowActionService.getTexeraGraph().hasOperator(elementView.model.id.toString())) {
          this.workflowActionService.removePort(elementView.model.id.toString(), true);
        }
      });
    fromJointPaperEvent(this.paper, "element:remove-output-port")
      .pipe(
        filter(() => this.interactive),
        map(value => value[0])
      )
      .pipe(untilDestroyed(this))
      .subscribe(elementView => {
        if (this.workflowActionService.getTexeraGraph().hasOperator(elementView.model.id.toString())) {
          this.workflowActionService.removePort(elementView.model.id.toString(), false);
        }
      });
  }

  private handlePortClick(): void {
    fromJointPaperEvent(this.paper, "element:magnet:pointerclick")
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        // set the multi-select mode
        this.wrapper.setMultiSelectMode(<boolean>event[1].shiftKey);

        const clickedPortID: LogicalPort = {
          operatorID: event[0].model.id as string,
          portID: event[2].getAttribute("port") as string,
        };

        if (event[1].shiftKey) {
          if (_.find(this.wrapper.getCurrentHighlightedPortIDs(), clickedPortID) !== undefined) {
            // if the link being clicked is already highlighted, unhighlight it
            this.workflowActionService.unhighlightPorts(clickedPortID);
          } else if (this.workflowActionService.getTexeraGraph().hasOperator(clickedPortID.operatorID)) {
            // highlight the link if the link has not already been highlighted
            this.workflowActionService.highlightPorts(<boolean>event[1].shiftKey, clickedPortID);
          }
        } else {
          // if user doesn't click on the shift key, highlight only a single port
          if (this.workflowActionService.getTexeraGraph().hasOperator(clickedPortID.operatorID)) {
            this.workflowActionService.highlightPorts(<boolean>event[1].shiftKey, clickedPortID);
          }
        }
      });
  }

  private handleOperatorSelectionEvents(): void {
    fromJointPaperEvent(this.paper, "element:pointerdown")
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        const operatorID = event[0].model.id.toString();

        if (this.currentOpenedOperatorID !== null && this.paper.getModelById(this.currentOpenedOperatorID)) {
          this.jointUIService.foldOperatorDetails(this.paper, this.currentOpenedOperatorID);
        }

        this.currentOpenedOperatorID = operatorID;
        this.jointUIService.unfoldOperatorDetails(this.paper, operatorID);
      });

    fromJointPaperEvent(this.paper, "element:contextmenu")
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        const operatorID = event[0].model.id.toString();

        if (this.currentOpenedOperatorID !== null && this.paper.getModelById(this.currentOpenedOperatorID)) {
          this.jointUIService.foldOperatorDetails(this.paper, this.currentOpenedOperatorID);
        }

        this.currentOpenedOperatorID = operatorID;
        this.jointUIService.unfoldOperatorDetails(this.paper, operatorID);
      });

    // Handle right-click on links
    fromJointPaperEvent(this.paper, "link:contextmenu")
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        const linkID = event[0].model.id.toString();
        // Highlight the link when right-clicked
        this.workflowActionService.highlightLinks(false, linkID);
      });

    fromJointPaperEvent(this.paper, "blank:pointerdown")
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        if (this.currentOpenedOperatorID !== null && this.paper.getModelById(this.currentOpenedOperatorID)) {
          this.jointUIService.foldOperatorDetails(this.paper, this.currentOpenedOperatorID);
          this.currentOpenedOperatorID = null;
        }
      });
  }

  /**
   * Handles the event where the Delete button is clicked for a Link,
   *  and call workflowAction to delete the corresponding link.
   *
   * We handle link deletion on our own by defining a custom markup.
   * Therefore JointJS doesn't come with default handler for delete an operator,
   *  we need to handle the callback event `tool:remove`.
   */
  private handleViewDeleteLink(): void {
    fromJointPaperEvent(this.paper, "tool:remove")
      .pipe(
        filter(() => this.interactive),
        map(value => value[0])
      )
      .pipe(untilDestroyed(this))
      .subscribe(elementView => {
        this.workflowActionService.deleteLinkWithID(elementView.model.id.toString());
      });
  }

  /**
   * Applies the validation result to the operator's border. Delegates to
   * applyOperatorBorder so validation, cached-execution-status, and the
   * default-valid case are decided in one place.
   */
  private handleOperatorValidation(): void {
    this.validationWorkflowService
      .getOperatorValidationStream()
      .pipe(untilDestroyed(this))
      .subscribe(value => this.applyOperatorBorder(value.operatorID, value.validation));
  }

  /**
   * This function is provided to JointJS to disable some invalid connections on the UI.
   * If the connection is invalid, users are not able to connect the links on the UI.
   *
   * https://resources.jointjs.com/docs/jointjs/v2.0/joint.html#dia.Paper.prototype.options.validateConnection
   */
  private validateJointOperatorConnection(
    sourceView: joint.dia.CellView,
    sourceMagnet: SVGElement | undefined,
    targetView: joint.dia.CellView,
    targetMagnet: SVGElement | undefined,
    end: joint.dia.LinkEnd,
    linkView: joint.dia.LinkView
  ): boolean {
    // user cannot draw connection starting from the input port (left side)
    if (sourceMagnet && sourceMagnet.getAttribute("port-group") === "in") {
      return false;
    }

    // user cannot connect to the output port (right side)
    if (targetMagnet && targetMagnet.getAttribute("port-group") === "out") {
      return false;
    }

    const sourceCellID = sourceView.model.id.toString();
    const sourcePortID = sourceMagnet?.getAttribute("port");
    const targetCellID = targetView.model.id.toString();
    const targetPortID = targetMagnet?.getAttribute("port");

    return this.validateOperatorConnection(sourceCellID, sourcePortID, targetCellID, targetPortID);
  }

  private validateOperatorConnection(
    sourceCellID: string,
    sourcePortID: string | null | undefined,
    targetCellID: string,
    targetPortID: string | null | undefined
  ): boolean {
    // cannot connect to itself
    if (sourceCellID === targetCellID) {
      return false;
    }

    // must connect to ports
    if (!sourcePortID || !targetPortID) {
      return false;
    }

    // must connect to operators
    if (
      !this.workflowActionService.getTexeraGraph().hasOperator(sourceCellID) ||
      !this.workflowActionService.getTexeraGraph().hasOperator(targetCellID)
    ) {
      return false;
    }

    // find all the links that are connected to the target operator and port
    const connectedLinksToTargetPort = this.workflowActionService
      .getTexeraGraph()
      .getAllLinks()
      .filter(link => link.target.operatorID === targetCellID && link.target.portID === targetPortID);

    // check if this link already exists, duplicate links are not allowed
    const isDuplicateLink =
      connectedLinksToTargetPort.filter(
        link => link.source.operatorID === sourceCellID && link.source.portID === sourcePortID
      ).length > 0;
    if (isDuplicateLink) {
      return false;
    }

    let disallowMultiInput = false;
    if (this.workflowActionService.getTexeraGraph().hasOperator(targetCellID)) {
      const portIndex = this.workflowActionService
        .getTexeraGraph()
        .getOperator(targetCellID)
        .inputPorts.findIndex(p => p.portID === targetPortID);
      if (portIndex >= 0) {
        const portInfo =
          this.dynamicSchemaService.getDynamicSchema(targetCellID).additionalMetadata.inputPorts[portIndex];
        disallowMultiInput = portInfo?.disallowMultiLinks ?? false;
      }
    }
    return !(connectedLinksToTargetPort.length > 0 && disallowMultiInput);
  }

  /**
   * Deletes currently highlighted operators and groups when user presses the delete key.
   * When the focus is not on root document body, operator should not be deleted
   */
  private handleElementDelete(): void {
    fromEvent<KeyboardEvent>(document, "keydown")
      .pipe(
        filter(() => document.activeElement === document.body),
        filter(() => this.interactive),
        filter(event => event.key === "Backspace" || event.key === "Delete")
      )
      .pipe(untilDestroyed(this))
      .subscribe(() => this.deleteElements());
  }

  private deleteElements(): void {
    // Capture all highlighted IDs before starting deletion to avoid modification during iteration
    const highlightedOperatorIDs = Array.from(this.wrapper.getCurrentHighlightedOperatorIDs());
    const highlightedCommentBoxIDs = Array.from(this.wrapper.getCurrentHighlightedCommentBoxIDs());
    const highlightedLinkIDs = Array.from(this.wrapper.getCurrentHighlightedLinkIDs());

    // Bundle all deletions together for proper undo/redo support
    this.workflowActionService.getTexeraGraph().bundleActions(() => {
      // Delete operators and their connected links
      this.workflowActionService.deleteOperatorsAndLinks(highlightedOperatorIDs);

      // Delete standalone selected links
      highlightedLinkIDs.forEach(highlightedLinkID => {
        // Only delete if the link still exists (might have been deleted with operators)
        if (this.workflowActionService.getTexeraGraph().hasLinkWithID(highlightedLinkID)) {
          this.workflowActionService.deleteLinkWithID(highlightedLinkID);
        }
      });

      // Delete comment boxes
      highlightedCommentBoxIDs.forEach(highlightedCommentBoxID =>
        this.workflowActionService.deleteCommentBox(highlightedCommentBoxID)
      );
    });
  }

  /**
   * Highlight all operators and groups on the graph when user presses command/ctrl + A.
   */
  private handleElementSelectAll(): void {
    fromEvent<KeyboardEvent>(document, "keydown")
      .pipe(
        filter(() => document.activeElement === document.body),
        filter(event => (event.metaKey || event.ctrlKey) && event.key === "a")
      )
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        event.preventDefault();
        const allOperators = this.workflowActionService
          .getTexeraGraph()
          .getAllOperators()
          .map(operator => operator.operatorID);
        const allLinks = this.workflowActionService
          .getTexeraGraph()
          .getAllLinks()
          .map(link => link.linkID);
        const allCommentBoxes = this.workflowActionService
          .getTexeraGraph()
          .getAllCommentBoxes()
          .map(CommentBox => CommentBox.commentBoxID);
        this.wrapper.setMultiSelectMode(allOperators.length + allCommentBoxes.length > 1);
        this.workflowActionService.highlightLinks(allLinks.length > 1, ...allLinks);
        this.workflowActionService.highlightOperators(allOperators.length > 1, ...allOperators);
        this.workflowActionService.highlightCommentBoxes(
          allOperators.length + allCommentBoxes.length > 1,
          ...allCommentBoxes
        );
      });
  }

  /**
   * Caches the currently highlighted operators' info when user
   * triggers the copy event (i.e. presses command/ctrl + c on
   * keyboard or selects copy option from the browser menu).
   */
  private handleElementCopy(): void {
    fromEvent<ClipboardEvent>(document, "copy")
      .pipe(
        filter(_ => document.activeElement === document.body),
        withLatestFrom(this.operatorMenu.highlightedOperators$, this.operatorMenu.highlightedCommentBoxes$),
        untilDestroyed(this)
      )
      .subscribe(([_, highlightedOperators, highlightedCommentBoxes]) => {
        if (highlightedOperators.length > 0 || highlightedCommentBoxes.length > 0) {
          this.operatorMenu.saveHighlightedElements();
        }
      });
  }

  /**
   * Caches the currently highlighted operators' info and deletes it
   * when user triggers the cut event (i.e. presses command/ctrl + x
   * on keyboard or selects cut option from the browser menu).
   */
  private handleElementCut(): void {
    fromEvent<ClipboardEvent>(document, "cut")
      .pipe(
        filter(() => document.activeElement === document.body),
        filter(() => this.interactive),
        withLatestFrom(this.operatorMenu.highlightedOperators$, this.operatorMenu.highlightedCommentBoxes$),
        untilDestroyed(this)
      )
      .subscribe(([_, highlightedOperators, highlightedCommentBoxes]) => {
        if (highlightedOperators.length > 0 || highlightedCommentBoxes.length > 0) {
          this.operatorMenu.saveHighlightedElements();
          this.deleteElements();
        }
      });
  }

  /**
   * Pastes the cached operators onto the workflow graph and highlights them
   * when user triggers the paste event (i.e. presses command/ctrl + v on
   * keyboard or selects paste option from the browser menu).
   */
  private handleElementPaste(): void {
    fromEvent<ClipboardEvent>(document, "paste")
      .pipe(
        filter(() => document.activeElement === document.body),
        filter(() => this.interactive),
        untilDestroyed(this)
      )
      .subscribe(() => this.operatorMenu.performPasteOperation());
  }

  /**
   * handle the events of the cursor enter/leave a jointJS link cell
   *
   * Originally, such "hover -> appear" feature came as a default setting with JointJS library
   * However, in order to achieve conditional disappearance for the breakpoint button,
   * every interaction between the cursor and the link tools, including the delete button,
   * need to be handled manually
   */
  private handleLinkCursorHover(): void {
    // When the cursor hovers over a link, the delete button and the breakpoint button appear
    fromJointPaperEvent(this.paper, "link:mouseenter")
      .pipe(map(value => value[0]))
      .pipe(untilDestroyed(this))
      .subscribe(linkView => {
        // Create an array to hold the tools
        const tools: joint.dia.ToolView[] = [new this.removeButton()];

        // If breakpoints are enabled, also add the breakpoint button
        if (this.config.env.linkBreakpointEnabled) {
          tools.push(new this.breakpointButton());
        }

        const toolsView = new joint.dia.ToolsView({ tools });
        linkView.addTools(toolsView);
      });

    /**
     * When the cursor leaves a link, the delete button disappears.
     * If there is no breakpoint present on that link, the breakpoint button also disappears,
     * otherwise, the breakpoint button is not changed.
     */
    fromJointPaperEvent(this.paper, "link:mouseleave")
      .pipe(map(value => value[0]))
      .pipe(untilDestroyed(this))
      .subscribe(elementView => {
        // ensure that the link element exists
        if (this.paper.getModelById(elementView.model.id)) {
          const LinksWithBreakpoint = this.wrapper.getLinkIDsWithBreakpoint();
          if (!LinksWithBreakpoint.includes(elementView.model.id.toString())) {
            this.paper.getModelById(elementView.model.id).findView(this.paper).hideTools();
          }
          this.paper.getModelById(elementView.model.id).attr({
            ".tool-remove": { display: "none" },
          });
        }
      });
  }

  /**
   * handles events/observables related to the breakpoint
   */
  private handleLinkBreakpoint(): void {
    this.handleLinkBreakpointToolAttachment();
    this.handleLinkBreakpointButtonClick();
    this.handleLinkBreakpointHighlightEvents();
    this.handleLinkBreakpointToggleEvents();
  }

  // when a link is added, append a breakpoint link-tool to its LinkView
  private handleLinkBreakpointToolAttachment(): void {
    this.wrapper
      .getJointLinkCellAddStream()
      .pipe(this.wrapper.jointGraphContext.bufferWhileAsync, untilDestroyed(this))
      .subscribe(link => {
        const linkView = link.findView(this.paper);
        const breakpointButtonTool = this.breakpointButton;
        const breakpointButton = new breakpointButtonTool();
        const toolsView = new joint.dia.ToolsView({
          name: "basic-tools",
          tools: [breakpointButton],
        });
        linkView.addTools(toolsView);
        // tools remain hidden until the cursor hovers over it or a break point is added
        linkView.hideTools();
      });
  }

  /**
   * handles the events of the breakpoint button is clicked for a link
   * and converts that event to a workflow action
   */
  private handleLinkBreakpointButtonClick(): void {
    fromJointPaperEvent(this.paper, "tool:breakpoint")
      .pipe(untilDestroyed(this))
      .subscribe(event => {
        // set the multi-select mode
        this.wrapper.setMultiSelectMode(<boolean>event[1].shiftKey);
        const clickedLinkID = event[0].model.id.toString();
        if (event[1].shiftKey) {
          if (this.wrapper.getCurrentHighlightedLinkIDs().includes(clickedLinkID)) {
            // if the link being clicked is already highlighted, unhighlight it
            this.workflowActionService.unhighlightLinks(clickedLinkID);
          } else if (this.workflowActionService.getTexeraGraph().hasLinkWithID(clickedLinkID)) {
            // highlight the link if the link has not already been highlighted
            this.workflowActionService.highlightLinks(<boolean>event[1].shiftKey, clickedLinkID);
          }
        } else {
          // if user doesn't click on the shift key, highlight only a single link
          if (this.workflowActionService.getTexeraGraph().hasLinkWithID(clickedLinkID)) {
            this.workflowActionService.highlightLinks(<boolean>event[1].shiftKey, clickedLinkID);
          }
        }
      });
  }

  /**
   * Highlight/unhighlight the link according to the observable value received.
   */
  private handleLinkBreakpointHighlightEvents(): void {
    this.wrapper
      .getLinkHighlightStream()
      .pipe(untilDestroyed(this))
      .subscribe(linkIDs => {
        linkIDs.forEach(linkID => {
          this.paper.getModelById(linkID).attr({
            ".connection": { stroke: "orange" },
            ".marker-source": { fill: "orange" },
            ".marker-target": { fill: "orange" },
          });
        });
      });

    this.wrapper
      .getLinkUnhighlightStream()
      .pipe(untilDestroyed(this))
      .subscribe(linkIDs => {
        linkIDs.forEach(linkID => {
          this.paper.findViewByModel(linkID);
          if (this.paper.getModelById(linkID)) {
            // ensure that the link still exist
            this.paper.getModelById(linkID).attr({
              ".connection": { stroke: linkPathStrokeColor },
              ".marker-source": { fill: "none" },
              ".marker-target": { fill: "none" },
            });
          }
        });
      });
  }

  /**
   * show/hide the breakpoint button according to the observable value received
   */
  private handleLinkBreakpointToggleEvents(): void {
    this.wrapper
      .getLinkBreakpointShowStream()
      .pipe(this.wrapper.jointGraphContext.bufferWhileAsync, untilDestroyed(this))
      .subscribe(linkID => {
        this.paper.getModelById(linkID.linkID).findView(this.paper).showTools();
      });

    this.wrapper
      .getLinkBreakpointHideStream()
      .pipe(this.wrapper.jointGraphContext.bufferWhileAsync, untilDestroyed(this))
      .subscribe(linkID => {
        this.paper.getModelById(linkID.linkID).findView(this.paper).hideTools();
      });
  }

  private isSource(operatorID: string): boolean {
    return this.workflowActionService.getTexeraGraph().getOperator(operatorID).inputPorts.length == 0;
  }

  private isSink(operatorID: string): boolean {
    return this.workflowActionService.getTexeraGraph().getOperator(operatorID).outputPorts.length == 0;
  }

  /**
   * Handles mouse events to enable shared cursor.
   */
  private handlePointerEvents(): void {
    fromEvent<MouseEvent>(this.editor, "mousemove")
      .pipe(untilDestroyed(this))
      .subscribe(e => {
        const jointPoint = this.paper.clientToLocalPoint({ x: e.clientX, y: e.clientY });
        this.workflowActionService.getTexeraGraph().updateSharedModelAwareness("userCursor", jointPoint);
      });
    fromEvent<MouseEvent>(this.editor, "mouseleave")
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        this.workflowActionService.getTexeraGraph().updateSharedModelAwareness("isActive", false);
      });
    fromEvent<MouseEvent>(this.editor, "mouseenter")
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        this.workflowActionService.getTexeraGraph().updateSharedModelAwareness("isActive", true);
      });
  }

  private setURLFragment(fragment: string | null): void {
    this.router.navigate([], {
      relativeTo: this.route,
      fragment: fragment !== null ? fragment : undefined,
      preserveFragment: false,
    });
  }

  private handleURLFragment(): void {
    // when operator/link/comment box is highlighted/unhighlighted, update URL fragment
    merge(
      this.wrapper.getJointOperatorHighlightStream(),
      this.wrapper.getJointOperatorUnhighlightStream(),
      this.wrapper.getLinkHighlightStream(),
      this.wrapper.getLinkUnhighlightStream(),
      this.wrapper.getJointCommentBoxHighlightStream(),
      this.wrapper.getJointCommentBoxUnhighlightStream()
    )
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        // add element ID to URL fragment when only one element is highlighted
        // clear URL fragment when no element or multiple elements are highlighted
        //          from state      -> to state
        // case 1a: no highlighted  -> highlight one element
        // case 1b: more than one elements highlighted -> unhighlight some elements so that only one element is highlighted
        // for case 1: set URL fragment to the highlighted element
        // case 2a: one element highlighted -> unhighlight the element
        // case 2b: one element highlighted -> highlight another element
        // for case 2: clear URL fragment
        // other cases, do nothing
        const highlightedIds = this.wrapper.getCurrentHighlightedIDs();
        if (highlightedIds.length === 1) {
          this.setURLFragment(highlightedIds[0]);
        } else {
          this.setURLFragment(null);
        }
      });

    // special case: open comment box when URL fragment is set
    this.workflowActionService
      .getTexeraGraph()
      .getCommentBoxAddStream()
      .pipe(untilDestroyed(this))
      .subscribe(box => {
        if (this.route.snapshot.fragment === box.commentBoxID) {
          this.openCommentBox(box.commentBoxID);
        }
      });
  }
  invokeResize() {
    const resizeEvent = new Event("resize");
    setTimeout(() => {
      window.dispatchEvent(resizeEvent);
    }, 175);
  }

  /**
   * Handles the center event triggered from the group
   */
  private handleCenterEvent(): void {
    const CENTER_OFFSET_RATIO = 0.15; // Offset ratio used to leave margin when centering
    this.workflowActionService
      .getTexeraGraph()
      .getCenterEventStream()
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        this.workflowActionService.calculateTopLeftOperatorPosition();

        const centerCoord = this.workflowActionService.getCenterPoint();
        const offsetX = this.editor.offsetWidth * CENTER_OFFSET_RATIO;
        const offsetY = this.editor.offsetHeight * CENTER_OFFSET_RATIO;

        const targetCoord = {
          x: centerCoord.x - offsetX,
          y: centerCoord.y - offsetY,
        };

        this.paper.translate(-targetCoord.x, -targetCoord.y);
      });
  }

  /**
   * Handle agent hover highlighting to show "viewed", "added", and "modified" labels on operators
   */
  private handleAgentHoverHighlight(): void {
    const setupAgentHoverSubscription = () => {
      this.agentService
        .getAllAgents()
        .pipe(untilDestroyed(this))
        .subscribe(agents => {
          agents.forEach(agent => {
            // Subscribe to each agent's hover operators stream
            this.agentService
              .getHoveredMessageOperatorsObservable(agent.id)
              .pipe(untilDestroyed(this))
              .subscribe(operatorIds => {
                this.agentActionHighlight = { agentName: agent.name, operatorIds };
                this.applyAgentActionHighlight();
              });
          });
        });
    };

    // Subscribe to agent changes to set up hover subscriptions
    this.agentService.agentChange$.pipe(untilDestroyed(this)).subscribe(() => {
      setupAgentHoverSubscription();
    });

    // Initial setup
    setupAgentHoverSubscription();
  }

  /**
   * Draw the current agent action highlight (the hovered step, or the latest
   * step that changed the workflow), skipping operators the canvas does not
   * have. Idempotent: every call repaints from scratch.
   */
  private applyAgentActionHighlight(): void {
    this.clearAllAgentActionLabels();
    const highlight = this.agentActionHighlight;
    if (!highlight) {
      return;
    }
    const { viewedOperatorIds, addedOperatorIds, modifiedOperatorIds } = highlight.operatorIds;
    const show = (operatorIds: string[], actionType: "viewed" | "added" | "modified") =>
      operatorIds.forEach(operatorId => {
        if (this.workflowActionService.getTexeraGraph().hasOperator(operatorId)) {
          this.jointUIService.showAgentActionLabel(this.paper, operatorId, actionType, highlight.agentName);
        }
      });
    show(viewedOperatorIds, "viewed");
    show(addedOperatorIds, "added");
    show(modifiedOperatorIds, "modified");
  }

  /**
   * Clear all agent action labels from all operators
   */
  private clearAllAgentActionLabels(): void {
    this.workflowActionService
      .getTexeraGraph()
      .getAllOperators()
      .forEach(op => {
        this.jointUIService.hideAgentActionLabel(this.paper, op.operatorID);
      });
  }

  /**
   * Handle the chat button click on operators.
   * Opens a chat popover for the operator to interact with agents.
   */
  private handleOperatorChatButton(): void {
    fromJointPaperEvent(this.paper, "element:chat")
      .pipe(
        map(value => value[0]),
        untilDestroyed(this)
      )
      .subscribe(elementView => {
        const operatorId = elementView.model.id.toString();
        if (!this.workflowActionService.getTexeraGraph().hasOperator(operatorId)) {
          return;
        }

        // Toggle chat popover for this operator
        const open = this.chatPopoverOperator;
        if (open && open.operatorId === operatorId) {
          // Selecting a native operator already opened its panel: the button turns it to feedback.
          if (open.native && open.mode !== "feedback") {
            this.chatPopoverOperator = { ...open, mode: "feedback" };
          } else {
            // Close if clicking the same operator
            this.chatPopoverOperator = null;
          }
        } else {
          this.openOperatorPanel(operatorId, "feedback");
        }
        this.changeDetectorRef.detectChanges();
      });

    // Close chat popover when clicking on blank area
    fromJointPaperEvent(this.paper, "blank:pointerdown")
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        if (this.chatPopoverOperator) {
          this.closeChatPopover();
        }
      });

    // Update chat popover and context positions when operator moves
    this.paper.model.on("change:position", (cell: joint.dia.Cell) => {
      const cellId = cell.id.toString();

      // Update popover position if the chat operator moves
      if (this.chatPopoverOperator && cellId === this.chatPopoverOperator.operatorId) {
        const position = this.getOperatorChatPopoverPosition(this.chatPopoverOperator.operatorId);
        if (position) {
          this.chatPopoverOperator = { ...this.chatPopoverOperator, position };
        }
      }

      this.changeDetectorRef.detectChanges();
    });

    // Update position on zoom/pan
    this.wrapper
      .getWorkflowEditorZoomStream()
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        if (this.chatPopoverOperator) {
          const position = this.getOperatorChatPopoverPosition(this.chatPopoverOperator.operatorId);
          if (position) {
            this.chatPopoverOperator = { ...this.chatPopoverOperator, position };
          }
        }

        this.changeDetectorRef.detectChanges();
      });
  }

  /**
   * Selecting one native operator opens its panel: Run, Edit and Feedback, in
   * place of the property editor. The panel outlives the canvas reload that
   * follows an edit (every operator is removed and added again), keeping the
   * operator selected, and closes when the operator is gone or another
   * selection replaces it.
   */
  private handleNativeOperatorPanel(): void {
    this.wrapper
      .getJointOperatorHighlightStream()
      .pipe(untilDestroyed(this))
      .subscribe(() => {
        const highlighted = this.wrapper.getCurrentHighlightedOperatorIDs();
        const graph = this.workflowActionService.getTexeraGraph();
        if (highlighted.length !== 1) {
          if (this.chatPopoverOperator?.native) this.closeChatPopover();
          return;
        }
        const operatorId = highlighted[0];
        if (this.chatPopoverOperator?.operatorId === operatorId) return;
        const operator = graph.hasOperator(operatorId) ? graph.getOperator(operatorId) : undefined;
        if (!isNativeOperator(operator)) {
          if (this.chatPopoverOperator?.native) this.closeChatPopover();
          return;
        }
        this.openOperatorPanel(operatorId, "actions");
        this.changeDetectorRef.detectChanges();
      });

    const graph = this.workflowActionService.getTexeraGraph();
    graph
      .getOperatorAddStream()
      .pipe(untilDestroyed(this))
      .subscribe(operator => {
        if (operator.operatorID !== this.chatPopoverOperator?.operatorId) return;
        // Re-added by a reload: follow its new box once the paper has drawn it.
        setTimeout(() => {
          const panel = this.chatPopoverOperator;
          if (!panel || panel.operatorId !== operator.operatorID || !graph.hasOperator(panel.operatorId)) return;
          const position = this.getOperatorChatPopoverPosition(panel.operatorId);
          if (position) this.chatPopoverOperator = { ...panel, position };
          if (panel.native && !this.wrapper.getCurrentHighlightedOperatorIDs().includes(panel.operatorId))
            this.wrapper.highlightOperators(panel.operatorId);
          this.changeDetectorRef.detectChanges();
        });
      });
    graph
      .getOperatorDeleteStream()
      .pipe(untilDestroyed(this))
      .subscribe(({ deletedOperatorID }) => {
        if (deletedOperatorID !== this.chatPopoverOperator?.operatorId) return;
        // A reload deletes and re-adds every operator in one pass.
        setTimeout(() => {
          if (this.chatPopoverOperator && !graph.hasOperator(this.chatPopoverOperator.operatorId))
            this.closeChatPopover();
        });
      });
  }

  /**
   * Open an operator's panel below it: what it is, its data, and for a native
   * operator Run / Edit / Feedback ("feedback" opens it on the feedback box).
   */
  private openOperatorPanel(operatorId: string, mode: "actions" | "feedback"): void {
    const position = this.getOperatorChatPopoverPosition(operatorId);
    if (!position) return;
    const operator = this.workflowActionService.getTexeraGraph().getOperator(operatorId);
    const displayName =
      operator.customDisplayName ??
      this.dynamicSchemaService.getDynamicSchema(operatorId)?.additionalMetadata.userFriendlyName ??
      operator.operatorType;
    this.chatPopoverOperator = { operatorId, displayName, position, native: isNativeOperator(operator), mode };
    // Results are pulled on demand (not pushed over the socket); refresh the
    // active agent's summaries so the panel shows current data.
    const activeAgentId = this.agentService.getActivelyConnectedAgentIds()[0];
    if (activeAgentId) this.agentService.fetchOperatorResults(activeAgentId);
  }

  /**
   * Get the screen position for the chat popover relative to an operator.
   */
  private getOperatorChatPopoverPosition(operatorId: string): { x: number; y: number } | null {
    const jointCell = this.paper.getModelById(operatorId);
    if (!jointCell) {
      return null;
    }

    const bbox = jointCell.getBBox();
    const scale = this.paper.scale();
    const translate = this.paper.translate();

    // Position popover directly below the operator body, centered horizontally.
    // The display name lives inside the box, so only a small screen-space gap
    // (for the popover's caret) separates the two.
    const screenX = (bbox.x + bbox.width / 2) * scale.sx + translate.tx;
    const screenY = (bbox.y + bbox.height) * scale.sy + translate.ty + WorkflowEditorComponent.CHAT_POPOVER_GAP_PX;

    return { x: screenX, y: screenY };
  }

  /**
   * Close the chat popover.
   */
  closeChatPopover(): void {
    this.chatPopoverOperator = null;
    this.changeDetectorRef.detectChanges();
  }

  /**
   * Info button on link between operator shown when user hovers over links
   */
  private static getBreakpointButton(): new () => joint.linkTools.Button {
    return joint.linkTools.Button.extend({
      name: "info-button",
      options: {
        markup: [
          {
            tagName: "circle",
            selector: "info-button",
            attributes: {
              r: 10,
              fill: "#001DFF",
              cursor: "pointer",
            },
          },
          {
            tagName: "path",
            selector: "icon",
            attributes: {
              d: "M -2 4 2 4 M 0 3 0 0 M -2 -1 1 -1 M -1 -4 1 -4",
              fill: "none",
              stroke: "#FFFFFF",
              "stroke-width": 2,
              "pointer-events": "none",
            },
          },
        ],
        distance: -60,
        offset: 0,
        action: function (event: JQuery.Event, linkView: joint.dia.LinkView) {
          // when this button is clicked, it triggers an joint paper event
          if (linkView.paper) {
            linkView.paper.trigger("tool:breakpoint", linkView, event);
          }
        },
      },
    });
  }

  /**
   * Remove button on link between operator shown when user hovers over links
   */
  private static RemoveButton: new () => joint.linkTools.Button;

  private static getRemoveButton(): new () => joint.linkTools.Button {
    if (!WorkflowEditorComponent.RemoveButton) {
      WorkflowEditorComponent.RemoveButton = joint.linkTools.Button.extend({
        name: "remove-button",
        options: {
          markup: [
            {
              tagName: "circle",
              selector: "button",
              attributes: {
                r: 9,
                fill: "none",
                stroke: "#D8656A",
                "stroke-width": 2,
                "pointer-events": "visibleFill",
                cursor: "pointer",
              },
            },
            {
              tagName: "path",
              selector: "icon",
              attributes: {
                d: "M -4 -4 L 4 4 M 4 -4 L -4 4",
                fill: "none",
                stroke: "#D8656A",
                "stroke-width": 2,
                "stroke-linecap": "round",
                "pointer-events": "none",
              },
            },
          ],
          distance: -90,
          offset: 0,
          action: function (evt: JQuery.Event, linkView: joint.dia.LinkView) {
            if (linkView.paper) {
              linkView.paper.trigger("tool:remove", linkView, evt);
            }
          },
        },
      });
    }

    return WorkflowEditorComponent.RemoveButton;
  }
}
