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

import { Injectable } from "@angular/core";
import { OperatorMetadataService } from "../operator-metadata/operator-metadata.service";
import { OperatorSchema } from "../../types/operator-schema.interface";
import { CommentBox, OperatorLink, OperatorPredicate, Point } from "../../types/workflow-common.interface";
import { OperatorState, OperatorStatistics } from "../../types/execute-workflow.interface";
import * as joint from "jointjs";
import { fromEventPattern, Observable } from "rxjs";
import { Coeditor } from "../../../common/type/user";
import { OperatorResultCacheStatus } from "../../types/workflow-websocket.interface";
import {
  isNativeOperator,
  nativeOperatorIcon,
  nativeOperatorSummary,
  nativeOperatorTypeName,
  nativeScanFileKind,
  nativeScanFileLabel,
} from "../agent/native-operator";

/**
 * Defines the SVG path for the delete button
 */
export const deleteButtonPath =
  "M14.59 8L12 10.59 9.41 8 8 9.41 10.59 12 8 14.59 9.41 16 12 13.41" +
  " 14.59 16 16 14.59 13.41 12 16 9.41 14.59 8zM12 2C6.47 2 2 6.47 2" +
  " 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z";

/**
 * Defines the HTML SVG element for the delete button and customizes the look
 */
export const deleteButtonSVG = `
  <svg class="delete-button" height="24" width="24">
    <path d="M0 0h24v24H0z" fill="none" pointer-events="visible" />
    <path d="${deleteButtonPath}"/>
    <title>delete operator</title>
  </svg>`;

/**
 * Defines the SVG for the chat button (message icon)
 * This button allows users to send feedback to agents about this operator
 */
export const chatButtonSVG = `
  <svg class="chat-button" height="20" width="20" viewBox="0 0 24 24">
    <rect x="0" y="0" width="24" height="24" fill="transparent" pointer-events="visible" />
    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
    <title>Chat with agent about this operator</title>
  </svg>
`;

/**
 * Defines the handle (the square at the end) of the source operator for a link
 */
export const sourceOperatorHandle = "M 0 0 L 0 8 L 8 8 L 8 0 z";

/**
 * Defines the handle (the arrow at the end) of the target operator for a link
 */
export const targetOperatorHandle = "M 13 0 L 0 6.5 L 13 13 z";

export const operatorReuseCacheTextClass = "texera-operator-result-reuse-text";
export const operatorReuseCacheIconClass = "texera-operator-result-reuse-icon";
export const operatorViewResultIconClass = "texera-operator-view-result-icon";
export const operatorStateClass = "texera-operator-state";
export const operatorCoeditorEditingClass = "texera-operator-coeditor-editing";
export const operatorCoeditorChangedPropertyClass = "texera-operator-coeditor-changed-property";
export const operatorAgentActionProgressClass = "texera-operator-agent-action-progress";
/** The status pill just below an operator's box (see `OperatorStatusBadge`). */
export const operatorStatusClass = "texera-operator-status";

export const operatorIconClass = "texera-operator-icon";
export const operatorNameClass = "texera-operator-name";
export const operatorFriendlyNameClass = "texera-operator-friendly-name";
export const operatorSectionDividerClass = "texera-operator-section-divider";
export const operatorPortMetricsClass = "texera-operator-port-metrics";
const operatorWorkerCountClass = "operator-worker-count";

/** Edges are near-black so the flow reads at a glance; the arrowhead shares the colour. */
export const linkPathStrokeColor = "#3f3f46";
/** An operator box's border when the operator is valid, and when it is not. */
export const operatorBorderColor = "#CBD2DA";
export const operatorInvalidBorderColor = "#ff4d4f";
/** The tinted left section of a box, behind its icon. */
export const operatorIconSectionClass = "texera-operator-icon-section";
/** A scan's icon: a document glyph tagged with the kind of file it reads. */
export const operatorFileGlyphClass = "texera-operator-file-glyph";
export const operatorFileKindClass = "texera-operator-file-kind";
/** A second, smaller line under a box's text (a scan's doc under its file name). */
export const operatorSubtitleClass = "texera-operator-subtitle";

/**
 * A link view whose arrowheads follow the curve: each turns along the stretch
 * of path it sits on. JointJS's legacy markers point along the straight line
 * between the link's ends, which on a curve that loops round (a box under or
 * behind the one feeding it) turns the arrowhead away from the input port.
 */
export const CurveLinkView = joint.dia.LinkView.extend({
  _translateAndAutoOrientArrows(this: any, sourceArrow?: joint.V, targetArrow?: joint.V): void {
    const length: number = this.getConnectionLength();
    const near = (at: number): joint.g.Point | null =>
      length > 2 ? this.getPointAtLength(Math.max(0, Math.min(length, at))) : null;
    sourceArrow?.translateAndAutoOrient(this.sourcePoint, near(1) ?? this.targetPoint, this.paper.cells);
    targetArrow?.translateAndAutoOrient(this.targetPoint, near(length - 1) ?? this.sourcePoint, this.paper.cells);
  },
});

/**
 * Extends a basic Joint operator element and adds our own HTML markup.
 * Our own HTML markup includes the SVG element for the delete button,
 *   which will show a red delete button on the top right corner
 */
class TexeraCustomJointElement extends joint.shapes.devs.Model {
  // No add/remove port buttons: an operator's ports are what its definition gives it.
  static getMarkup(): string {
    return `
    <g class="element-node">
      <rect class="body"></rect>
      <path class="${operatorIconSectionClass}"></path>
      <rect class="${operatorSectionDividerClass}"></rect>
      <image class="${operatorIconClass}"></image>
      <path class="${operatorFileGlyphClass}"></path>
      <text class="${operatorFileKindClass}"></text>
      <text class="${operatorFriendlyNameClass}"></text>
      <text class="${operatorNameClass}"></text>
      <text class="${operatorSubtitleClass}"></text>
      <text class="${operatorPortMetricsClass}"></text>
      <text class="${operatorWorkerCountClass}"></text>
      <text class="${operatorStateClass}"></text>
      <text class="${operatorReuseCacheTextClass}"></text>
      <text class="${operatorCoeditorEditingClass}"></text>
      <text class="${operatorCoeditorChangedPropertyClass}"></text>
      <text class="${operatorAgentActionProgressClass}"></text>
      <image class="${operatorViewResultIconClass}"></image>
      <image class="${operatorReuseCacheIconClass}"></image>
      <text class="${operatorCoeditorEditingClass}"></text>
      <text class="${operatorCoeditorChangedPropertyClass}"></text>
      <image class="${operatorViewResultIconClass}"></image>
      <rect class="boundary"></rect>
      <path class="left-boundary"></path>
      <path class="right-boundary"></path>
      <g class="${operatorStatusClass}">
        <rect class="${operatorStatusClass}-pill"></rect>
        <g class="${operatorStatusClass}-spinner">
          <path d="M 0 -4.5 A 4.5 4.5 0 1 1 -4.5 0" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="0.9s" repeatCount="indefinite"/>
          </path>
        </g>
        <text class="${operatorStatusClass}-text"></text>
      </g>
      ${deleteButtonSVG}
      ${chatButtonSVG}
    </g>
    `;
  }
}

