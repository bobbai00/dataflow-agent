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
import { HttpErrorResponse } from "@angular/common/http";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { NoopAnimationsModule } from "@angular/platform-browser/animations";
import { of, throwError } from "rxjs";
import { NativeOperatorEditorComponent } from "./native-operator-editor.component";
import { AgentService } from "../../../service/agent/agent.service";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import { NativeStatementForm } from "../../../service/agent/native-operator";
import { commonTestProviders } from "../../../../common/testing/test-utils";

const filterForm: NativeStatementForm = {
  id: "kept",
  op: "filter",
  inputs: ["records"],
  positional: [{ source: "lambda row: row['value'] > 15", kind: "lambda" }],
  keywords: [],
  doc: "Keep the records over 15.",
  statement: "set kept: filter(records, lambda row: row['value'] > 15, doc='Keep the records over 15.')",
};
const loaderForm: NativeStatementForm = {
  id: "records",
  op: "make_table",
  inputs: [],
  positional: [],
  keywords: [
    { name: "n", source: "3", kind: "number", value: 3 },
    { name: "columns", source: "['value']", kind: "strings", value: ["value"] },
  ],
  statement: "set records: make_table(n=3, columns=['value'])",
  definition: {
    name: "make_table",
    signature: "(*, n=3, columns=None)",
    source: "def make_table(*, n=3, columns=None):\n    ...",
  },
};

