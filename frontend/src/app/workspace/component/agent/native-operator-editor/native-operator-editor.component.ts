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

import { ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from "@angular/core";
import { HttpErrorResponse } from "@angular/common/http";
import { NgFor, NgIf, NgSwitch, NgSwitchCase, NgSwitchDefault } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { UntilDestroy, untilDestroyed } from "@ngneat/until-destroy";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzAutosizeDirective, NzInputDirective } from "ng-zorro-antd/input";
import { NzInputNumberComponent } from "ng-zorro-antd/input-number";
import { NzOptionComponent, NzSelectComponent } from "ng-zorro-antd/select";
import { NzSpinComponent } from "ng-zorro-antd/spin";
import { NzSwitchComponent } from "ng-zorro-antd/switch";
import { NzTooltipDirective } from "ng-zorro-antd/tooltip";
import { AgentService, UserActionResponse } from "../../../service/agent/agent.service";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import {
  assembleNativeStatement,
  isNativeOperator,
  NativeCatalogEntry,
  nativeArgumentLabel,
  nativeFieldSource,
  nativePositionalLabel,
  NativeStatementField,
  NativeStatementForm,
} from "../../../service/agent/native-operator";

/** One keyword argument in the form. A setting the user added has no `original`. */
export interface NativeKeywordField extends NativeStatementField {
  name: string;
  label: string;
  original?: NativeStatementField;
}

/** The reason a request failed, as the agent-service gave it. */
export function agentErrorText(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return error instanceof Error ? error.message : String(error);
  const body = error.error as { error?: string } | string | null;
  return (typeof body === "object" && body?.error) || (typeof body === "string" && body) || error.message;
}

/**
 * Edits a native operator the way the agent defines it: one field per argument
 * of its `set` statement, its description, and for an operator that calls a
 * registered function, that function's Python. "Edit as code" edits the
 * statement itself. Saving sends the statement to the agent, which applies it
 * like one of its own and reads it, as the user's change, on its next turn.
 */
@UntilDestroy()
@Component({
  selector: "texera-native-operator-editor",
  templateUrl: "./native-operator-editor.component.html",
  styleUrls: ["./native-operator-editor.component.scss"],
  imports: [
    NgIf,
    NgFor,
    NgSwitch,
    NgSwitchCase,
    NgSwitchDefault,
    FormsModule,
    NzButtonComponent,
    NzWaveDirective,
    ɵNzTransitionPatchDirective,
    NzIconDirective,
    NzInputDirective,
    NzAutosizeDirective,
    NzInputNumberComponent,
    NzSelectComponent,
    NzOptionComponent,
    NzSpinComponent,
    NzSwitchComponent,
    NzTooltipDirective,
  ],
})
export class NativeOperatorEditorComponent implements OnChanges {
  @Input() agentId!: string;
  @Input() operatorId!: string;
  /** The agent is busy; saving waits until it is available. */
  @Input() disabled = false;
  @Output() saved = new EventEmitter<UserActionResponse>();
  @Output() cancelled = new EventEmitter<void>();

  public form?: NativeStatementForm;
  public loadError?: string;
  public inputs: string[] = [];
  public positional: Array<{ label: string; source: string }> = [];
  public keywords: NativeKeywordField[] = [];
  public doc = "";
  /** The registered function's Python, when the statement calls one. */
  public definition = "";
  public codeMode = false;
  public statementText = "";
  /** The statement as it was when the code view opened. */
  private codeStart = "";
  public saving: "save" | "run" | null = null;
  public error?: string;
  /** Other native operators, for the inputs. */
  public inputOptions: string[] = [];
  /** Columns of the inputs' results, suggested for column lists. */
  public columnOptions: string[] = [];
  public about?: NativeCatalogEntry;