class TexeraCustomCommentElement extends joint.shapes.devs.Model {
  markup = `<g class = "element-node">
  <rect class = "body"></rect>
  ${deleteButtonSVG}
  <image></image>
  </g>`;
}
/**
 * What an operator's status pill says, just below its box: it is computing
 * (with a spinner), it finished, its result was reused from cache, or it
 * failed. Its border says the same in colour.
 */
export type OperatorStatusBadge = "running" | "done" | "cached" | "failed";

const STATUS_BADGES: Readonly<Record<OperatorStatusBadge, { text: string; fill: string; width: number }>> = {
  running: { text: "Running", fill: "#fa8c16", width: 76 },
  done: { text: "✓", fill: "#52c41a", width: 20 },
  cached: { text: "cached", fill: "#1677ff", width: 56 },
  failed: { text: "failed", fill: "#ff4d4f", width: 52 },
};

/**
 * JointUIService controls the shape of an operator and a link
 *  when they are displayed by JointJS.
 *
 * This service alters the basic JointJS element by:
 *  - setting the ID of the JointJS element to be the same as Texera's OperatorID
 *  - changing the look of the operator box (size, colors, lines, etc..)
 *  - adding input and output ports to the box based on the operator metadata
 *  - changing the SVG element and CSS styles of operators, links, ports, etc..
 *  - adding a new delete button and the callback function of the delete button,
 *      (original JointJS element doesn't have a built-in delete button)
 *
 * @author Henry Chen
 * @author Zuozhi Wang
 */
@Injectable({
  providedIn: "root",
})
export class JointUIService {
  // The operator box is a fixed-size rectangle split into two sections:
  //   - a left icon section (ICON_SECTION_WIDTH wide) holding the operator icon
  //   - a right text section holding the operator's description / custom name
  // The box never grows with its text; overflowing text is ellipsized instead.

  /** Colour per agent action; shared by the label text and the highlight ring. */
  public static readonly AGENT_ACTION_COLORS: Readonly<Record<"viewed" | "added" | "modified", string>> = {
    viewed: "#1890ff",
    added: "#52c41a",
    modified: "#fa8c16",
  };
  public static readonly AGENT_ACTION_FONT_SIZE = 14;

  // Room for a native operator's doc in full (about 100 characters, four lines).
  public static readonly DEFAULT_OPERATOR_WIDTH = 240;
  public static readonly DEFAULT_OPERATOR_HEIGHT = 96;
  /** How far below the box the centre of its status pill sits; the pill is 18px tall. */
  public static readonly STATUS_PILL_OFFSET = 13;
  // Width of the left icon section; the divider is drawn at this x offset.
  public static readonly ICON_SECTION_WIDTH = 48;
  // Padding between the divider and the description text on the right section.
  private static readonly TEXT_SECTION_PADDING = 8;
  // Strip above the box's right edge taken by the delete + agent-chat buttons.
  // The id/type label is truncated to this much less than the full width so it
  // can never grow underneath them.
  private static readonly BUTTON_ROW_WIDTH = 56;
  // The wrapping box for the right-section description text.
  private static readonly DESC_TEXT_WIDTH =
    JointUIService.DEFAULT_OPERATOR_WIDTH - JointUIService.ICON_SECTION_WIDTH - JointUIService.TEXT_SECTION_PADDING * 2;
  private static readonly DESC_TEXT_HEIGHT = JointUIService.DEFAULT_OPERATOR_HEIGHT - 14;
  // Font sizes for the in-box labels. Kept here (not inline) so the rendered
  // size and the size `breakText` measures with stay in sync — a mismatch
  // makes wrapping/ellipsis disagree with what's actually drawn.
  private static readonly DESC_FONT_SIZE = 13.5; // custom display name / description
  private static readonly ID_FONT_SIZE = 15; // operator id label above the box
  // A scan's file name, in bold, and its doc under it.
  private static readonly FILE_FONT_SIZE = 13.5;
  private static readonly SCAN_DOC_FONT_SIZE = 12;
  /** Corner radius of the box; the icon section's left corners follow it. */
  private static readonly BOX_RADIUS = 9;

  /** The icon section's outline: the box's left part, with its rounded corners,
   * inset by half the border width so the border keeps its full weight. */
  private static iconSectionPath(): string {
    const inset = 0.75;
    const r = JointUIService.BOX_RADIUS - inset;
    const w = JointUIService.ICON_SECTION_WIDTH;
    const h = JointUIService.DEFAULT_OPERATOR_HEIGHT - inset;
    const x = inset;
    const y = inset;
    return `M ${x + r} ${y} H ${w} V ${h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${h - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
  }
  public static readonly DEFAULT_GROUP_MARGIN = 50;
  public static readonly DEFAULT_GROUP_MARGIN_BOTTOM = 40;
  public static readonly DEFAULT_COMMENT_WIDTH = 32;
  public static readonly DEFAULT_COMMENT_HEIGHT = 32;
  public static readonly MAX_OPERATOR_NAME_PIXELS = 200;
  private static readonly OPERATOR_NAME_FONT = "14px sans-serif";
  private static measureCtx: CanvasRenderingContext2D | null = null;

  private static getMeasureContext(): CanvasRenderingContext2D | null {
    if (JointUIService.measureCtx) return JointUIService.measureCtx;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return null;
    ctx.font = JointUIService.OPERATOR_NAME_FONT;
    JointUIService.measureCtx = ctx;
    return ctx;
  }

  /** The width of `text` drawn in `font` (a CSS font), approximated where no canvas measures it. */
  private static measureText(text: string, font: string): number {
    const ctx = JointUIService.getMeasureContext();
    if (!ctx) return text.length * 7.5;
    const previous = ctx.font;
    ctx.font = font;
    const width = ctx.measureText(text).width;
    ctx.font = previous;
    return width;
  }

  /**
   * A file name on at most two lines, the second ellipsized: broken after an
   * underscore, dot or dash where one fits, else where the line is full.
   */
  public static wrapFileName(name: string, width: number, fontSize: number): string {
    const measure = (text: string) => JointUIService.measureText(text, `600 ${fontSize}px sans-serif`);
    if (!name || measure(name) <= width) return name;
    let fits = 1;
    while (fits < name.length && measure(name.slice(0, fits + 1)) <= width) fits++;
    let cut = fits;
    for (let i = fits; i > fits / 2; i--)
      if (/[_.\-]/.test(name[i - 1])) {
        cut = i;
        break;
      }
    const tail = name.slice(cut);
    if (measure(tail) <= width) return `${name.slice(0, cut)}\n${tail}`;
    const ellipsis = "…";
    let kept = tail.length;
    while (kept > 0 && measure(tail.slice(0, kept) + ellipsis) > width) kept--;
    return `${name.slice(0, cut)}\n${tail.slice(0, kept)}${ellipsis}`;
  }

  public static measureOperatorNameWidth(text: string): number {
    const ctx = JointUIService.getMeasureContext();
    if (ctx) return ctx.measureText(text).width;
    // Fallback for jsdom-without-canvas: approximate at ~14px sans-serif.
    return text.length * 7;
  }

  // Split a string into grapheme clusters so truncation does not break
  // surrogate pairs (emoji) or ZWJ sequences (e.g. family emoji, flags).
  // Falls back to code-point iteration if Intl.Segmenter is unavailable.
  private static splitGraphemes(name: string): string[] {
    if (typeof Intl.Segmenter === "function") {
      return Array.from(new Intl.Segmenter().segment(name), s => s.segment);
    }
    return Array.from(name);
  }

  public static truncateOperatorDisplayName(
    name: string,
    measure: (text: string) => number = JointUIService.measureOperatorNameWidth
  ): string {
    if (!name) return name;
    const budget = JointUIService.MAX_OPERATOR_NAME_PIXELS;
    if (measure(name) <= budget) return name;
    const ellipsis = "…";
    const prefixBudget = budget - measure(ellipsis);
    const graphemes = JointUIService.splitGraphemes(name);
    // Binary-search the longest grapheme prefix that fits inside prefixBudget.
    let lo = 0;
    let hi = graphemes.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (measure(graphemes.slice(0, mid).join("")) <= prefixBudget) lo = mid;
      else hi = mid - 1;
    }
    return graphemes.slice(0, lo).join("") + ellipsis;
  }

  private operatorSchemas: ReadonlyArray<OperatorSchema> = [];

  constructor(private operatorMetadataService: OperatorMetadataService) {
    // initialize the operator information
    // subscribe to operator metadata observable
    this.operatorMetadataService.getOperatorMetadata().subscribe(value => (this.operatorSchemas = value.operators));
  }

  /**
   * Gets the JointJS UI Element object based on the operator predicate.
   * A JointJS Element could be added to the JointJS graph to let JointJS display the operator accordingly.
   *
   * The function checks if the operatorType exists in the metadata,
   *  if it doesn't, the program will throw an error.
   *
   * The function returns an element that has our custom style,
   *  which are specified in getCustomOperatorStyleAttrs() and getCustomPortStyleAttrs()
   *
   *
   * @param operator OperatorPredicate, the type of the operator
   * @param point Point, the top-left-originated position of the operator element (relative to JointJS paper, not absolute position)
   *
   * @returns JointJS Element
   */

  public getJointOperatorElement(operator: OperatorPredicate, point: Point): joint.dia.Element {
    // check if the operatorType exists in the operator metadata
    const operatorSchema = this.operatorSchemas.find(op => op.operatorType === operator.operatorType);
    if (operatorSchema === undefined) {
      throw new Error(`operator type ${operator.operatorType} doesn't exist`);
    }