describe("NativeOperatorEditorComponent", () => {
  let fixture: ComponentFixture<NativeOperatorEditorComponent>;
  let component: NativeOperatorEditorComponent;
  let agentService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    agentService = {
      getNativeStatementForm: vi.fn().mockReturnValue(of(filterForm)),
      editNativeOperator: vi.fn().mockReturnValue(of({ status: "ok" })),
      getNativeCatalog: vi
        .fn()
        .mockReturnValue(
          of([{ name: "filter", type: "Filter", signature: "filter(T, lambda row: ...)", doc: "Keeps rows." }])
        ),
      getOperatorResultSummaries: vi
        .fn()
        .mockReturnValue(new Map([["records", { sampleRecords: [{ __row_index__: 0, id: 1, value: 10 }] }]])),
    };
    await TestBed.configureTestingModule({
      imports: [NativeOperatorEditorComponent, HttpClientTestingModule, NoopAnimationsModule],
      providers: [
        { provide: AgentService, useValue: agentService },
        {
          provide: WorkflowActionService,
          useValue: {
            getTexeraGraph: () => ({
              getAllOperators: () => [
                { operatorID: "records", nativeOp: { type: "Process" } },
                { operatorID: "kept", nativeOp: { type: "Filter" } },
                { operatorID: "csv", operatorType: "CSVFileScan" },
              ],
            }),
          },
        },
        ...commonTestProviders,
      ],
    }).compileComponents();
  });

  function create(form = filterForm): HTMLElement {
    agentService.getNativeStatementForm.mockReturnValue(of(form));
    fixture = TestBed.createComponent(NativeOperatorEditorComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput("agentId", "a1");
    fixture.componentRef.setInput("operatorId", form.id);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  const labels = (element: HTMLElement) =>
    Array.from(element.querySelectorAll(".field-label")).map(label => label.textContent?.replace(/\s+/g, " ").trim());

  it("shows one field per argument, the description and the statement they spell", () => {
    const element = create();
    expect(agentService.getNativeStatementForm).toHaveBeenCalledWith("a1", "kept");
    expect(labels(element)).toEqual(["Input", "Condition", "Description"]);
    expect(component.inputs).toEqual(["records"]);
    // Other native operators can be inputs; the operator itself and engine operators cannot.
    expect(component.inputOptions).toEqual(["records"]);
    expect(element.querySelector(".preview-code")?.textContent).toBe(filterForm.statement);
    expect(element.querySelector(".about summary")?.textContent?.trim()).toBe("About filter");
    // Nothing to save until something changes.
    expect((element.querySelector(".save-edit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the statement the edited fields spell", () => {
    const element = create();
    const saved = vi.fn();
    component.saved.subscribe(saved);
    component.positional[0].source = "lambda row: row['value'] > 25";
    component.doc = "Keep the records over 25.";
    fixture.detectChanges();
    const statement = "set kept: filter(records, lambda row: row['value'] > 25, doc='Keep the records over 25.')";
    expect(element.querySelector(".preview-code")?.textContent).toBe(statement);

    (element.querySelector(".save-edit") as HTMLButtonElement).click();
    expect(agentService.editNativeOperator).toHaveBeenCalledWith("a1", "kept", { statement });
    expect(saved).toHaveBeenCalledWith({ status: "ok" });

    (element.querySelector(".save-run-edit") as HTMLButtonElement).click();
    expect(agentService.editNativeOperator).toHaveBeenLastCalledWith("a1", "kept", { statement, run: true });
  });

  it("edits literal settings with typed controls and sends a changed Python definition", () => {
    const element = create(loaderForm);
    expect(labels(element)).toEqual(["N", "Columns", "Description", "Python make_table(*, n=3, columns=None)"]);
    expect(element.querySelector("nz-input-number")).not.toBeNull();
    // Column lists suggest the input results' columns; this loader has no inputs.
    expect(component.columnOptions).toEqual([]);
    component.keywords[0].value = 5;
    component.keywords[1].value = ["value", "id"];
    expect(component.statement).toBe("set records: make_table(n=5, columns=['value', 'id'])");

    component.save(false);
    expect(agentService.editNativeOperator).toHaveBeenLastCalledWith("a1", "records", {
      statement: "set records: make_table(n=5, columns=['value', 'id'])",
    });
    component.definition = "def make_table(*, n=3, columns=None):\n    return None";
    component.save(false);
    expect(agentService.editNativeOperator).toHaveBeenLastCalledWith("a1", "records", {
      statement: "set records: make_table(n=5, columns=['value', 'id'])",
      python: "def make_table(*, n=3, columns=None):\n    return None",
    });
  });

  it("suggests the input's columns for column lists", () => {
    create({
      ...filterForm,
      op: "aggregate",
      positional: [],
      keywords: [{ name: "by", source: "[]", kind: "strings", value: [] }],
    });
    expect(component.columnOptions).toEqual(["id", "value"]);
  });

  it("adds a setting the statement did not have", () => {
    create();
    component.addSetting();
    component.keywords[0].name = "settings";
    component.keywords[0].source = "{'limit': 3}";
    expect(component.statement).toBe(
      "set kept: filter(records, lambda row: row['value'] > 15, settings={'limit': 3}, doc='Keep the records over 15.')"
    );
    component.removeSetting(0);
    expect(component.statement).toBe(filterForm.statement);
  });

  it("edits the statement as code, and keeps code edits until saved or cancelled", () => {
    const element = create();
    (element.querySelector(".code-toggle") as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.codeMode).toBe(true);
    expect(component.statementText).toBe(filterForm.statement);
    component.statementText = "set kept: filter(records, lambda row: True)";
    fixture.detectChanges();
    expect(component.codeEdited).toBe(true);
    expect((element.querySelector(".code-toggle") as HTMLButtonElement).disabled).toBe(true);
    component.save(false);
    expect(agentService.editNativeOperator).toHaveBeenCalledWith("a1", "kept", {
      statement: "set kept: filter(records, lambda row: True)",
    });
  });

  it("points out a description left over from the earlier definition", () => {
    const element = create();
    expect(element.querySelector(".field-warning")).toBeNull();
    component.positional[0].source = "lambda row: row['value'] > 25";
    fixture.detectChanges();
    expect(element.querySelector(".field-warning")?.textContent?.trim()).toBe(
      "This still describes the earlier definition. Update it, or the agent will."
    );
    component.doc = "Keep the records over 25.";
    fixture.detectChanges();
    expect(element.querySelector(".field-warning")).toBeNull();
  });

  it("shows why the agent rejected an edit, and why the form could not load", () => {
    agentService.editNativeOperator.mockReturnValue(
      throwError(
        () => new HttpErrorResponse({ status: 400, error: { error: "Changes line 1, operator kept: invalid syntax" } })
      )
    );
    const element = create();
    component.positional[0].source = "lambda row: row['value'] >";
    component.save(false);
    fixture.detectChanges();
    expect(element.querySelector(".editor-error")?.textContent?.trim()).toBe(
      "Changes line 1, operator kept: invalid syntax"
    );
    expect(component.saving).toBeNull();

    agentService.getNativeStatementForm.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 404, error: { error: "There is no native operator `x`." } }))
    );
    fixture.componentRef.setInput("operatorId", "x");
    fixture.detectChanges();
    expect(element.querySelector(".editor-error")?.textContent?.trim()).toBe("There is no native operator `x`.");
  });
});