  constructor(
    private agentService: AgentService,
    private workflowActionService: WorkflowActionService,
    private changeDetectorRef: ChangeDetectorRef
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["agentId"] || changes["operatorId"]) this.load();
  }

  private load(): void {
    this.form = undefined;
    this.loadError = undefined;
    this.error = undefined;
    if (!this.agentId || !this.operatorId) return;
    this.agentService
      .getNativeStatementForm(this.agentId, this.operatorId)
      .pipe(untilDestroyed(this))
      .subscribe({
        next: form => {
          this.fill(form);
          this.changeDetectorRef.detectChanges();
        },
        error: (error: unknown) => {
          this.loadError = agentErrorText(error);
          this.changeDetectorRef.detectChanges();
        },
      });
  }

  private fill(form: NativeStatementForm): void {
    this.form = form;
    this.inputs = [...form.inputs];
    this.positional = form.positional.map((field, index) => ({
      label: nativePositionalLabel(form.op, index),
      source: field.source,
    }));
    this.keywords = form.keywords.map(keyword => ({
      ...keyword,
      value: Array.isArray(keyword.value) ? [...keyword.value] : keyword.value,
      label: nativeArgumentLabel(form.op, keyword.name),
      original: { ...keyword },
    }));
    this.doc = form.doc ?? "";
    this.definition = form.definition?.source ?? "";
    this.codeMode = false;
    this.statementText = form.statement;
    const graph = this.workflowActionService.getTexeraGraph();
    this.inputOptions = graph
      .getAllOperators()
      .filter(operator => isNativeOperator(operator) && operator.operatorID !== form.id)
      .map(operator => operator.operatorID);
    const summaries = this.agentService.getOperatorResultSummaries();
    this.columnOptions = [
      ...new Set(
        form.inputs.flatMap(input =>
          Object.keys(summaries.get(input)?.sampleRecords?.[0] ?? {}).filter(column => !column.includes("row_index"))
        )
      ),
    ];
    this.agentService
      .getNativeCatalog()
      .pipe(untilDestroyed(this))
      .subscribe(catalog => {
        this.about = catalog.find(entry => entry.name === form.op);
        this.changeDetectorRef.detectChanges();
      });
  }

  /** The statement the form spells, or the code view's text. */
  public get statement(): string {
    if (!this.form) return "";
    if (this.codeMode) return this.statementText.trim();
    return assembleNativeStatement({
      id: this.form.id,
      op: this.form.op,
      inputs: this.inputs,
      positional: this.positional.map(item => item.source),
      keywords: this.keywords.map(keyword => ({
        name: keyword.name,
        source: nativeFieldSource(keyword, keyword.original),
      })),
      doc: this.doc,
    });
  }

  public get definitionChanged(): boolean {
    return !!this.form?.definition && this.definition.trim() !== this.form.definition.source.trim();
  }

  /** Anything to save: the statement or the function differs from what was loaded. */
  public get changed(): boolean {
    return !!this.form && (this.statement !== this.form.statement.trim() || this.definitionChanged);
  }

  /** The code view's edits are only in the code; the form cannot show them. */
  public get codeEdited(): boolean {
    return this.codeMode && this.statementText.trim() !== this.codeStart;
  }

  /** Show the keyword beside its label only when the label renames it (`by` as "Group by"). */
  public showsKeyword(keyword: NativeKeywordField): boolean {
    return keyword.label.toLowerCase().replace(/ /g, "_") !== keyword.name.toLowerCase();
  }

  public addSetting(): void {
    this.keywords.push({ name: "", label: "", kind: "code", source: "" });
  }

  public removeSetting(index: number): void {
    this.keywords.splice(index, 1);
  }

  public toggleCode(): void {
    if (this.codeEdited) return;
    if (!this.codeMode) {
      this.statementText = this.statement;
      this.codeStart = this.statementText.trim();
    }
    this.codeMode = !this.codeMode;
  }

  public save(run: boolean): void {
    if (!this.form || this.saving || this.disabled) return;
    this.saving = run ? "run" : "save";
    this.error = undefined;
    this.agentService
      .editNativeOperator(this.agentId, this.operatorId, {
        statement: this.statement,
        ...(this.definitionChanged ? { python: this.definition } : {}),
        ...(run ? { run: true } : {}),
      })
      .pipe(untilDestroyed(this))
      .subscribe({
        next: response => {
          this.saving = null;
          this.saved.emit(response);
          this.changeDetectorRef.detectChanges();
        },
        error: (error: unknown) => {
          this.saving = null;
          this.error = agentErrorText(error);
          this.changeDetectorRef.detectChanges();
        },
      });
  }

  public trackByIndex(index: number): number {
    return index;
  }
}