    // Text shown in the right section of the box. Prefer a meaningful custom
    // display name; otherwise fall back to the operator's description, then to
    // the user-friendly name. (customDisplayName defaults to the friendly name
    // at creation time, so treat that case as "no custom name set".)
    const friendlyName = operatorSchema.additionalMetadata.userFriendlyName;
    const description = operatorSchema.additionalMetadata.operatorDescription;
    const custom = operator.customDisplayName;
    // A native operator says what it computes: its doc, else its statement.
    const rightSectionText = isNativeOperator(operator)
      ? nativeOperatorSummary(operator)
      : custom && custom !== friendlyName
        ? custom
        : description && description.length > 0
          ? description
          : friendlyName;

    // construct a custom Texera JointJS operator element
    //   and customize the styles of the operator box and ports
    const operatorElement = new TexeraCustomJointElement({
      position: point,
      size: {
        width: JointUIService.DEFAULT_OPERATOR_WIDTH,
        height: JointUIService.DEFAULT_OPERATOR_HEIGHT,
      },
      attrs: JointUIService.getCustomOperatorStyleAttrs(
        operator,
        rightSectionText,
        operatorSchema.operatorType,
        operatorSchema.additionalMetadata.userFriendlyName
      ),
      ports: {
        groups: {
          in: { attrs: JointUIService.getCustomPortStyleAttrs() },
          out: { attrs: JointUIService.getCustomPortStyleAttrs() },
        },
      },
      markup: TexeraCustomJointElement.getMarkup(),
    });

    // set operator element ID to be operator ID
    operatorElement.set("id", operator.operatorID);
    operatorElement.set("z", 1);

    // set the input ports and output ports based on operator predicate
    operator.inputPorts.forEach(port =>
      operatorElement.addPort({
        group: "in",
        id: port.portID,
        attrs: {
          ".port-label": {
            text: port.displayName ?? "",
            event: "input-port-label:pointerdown",
          },
        },
        label: {
          position: {
            name: "left",
            args: { x: -5, y: 10 },
          },
        },
      })
    );
    operator.outputPorts.forEach(port =>
      operatorElement.addPort({
        group: "out",
        id: port.portID,
        attrs: {
          ".port-label": {
            text: port.displayName ?? "",
            event: "output-port-label:pointerdown",
          },
        },
        label: {
          position: {
            name: "right",
            args: { x: 5, y: -10 },
          },
        },
      })
    );

    return operatorElement;
  }

  public changeOperatorStatistics(
    jointPaper: joint.dia.Paper,
    operatorID: string,
    statistics: OperatorStatistics | undefined,
    isSource: boolean,
    isSink: boolean
  ): void {
    if (!statistics) {
      this.changeOperatorState(jointPaper, operatorID, OperatorState.Uninitialized);
      return;
    }

    this.changeOperatorState(jointPaper, operatorID, statistics.operatorState);

    const element = jointPaper.getModelById(operatorID) as joint.shapes.devs.Model;
    const allPorts = element.getPorts();
    const inPorts = allPorts.filter(p => p.group === "in");
    const outPorts = allPorts.filter(p => p.group === "out");

    const inputMetrics = statistics.inputPortMetrics;
    const outputMetrics = statistics.outputPortMetrics;

    const workerCount = statistics.numWorkers ?? 1;
    element.attr(`.${operatorWorkerCountClass}/text`, "#workers: " + String(workerCount));

    inPorts.forEach(portDef => {
      const portId = portDef.id;
      if (portId != null) {
        const parts = portId.split("-");
        const numericSuffix = parts.length > 1 ? parts[1] : portId;
        const count: number = inputMetrics[numericSuffix] ?? 0;
        const rawAttrs = (portDef.attrs as any) || {};
        const oldText: string = (rawAttrs[".port-label"] && rawAttrs[".port-label"].text) || "";
        let originalName = oldText.includes(":") ? oldText.split(":", 1)[0].trim() : oldText;

        if (!originalName) {
          originalName = portId;
        }

        // A cache-reused result reports a `-1` sentinel; show 0 rather than -1.
        const labelText = Math.max(0, count).toLocaleString();
        element.portProp(portId, "attrs/.port-label/text", labelText);
        // The label carries the tuple count now (the port name stays hidden,
        // see getCustomPortStyleAttrs). The canvas shows it only on the
        // selected operators and their upstream (workflow-editor styles).
        element.portProp(portId, "attrs/.port-label/visibility", "visible");
      }
    });

    outPorts.forEach(portDef => {
      const portId = portDef.id;
      if (portId != null) {
        const parts = portId.split("-");
        const numericSuffix = parts.length > 1 ? parts[1] : portId;
        const count: number = outputMetrics[numericSuffix] ?? 0;
        const rawAttrs = (portDef.attrs as any) || {};
        const oldText: string = (rawAttrs[".port-label"] && rawAttrs[".port-label"].text) || "";
        let originalName = oldText.includes(":") ? oldText.split(":", 1)[0].trim() : oldText;

        if (!originalName) {
          originalName = portId;
        }

        // A cache-reused result reports a `-1` sentinel; show 0 rather than -1.
        const labelText = Math.max(0, count).toLocaleString();

        element.portProp(portId, "attrs/.port-label/text", labelText);
        // The label carries the tuple count now; the selection decides whether it shows.
        element.portProp(portId, "attrs/.port-label/visibility", "visible");
      }
    });
    this.changeOperatorState(jointPaper, operatorID, statistics.operatorState);
  }

  /**
   * Apply a stored snapshot result to an operator: colour it by its state
   * (e.g. green border when Completed), show its status pill and the
   * input/output tuple counts on its ports. Used for the agent's results,
   * which arrive with its snapshots rather than a live execution stream. Port
   * names stay hidden; only the counts show, and a count nothing recorded
   * (negative) shows none. No-op if the operator isn't on the paper yet.
   *
   * A `cached` result was reused from cache: blue border and a "cached" pill.
   * A `failed` operator gets a red border and a "failed" pill.
   */
  public setOperatorSnapshotResult(
    jointPaper: joint.dia.Paper,
    operatorID: string,
    operatorState: OperatorState,
    inputPortCounts: Record<string, number>,
    outputPortCounts: Record<string, number>,
    outcome?: "cached" | "failed"
  ): void {
    const element = jointPaper.getModelById(operatorID) as joint.shapes.devs.Model;
    if (!element) {
      return;
    }
    this.changeOperatorState(jointPaper, operatorID, operatorState);
    if (outcome) {
      element.attr("rect.body/stroke", STATUS_BADGES[outcome].fill);
      this.setOperatorStatusBadge(jointPaper, operatorID, outcome);
    }
    this.setSnapshotPortCounts(element, "in", inputPortCounts);
    this.setSnapshotPortCounts(element, "out", outputPortCounts);
  }

  /**
   * Show an operator's status pill just below its box, or hide it: clear of
   * the box's border and of the selection outline drawn over it. No-op if the
   * operator isn't on the paper.
   */
  public setOperatorStatusBadge(jointPaper: joint.dia.Paper, operatorID: string, badge?: OperatorStatusBadge): void {
    const element = jointPaper.getModelById(operatorID);
    if (!element) {
      return;
    }
    if (!badge) {
      element.attr(`.${operatorStatusClass}/display`, "none");
      return;
    }
    const { text, fill, width } = STATUS_BADGES[badge];
    const center = JointUIService.DEFAULT_OPERATOR_WIDTH / 2;
    const below = JointUIService.DEFAULT_OPERATOR_HEIGHT + JointUIService.STATUS_PILL_OFFSET;
    const spinning = badge === "running";
    const centered = { ref: "rect.body", "ref-y": below, "x-alignment": "middle", "y-alignment": "middle" };
    element.attr({
      [`.${operatorStatusClass}`]: { display: "inline" },
      [`.${operatorStatusClass}-pill`]: {
        ...centered,
        "ref-x": center,
        width,
        height: 18,
        rx: 9,
        ry: 9,
        fill,
        stroke: "#ffffff",
        "stroke-width": 1.5,
      },
      [`.${operatorStatusClass}-spinner`]: {
        ...centered,
        "ref-x": center - width / 2 + 11,
        display: spinning ? "inline" : "none",
      },
      [`.${operatorStatusClass}-text`]: {
        ...centered,
        "ref-x": spinning ? center + 6 : center,
        text,
        fill: "#ffffff",
        "font-size": "11px",
        "font-weight": 600,
      },
    });
  }

  /**
   * Reset an operator that previously showed a snapshot result back to the
   * uninitialized look (grey, like a not-yet-executed operator during a live
   * run) and hide its status pill and port counts. Used when checking out a
   * snapshot in which the operator has no recorded result. No-op if the
   * operator is gone.
   */
  public clearOperatorSnapshotResult(jointPaper: joint.dia.Paper, operatorID: string): void {
    const element = jointPaper.getModelById(operatorID) as joint.shapes.devs.Model;
    if (!element) {
      return;
    }
    this.changeOperatorState(jointPaper, operatorID, OperatorState.Uninitialized);
    element.getPorts().forEach(p => {
      if (p.id != null) {
        element.portProp(p.id, "attrs/.port-label/visibility", "hidden");
      }
    });
  }

  /** Write tuple counts onto the given port group, keyed by numeric port suffix; a negative (unknown) count shows none. */
  private setSnapshotPortCounts(
    element: joint.shapes.devs.Model,
    group: "in" | "out",
    counts: Record<string, number>
  ): void {
    element
      .getPorts()
      .filter(p => p.group === group)
      .forEach(p => {
        const portId = p.id;
        if (portId == null) {
          return;
        }
        const suffix = portId.includes("-") ? portId.split("-")[1] : portId;
        const count = counts[suffix];
        if (count === undefined) {
          return;
        }
        element.portProp(portId, "attrs/.port-label/text", count < 0 ? "" : count.toLocaleString());
        element.portProp(portId, "attrs/.port-label/visibility", count < 0 ? "hidden" : "visible");
      });
  }

  public foldOperatorDetails(jointPaper: joint.dia.Paper, operatorID: string): void {
    jointPaper.getModelById(operatorID).attr({
      [`.${operatorStateClass}`]: { visibility: "hidden" },
      [`.${operatorPortMetricsClass}`]: { visibility: "hidden" },
      ".delete-button": { visibility: "hidden" },
      ".chat-button": { visibility: "hidden" },
    });
  }

  public unfoldOperatorDetails(jointPaper: joint.dia.Paper, operatorID: string): void {
    jointPaper.getModelById(operatorID).attr({
      [`.${operatorStateClass}`]: { visibility: "visible" },
      [`.${operatorPortMetricsClass}`]: { visibility: "visible" },
      ".delete-button": { visibility: "visible" },
      ".chat-button": { visibility: "visible" },
    });
  }

  public changeOperatorState(jointPaper: joint.dia.Paper, operatorID: string, operatorState: OperatorState): void {
    let fillColor: string;
    switch (operatorState) {
      case OperatorState.Ready:
        fillColor = "#a6bd37";
        break;
      case OperatorState.Completed:
        fillColor = "green";
        break;
      case OperatorState.Pausing:
      case OperatorState.Paused:
        fillColor = "magenta";
        break;
      case OperatorState.Running:
        fillColor = "orange";
        break;
      default:
        fillColor = "gray";
        break;
    }
    jointPaper.getModelById(operatorID).attr({
      [`.${operatorStateClass}`]: { text: operatorState.toString(), fill: fillColor },
      "rect.body": { stroke: fillColor },
      [`.${operatorPortMetricsClass}`]: { fill: fillColor },
      [`.${operatorWorkerCountClass}`]: { fill: fillColor },
    });
    this.setOperatorStatusBadge(
      jointPaper,
      operatorID,
      operatorState === OperatorState.Running
        ? "running"
        : operatorState === OperatorState.Completed
          ? "done"
          : undefined
    );
    const element = jointPaper.getModelById(operatorID) as joint.shapes.devs.Model;
    const allPorts = element.getPorts();
    const inPorts = allPorts.filter(p => p.group === "in");
    inPorts.forEach(p => {
      if (p.id != null) {
        element.portProp(p.id, "attrs/.port-label/fill", fillColor);
      }
    });

    const outPorts = allPorts.filter(p => p.group === "out");
    outPorts.forEach(p => {
      if (p.id != null) {
        element.portProp(p.id, "attrs/.port-label/fill", fillColor);
      }
    });
  }

  /**
   * This method will change the operator's color based on the validation status
   *  valid  : default color
   *  invalid: red
   *
   * @param jointPaper
   * @param operatorID
   * @param isOperatorValid
   */
  public changeOperatorColor(jointPaper: joint.dia.Paper, operatorID: string, isOperatorValid: boolean): void {
    jointPaper
      .getModelById(operatorID)
      .attr("rect.body/stroke", isOperatorValid ? operatorBorderColor : operatorInvalidBorderColor);
  }

  public changeOperatorDisableStatus(jointPaper: joint.dia.Paper, operator: OperatorPredicate): void {
    jointPaper.getModelById(operator.operatorID).attr("rect.body/fill", JointUIService.getOperatorFillColor(operator));
  }

  public changeOperatorViewResultStatus(
    jointPaper: joint.dia.Paper,
    operator: OperatorPredicate,
    viewResult?: boolean
  ): void {
    const icon = JointUIService.getOperatorViewResultIcon(operator);
    jointPaper.getModelById(operator.operatorID).attr(`.${operatorViewResultIconClass}/xlink:href`, icon);
  }

  public changeOperatorReuseCacheStatus(
    jointPaper: joint.dia.Paper,
    operator: OperatorPredicate,
    cacheStatus?: OperatorResultCacheStatus
  ): void {
    JointUIService.getOperatorCacheDisplayText(operator, cacheStatus);
    const cacheIcon = JointUIService.getOperatorCacheIcon(operator, cacheStatus);

    jointPaper.getModelById(operator.operatorID).attr(`.${operatorReuseCacheIconClass}/xlink:href`, cacheIcon);
    const icon = JointUIService.getOperatorViewResultIcon(operator);
    jointPaper.getModelById(operator.operatorID).attr(`.${operatorViewResultIconClass}/xlink:href`, icon);
  }

  public changeOperatorJointDisplayName(
    operator: OperatorPredicate,
    jointPaper: joint.dia.Paper,
    displayName: string
  ): void {
    // A native operator's box keeps saying what it computes, whatever its display name.
    const text = isNativeOperator(operator) ? nativeOperatorSummary(operator) : displayName;
    jointPaper
      .getModelById(operator.operatorID)
      .attr(`.${operatorNameClass}/text`, JointUIService.wrapOperatorDisplayName(text));
  }

  /**
   * Wrap the operator's description / custom display name so it fits inside the
   * fixed right-hand section of the operator box. JointJS renders the label as
   * plain SVG text with no intrinsic wrapping, so without this a long summary
   * like "Inner join customers+orders on customer_id; filter ..." would extend
   * indefinitely and overlap neighboring operators. The box has room for about
   * a hundred characters; anything longer is ellipsized rather than resizing
   * the box.
   */
  private static wrapOperatorDisplayName(text: string): string {
    return JointUIService.wrapText(text, JointUIService.DESC_FONT_SIZE, JointUIService.DESC_TEXT_HEIGHT, 1.2);
  }

  /**
   * `text` broken into lines as wide as the box's text section, as many as fit
   * in `height` at `fontSize` and `lineHeight` (in em, as drawn), the last
   * ellipsized when it does not all fit. `joint.util.breakText` measures in
   * the DOM; without one (unit tests) characters are counted instead.
   */
  private static wrapText(text: string, fontSize: number, height: number, lineHeight = 1.3): string {
    if (!text) return text;
    const width = JointUIService.DESC_TEXT_WIDTH;
    try {
      return joint.util.breakText(
        text,
        { width, height },
        { "font-size": `${fontSize}px`, lineHeight: `${lineHeight}em` },
        { ellipsis: true }
      );
    } catch {
      const approxCharsPerLine = Math.max(8, Math.floor(width / (fontSize / 2)));
      const maxLines = Math.max(1, Math.floor(height / (fontSize * lineHeight)));
      // Hard-break words longer than a line so a single long token can't escape the box.
      const words = text
        .split(/\s+/)
        .filter(w => w.length > 0)
        .flatMap(w => w.match(new RegExp(`.{1,${approxCharsPerLine}}`, "g")) ?? []);
      const lines: string[] = [];
      let line = "";
      let truncated = false;
      for (const w of words) {
        if (line.length > 0 && (line + " " + w).length > approxCharsPerLine) {
          if (lines.length >= maxLines - 1) {
            truncated = true;
            break;
          }
          lines.push(line);
          line = w;
        } else {
          line = line.length > 0 ? line + " " + w : w;
        }
      }
      if (line && lines.length < maxLines) lines.push(line);
      else if (line) truncated = true;
      if (truncated && lines.length > 0) {
        const last = lines[lines.length - 1];
        lines[lines.length - 1] =
          (last.length >= approxCharsPerLine ? last.slice(0, approxCharsPerLine - 1) : last) + "…";
      }
      return lines.join("\n");
    }
  }

  /**
   * Truncate a single-line label (the operator ID shown at the top of the box)
   * to the given pixel width, appending an ellipsis if it overflows. Operator
   * IDs (e.g. "Filter-operator-<uuid>") are long, so this keeps the label from
   * spilling far past the box edges while preserving the leading, identifying
   * portion.
   *
   * breakText wraps at spaces, so a long last word ("records: create_table")
   * would drop out whole and leave "records: …". With non-breaking spaces the
   * label is one word, which breakText cuts letter by letter instead; the
   * hyphen pattern matches nothing, so no cut lands early at punctuation.
   */
  private static truncateToWidth(text: string, width: number, fontSize: string): string {
    if (!text) return text;
    try {
      return joint.util
        .breakText(
          text.replace(/ /g, " "),
          { width },
          { "font-size": fontSize },
          { maxLineCount: 1, ellipsis: true, hyphen: "$^" }
        )
        .replace(/ /g, " ");
    } catch {
      // No DOM available (e.g. unit tests) — approximate by character count.
      const approxChars = Math.max(1, Math.floor(width / 6));
      return text.length > approxChars ? text.slice(0, approxChars - 1) + "…" : text;
    }
  }

  public getCommentElement(commentBox: CommentBox): joint.dia.Element {
    const basic = new joint.shapes.standard.Rectangle();
    if (commentBox.commentBoxPosition) basic.position(commentBox.commentBoxPosition.x, commentBox.commentBoxPosition.y);
    else basic.position(0, 0);
    basic.resize(120, 50);
    const commentElement = new TexeraCustomCommentElement({
      position: commentBox.commentBoxPosition || { x: 0, y: 0 },
      size: {
        width: JointUIService.DEFAULT_COMMENT_WIDTH,
        height: JointUIService.DEFAULT_COMMENT_HEIGHT,
      },
      attrs: JointUIService.getCustomCommentStyleAttrs(),
    });
    commentElement.set("id", commentBox.commentBoxID);
    return commentElement;
  }
  /**
   * This function converts a Texera source and target OperatorPort to
   *   a JointJS link cell <joint.dia.Link> that could be added to the JointJS.
   *
   * @param link
   * @returns JointJS Link Cell
   */
  public static getJointLinkCell(link: OperatorLink): joint.dia.Link {
    const jointLinkCell = JointUIService.getDefaultLinkCell();
    // The edge starts on the outer side of the output port and ends on the outer
    // side of the input port, wherever the two boxes are: not where the straight
    // line between the ports happens to cross them.
    jointLinkCell.set("source", {
      id: link.source.operatorID,
      port: link.source.portID,
      anchor: { name: "right" },
      connectionPoint: { name: "anchor" },
    });
    jointLinkCell.set("target", {
      id: link.target.operatorID,
      port: link.target.portID,
      anchor: { name: "left" },
      connectionPoint: { name: "anchor" },
    });
    jointLinkCell.set("id", link.linkID);
    jointLinkCell.set("z", 0);
    return jointLinkCell;
  }

  /**
   * This function will creates a custom JointJS link cell using
   *  custom attributes / styles to display the operator.
   *
   * This function defines the svg properties for each part of link, such as the
   *   shape of the arrow or the link. Other styles are defined in the
   *   "app/workspace/component/workflow-editor/workflow-editor.component.scss".
   *
   * The reason for separating styles in svg and css is that while we can
   *   change the shape of the operators in svg, according to JointJS official
   *   website, https://resources.jointjs.com/tutorial/element-styling ,
   *   CSS properties have higher precedence over SVG attributes.
   *
   * As a result, a separate css/scss file is required to override the default
   * style of the operatorLink.
   *
   * @returns JointJS Link
   */
  public static getDefaultLinkCell(): joint.dia.Link {
    return new joint.dia.Link({
      // A smooth curve from the output port to the input port, so a dataflow
      // reads left to right and the edges into a join fan in instead of
      // stacking as right-angled runs. It always leaves rightwards and arrives
      // from the left, so the arrowhead points into the input port even when
      // the box sits under or behind the one feeding it (the curve then loops
      // round). The connector's own "horizontal" direction picks the port side
      // the straight line between the ports meets, which turned such arrows
      // around; vectors, since this JointJS reads the "right" keyword as down.
      router: {
        name: "normal",
      },
      connector: {
        name: "curve",
        args: { sourceDirection: { x: 1, y: 0 }, targetDirection: { x: -1, y: 0 } },
      },
      toolMarkup: `<g class="link-tool">
          <g class="tool-remove" event="tool:remove">
          <circle r="11" />
            <path transform="scale(.8) translate(-16, -16)" d="M24.778,21.419 19.276,15.917 24.777
            10.415 21.949,7.585 16.447,13.087 10.945,7.585 8.117,10.415 13.618,15.917 8.116,21.419
            10.946,24.248 16.447,18.746 21.948,24.248z"/>
            <title>Remove link.</title>
           </g>
         </g>`,
      attrs: {
        ".connection": {
          stroke: linkPathStrokeColor,
          "stroke-width": "2px",
          "stroke-linecap": "round",
        },
        ".connection-wrap": {
          "stroke-width": "0px",
          // 'display': 'inline'
        },
        // No handle at the source: the edge simply leaves the output port.
        ".marker-source": {
          d: sourceOperatorHandle,
          stroke: "none",
          fill: linkPathStrokeColor,
          display: "none",
        },
        ".marker-arrowhead-group-source .marker-arrowhead": {
          d: sourceOperatorHandle,
        },
        ".marker-target": {
          d: targetOperatorHandle,
          stroke: "none",
          fill: linkPathStrokeColor,
        },
        ".marker-arrowhead-group-target .marker-arrowhead": {
          d: targetOperatorHandle,
        },
        ".tool-remove": {
          fill: "#D8656A",
          width: 24,
          display: "none",
        },
        ".tool-remove path": {
          d: deleteButtonPath,
        },
        ".tool-remove circle": {},
      },
    });
  }

  /**
   * This function changes the default svg of the operator ports.
   * It hides the port label that will display 'out/in' beside the operators.
   *
   * @returns the custom attributes of the ports
   */
  public static getCustomPortStyleAttrs(): joint.attributes.SVGAttributes {
    return {
      ".port-body": {
        fill: "#A0A0A0",
        r: 5,
        stroke: "none",
      },
      ".port-label": {
        // Hide the port name by default (e.g. "input-0", "output-1"). The label
        // carries a tuple count once an operator ran (changeOperatorStatistics,
        // setOperatorSnapshotResult flip it to visible), and even then the
        // canvas shows it only on the selected operators and their upstream:
        // the workflow editor's styles hide it on every other operator.
        visibility: "hidden",
        event: "input-label:evt",
        dblclick: "input-label:dbclick",
        pointerdblclick: "input-label:pointerdblclick",
        ref: ".port-body",
        "ref-y": 0.5,
        "y-alignment": "middle",
      },
    };
  }

  /**
   * This function creates a custom svg style for the operator.
   * This function also makes the delete button defined above to emit the delete event that will
   *   be captured by JointJS paper using event name *element:delete*
   *
   * @param operator
   * @param operatorDisplayName the name of the operator that will display on the UI
   * @param operatorType
   * @param operatorFriendlyName
   * @returns the custom attributes of the operator
   */
  public static getCustomOperatorStyleAttrs(
    operator: OperatorPredicate,
    operatorDisplayName: string,
    operatorType: string,
    operatorFriendlyName: string
  ): joint.shapes.devs.ModelSelectors {
    // A scan's box names the file it reads, with its doc as a second line,
    // and its icon section draws a document glyph tagged with the file's kind.
    const scan = isNativeOperator(operator) && operator.nativeOp.type === "Scan" ? operator.nativeOp : undefined;
    const nameText = (scan && nativeScanFileLabel(scan)) || operatorDisplayName;
    const subtitle = scan ? scan.doc?.trim() ?? "" : "";
    const fileKind = scan ? nativeScanFileKind(scan).slice(0, 4) : "";
    const H = JointUIService.DEFAULT_OPERATOR_HEIGHT;
    // A scan's text block: its file name (two lines at most) over its doc (two lines at most), centred.
    const fileName = scan
      ? JointUIService.wrapFileName(nameText, JointUIService.DESC_TEXT_WIDTH, JointUIService.FILE_FONT_SIZE)
      : "";
    const scanDoc = subtitle
      ? JointUIService.wrapText(subtitle, JointUIService.SCAN_DOC_FONT_SIZE, JointUIService.SCAN_DOC_FONT_SIZE * 2.6)
      : "";
    const fileLines = fileName ? fileName.split("\n").length : 0;
    const docLines = scanDoc ? scanDoc.split("\n").length : 0;
    const fileLineHeight = JointUIService.FILE_FONT_SIZE * 1.25;
    const docLineHeight = JointUIService.SCAN_DOC_FONT_SIZE * 1.3;
    const scanBlock = fileLines * fileLineHeight + (docLines ? 5 + docLines * docLineHeight : 0);
    const scanTop = (H - scanBlock) / 2;
    // The label over the box: the operator's id, then its type. A native operator's shows in full; an
    // engine operator's id is a long generated one and is cut short of the buttons.
    const typeName = isNativeOperator(operator) ? nativeOperatorTypeName(operator.nativeOp) : operatorType;
    const label = isNativeOperator(operator)
      ? `${operator.operatorID}: ${typeName}`
      : JointUIService.truncateToWidth(
          `${operator.operatorID}: ${typeName}`,
          JointUIService.DEFAULT_OPERATOR_WIDTH - JointUIService.BUTTON_ROW_WIDTH,
          `${JointUIService.ID_FONT_SIZE}px`
        );
    return {
      ".texera-operator-coeditor-editing": {
        text: "",
        "font-size": "14px",
        "font-weight": "bold",
        visibility: "hidden",
        "ref-x": -50,
        "ref-y": 100,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "start",
      },
      ".texera-operator-coeditor-changed-property": {
        text: "",
        "font-weight": "bold",
        "font-size": "14px",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": 120,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-agent-action-progress": {
        text: "",
        "font-size": `${JointUIService.AGENT_ACTION_FONT_SIZE}px`,
        "font-weight": "bold",
        "font-family": "'Inter', 'SF Pro Display', -apple-system, sans-serif",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": H + 15,
        ref: "rect.body",
        "text-anchor": "middle",
        "x-alignment": "middle",
        "y-alignment": "middle",
      },
      ".texera-operator-state": {
        text: "",
        "font-size": "14px",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": 100,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-abbreviated-count": {
        text: "",
        fill: "green",
        "font-size": "14px",
        visibility: "visible",
        "ref-x": 0.5,
        "ref-y": -30,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-port-metrics": {
        text: "",
        fill: "green",
        "font-size": "14px",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": -70,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-processed-count": {
        text: "",
        fill: "green",
        "font-size": "14px",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": -50,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-output-count": {
        text: "",
        fill: "green",
        "font-size": "14px",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": -30,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      "rect.body": {
        fill: JointUIService.getOperatorFillColor(operator),
        "follow-scale": true,
        stroke: operatorBorderColor,
        "stroke-width": "1.5",
        rx: `${JointUIService.BOX_RADIUS}px`,
        ry: `${JointUIService.BOX_RADIUS}px`,
        filter: { name: "dropShadow", args: { dx: 0, dy: 1, blur: 2.5, opacity: 0.14 } },
      },
      // The tinted section behind the icon, inset by half the border so the
      // border keeps its full weight on the left.
      [`.${operatorIconSectionClass}`]: {
        d: JointUIService.iconSectionPath(),
        fill: "#F3F5F8",
        stroke: "none",
      },
      "rect.boundary": {
        fill: "rgba(0, 0, 0, 0)",
        // Stroked only while an agent action label is showing, see
        // `showAgentActionLabel`.
        stroke: "none",
        "stroke-width": 0,
        width: this.DEFAULT_OPERATOR_WIDTH + 20,
        height: this.DEFAULT_OPERATOR_HEIGHT + 20,
        ref: "rect.body",
        "ref-x": -10,
        "ref-y": -10,
      },
      "path.right-boundary": {
        ref: "rect.body",
        d: `M 20 ${H} C 0 ${H * 0.75} 0 ${H * 0.25} 20 0`,
        stroke: "rgba(0,0,0,0)",
        "stroke-width": "10",
        fill: "transparent",
        "ref-x": this.DEFAULT_OPERATOR_WIDTH + 10,
        "ref-y": 0,
      },
      "path.left-boundary": {
        ref: "rect.body",
        d: `M 0 ${H} C 20 ${H * 0.75} 20 ${H * 0.25} 0 0`,
        stroke: "rgba(0,0,0,0)",
        "stroke-width": "10",
        fill: "transparent",
        "ref-x": -30,
        "ref-y": 0,
      },
      // Description / custom display name, rendered inside the right section of
      // the box (to the right of the divider), left-aligned and vertically
      // centred. Wrapping + ellipsis keep it within the fixed box. A scan's is
      // its file name, in bold, over its doc.
      ".texera-operator-name": scan
        ? {
            text: fileName,
            fill: "#262626",
            "font-size": `${JointUIService.FILE_FONT_SIZE}px`,
            "font-weight": 600,
            lineHeight: "1.25em",
            ref: "rect.body",
            "ref-x": JointUIService.ICON_SECTION_WIDTH + JointUIService.TEXT_SECTION_PADDING,
            "ref-y": scanTop,
            "text-anchor": "start",
            textVerticalAnchor: "top",
          }
        : {
            text: JointUIService.wrapOperatorDisplayName(nameText),
            fill: "#262626",
            "font-size": `${JointUIService.DESC_FONT_SIZE}px`,
            "font-weight": 400,
            lineHeight: "1.2em",
            ref: "rect.body",
            "ref-x": JointUIService.ICON_SECTION_WIDTH + JointUIService.TEXT_SECTION_PADDING,
            "ref-y": 0.5,
            "text-anchor": "start",
            textVerticalAnchor: "middle",
          },
      // A scan's doc, under its file name.
      [`.${operatorSubtitleClass}`]: {
        text: scanDoc,
        fill: "#8c8c8c",
        "font-size": `${JointUIService.SCAN_DOC_FONT_SIZE}px`,
        lineHeight: "1.3em",
        display: scanDoc ? "inline" : "none",
        ref: "rect.body",
        "ref-x": JointUIService.ICON_SECTION_WIDTH + JointUIService.TEXT_SECTION_PADDING,
        "ref-y": scanTop + fileLines * fileLineHeight + 5,
        "text-anchor": "start",
        textVerticalAnchor: "top",
      },
      // Operator id + type, just above the box ("listings: Scan"): the id is
      // what the agent's chat calls it, the type what the box is. The id is
      // the darker part.
      ".texera-operator-friendly-name": {
        text: label,
        annotations: [{ start: 0, end: operator.operatorID.length, attrs: { fill: "#434343", "font-weight": 600 } }],
        fill: "#8c8c8c",
        "font-size": `${JointUIService.ID_FONT_SIZE}px`,
        "ref-x": 2,
        "ref-y": -12,
        ref: "rect.body",
        "text-anchor": "start",
        "y-alignment": "middle",
        "x-alignment": "left",
      },
      // Vertical hairline where the tinted icon section meets the text.
      [`.${operatorSectionDividerClass}`]: {
        ref: "rect.body",
        "ref-x": JointUIService.ICON_SECTION_WIDTH,
        "ref-y": 1,
        width: 1,
        height: JointUIService.DEFAULT_OPERATOR_HEIGHT - 2,
        fill: "#E4E8EE",
        stroke: "none",
      },
      [`.${operatorWorkerCountClass}`]: {
        "ref-x": -5,
        "ref-y": -35,
      },
      // Top-row buttons, right to left: delete pinned hardest into the corner
      // (overhanging the body a little, like a badge), the agent-chat button
      // tight against it with a 4px gap. Both clear the id label above the box.
      // A native operator has neither: a click opens its panel (Feedback included), and its
      // agent owns its edits; its full id and type take the strip over the box instead.
      ".delete-button": {
        x: this.DEFAULT_OPERATOR_WIDTH - 16,
        y: -26,
        cursor: "pointer",
        fill: "#D8656A",
        event: "element:delete",
        visibility: "hidden",
        display: isNativeOperator(operator) ? "none" : "inline",
      },
      ".chat-button": {
        x: this.DEFAULT_OPERATOR_WIDTH - 40,
        y: -24,
        cursor: "pointer",
        fill: "#1890ff",
        event: "element:chat",
        visibility: "hidden",
        display: isNativeOperator(operator) ? "none" : "inline",
      },
      ".texera-operator-icon": {
        "xlink:href": isNativeOperator(operator)
          ? nativeOperatorIcon(operator.nativeOp)
          : "assets/operator_images/" + operatorType + ".png",
        width: 40,
        height: 40,
        // Centre the icon within the left section (0 .. ICON_SECTION_WIDTH).
        "ref-x": JointUIService.ICON_SECTION_WIDTH / 2,
        "ref-y": 0.5,
        ref: "rect.body",
        "x-alignment": "middle",
        "y-alignment": "middle",
        // A scan shows its file glyph instead.
        display: scan ? "none" : "inline",
      },
      // The file glyph: a sheet with a folded corner, 22×28, centred in the
      // icon section, with the kind of file written on it.
      [`.${operatorFileGlyphClass}`]: {
        d: `M 13 ${H / 2 - 14} H 28 L 35 ${H / 2 - 7} V ${H / 2 + 14} H 13 Z M 28 ${H / 2 - 14} V ${H / 2 - 7} H 35`,
        fill: "#ffffff",
        stroke: "#4B5B6E",
        "stroke-width": 1.4,
        "stroke-linejoin": "round",
        display: scan ? "inline" : "none",
      },
      [`.${operatorFileKindClass}`]: {
        text: fileKind,
        x: 24,
        y: H / 2 + 8.5,
        fill: "#2F5FA8",
        "font-size": fileKind.length > 3 ? "6px" : "7px",
        "font-weight": 700,
        "letter-spacing": "0.3px",
        "text-anchor": "middle",
        display: scan ? "inline" : "none",
      },
      ".texera-operator-result-reuse-text": {
        text: JointUIService.getOperatorCacheDisplayText(operator) === "" ? "" : "cache",
        fill: "#595959",
        "font-size": "12px",
        visible: true,
        "ref-x": this.DEFAULT_OPERATOR_WIDTH + 20,
        "ref-y": this.DEFAULT_OPERATOR_HEIGHT - 24,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-result-reuse-icon": {
        "xlink:href": JointUIService.getOperatorCacheIcon(operator),
        width: 36,
        height: 36,
        "ref-x": this.DEFAULT_OPERATOR_WIDTH + 4,
        "ref-y": this.DEFAULT_OPERATOR_HEIGHT - 36,
        ref: "rect.body",
        "x-alignment": "middle",
        "y-alignment": "middle",
      },
      // Hidden until the operator has a status (setOperatorStatusBadge).
      [`.${operatorStatusClass}`]: { display: "none" },
      ".texera-operator-view-result-icon": {
        "xlink:href": JointUIService.getOperatorViewResultIcon(operator),
        width: 20,
        height: 20,
        "ref-x": this.DEFAULT_OPERATOR_WIDTH - 14,
        "ref-y": 12,
        ref: "rect.body",
        "x-alignment": "middle",
        "y-alignment": "middle",
      },
    };
  }

  public static getOperatorFillColor(operator: OperatorPredicate): string {
    const isDisabled = operator.isDisabled ?? false;
    return isDisabled ? "#E0E0E0" : "#FFFFFF";
  }

  public static getOperatorCacheDisplayText(
    operator: OperatorPredicate,
    cacheStatus?: OperatorResultCacheStatus
  ): string {
    if (cacheStatus === undefined || !operator.markedForReuse) {
      return "";
    }
    return cacheStatus;
  }

  public static getOperatorCacheIcon(operator: OperatorPredicate, cacheStatus?: OperatorResultCacheStatus): string {
    if (!operator.markedForReuse) {
      return "";
    }
    if (cacheStatus === "cache valid") {
      return "assets/svg/operator-reuse-cache-valid.svg";
    } else {
      return "assets/svg/operator-reuse-cache-invalid.svg";
    }
  }

  public static getOperatorViewResultIcon(operator: OperatorPredicate): string {
    if (operator.viewResult) {
      return "assets/svg/operator-view-result.svg";
    } else {
      return "";
    }
  }

  public static getCustomCommentStyleAttrs(): joint.shapes.devs.ModelSelectors {
    return {
      rect: {
        fill: "#F2F4F5",
        "follow-scale": true,
        stroke: "#CED4D9",
        "stroke-width": "0",
        rx: "5px",
        ry: "5px",
      },
      image: {
        "xlink:href": "assets/operator_images/icons8-chat_bubble.png",
        width: 32,
        height: 32,
        "ref-x": 0.5,
        "ref-y": 0.5,
        ref: "rect",
        "x-alignment": "middle",
        "y-alignment": "middle",
      },
      ".delete-button": {
        x: 22,
        y: -16,
        cursor: "pointer",
        fill: "#D8656A",
        event: "element:delete",
      },
    };
  }

  public static getJointUserPointerCell(coeditor: Coeditor, position: Point, color: string): joint.dia.Element {
    const userCursor = new joint.shapes.standard.Circle({
      id: this.getJointUserPointerName(coeditor),
    });
    userCursor.resize(15, 15);
    userCursor.position(position.x, position.y);
    userCursor.attr("body/fill", color);
    userCursor.attr("body/stroke", color);
    userCursor.attr("text", {
      text: coeditor.name,
      "ref-x": 15,
      "ref-y": 20,
      stroke: coeditor.color,
    });
    return userCursor;
  }

  public static getJointUserPointerName(coeditor: Coeditor) {
    return "pointer_" + coeditor.clientId;
  }

  /**
   * Shows agent action labels (viewed/added/modified) on operators.
   * Displays bold agent name and action type as text below the operator, and
   * rings the operator in the matching colour — the label alone is small text
   * under a 210x80 box and is easy to miss on a busy canvas. `viewed` uses a
   * dashed ring so a read is visually weaker than a write.
   */
  public showAgentActionLabel(
    jointPaper: joint.dia.Paper,
    operatorID: string,
    actionType: "viewed" | "added" | "modified",
    agentName: string = "Bob"
  ): void {
    const element = jointPaper.getModelById(operatorID);
    if (!element) {
      return;
    }

    const labelText = `${agentName}: ${actionType}`;
    const color = JointUIService.AGENT_ACTION_COLORS[actionType];

    element.attr({
      [`.${operatorAgentActionProgressClass}`]: {
        text: labelText,
        fill: color,
        "font-size": `${JointUIService.AGENT_ACTION_FONT_SIZE}px`,
        "font-weight": "bold",
        visibility: "visible",
      },
      // `rect.boundary` is the transparent 10px-margin rect around the body;
      // nothing else styles it, so it doubles as the highlight ring without
      // fighting the validity colouring on `rect.body`.
      "rect.boundary": {
        stroke: color,
        "stroke-width": 3,
        "stroke-dasharray": actionType === "viewed" ? "6,5" : "none",
        rx: 12,
        ry: 12,
      },
    });
  }

  /**
   * Hides agent action labels on operators, and removes the highlight ring.
   */
  public hideAgentActionLabel(jointPaper: joint.dia.Paper, operatorID: string): void {
    const element = jointPaper.getModelById(operatorID);
    if (!element) {
      return;
    }

    element.attr({
      [`.${operatorAgentActionProgressClass}`]: {
        text: "",
        visibility: "hidden",
      },
      "rect.boundary": {
        stroke: "none",
        "stroke-width": 0,
        "stroke-dasharray": "none",
      },
    });
  }
}

export function fromJointPaperEvent<T extends keyof joint.dia.Paper.EventMap = keyof joint.dia.Paper.EventMap>(
  paper: joint.dia.Paper,
  eventName: T,
  context?: any
): Observable<Parameters<joint.dia.Paper.EventMap[T]>> {
  return fromEventPattern(
    handler => paper.on(eventName, handler, context), // addHandler
    (handler, signal) => paper.off(eventName as string, handler, context) // removeHandler
  );
}
