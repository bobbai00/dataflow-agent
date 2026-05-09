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

import type {
  CommentBox,
  OperatorLink,
  OperatorPredicate,
  Point,
  PortDescription,
  WorkflowContent,
} from "../../src/types/workflow";

/**
 * Code Mode workflow generators.
 *
 * Operators yield/return pandas DataFrames so `dynamicOutputSchema=true` can
 * infer the output schema from the first DataFrame the operator emits. The
 * orchestrator passes in the absolute path to the E2E data folder so the
 * source operators load `Iris.csv` / `TMDb_updated.csv` directly off disk.
 *
 * Shapes covered:
 *   1. chain  — single source → filter → enrich
 *   2. dag    — single source fans out into two independent branches
 *   3. 3-input — three sources merged through a 3-input UDF
 *   4. 4-input — four sources fan in to a 4-input UDF aggregator
 */

interface CodeWorkflowSpec {
  name: string;
  description: string;
  build: (dataDir: string) => WorkflowContent;
}

const DEFAULT_SETTINGS = { dataTransferBatchSize: 400 };

function pos(x: number, y: number): Point {
  return { x, y };
}

function inputPort(idx: number, isDynamic = false): PortDescription {
  return {
    portID: `input-${idx}`,
    displayName: "",
    disallowMultiInputs: true,
    isDynamicPort: isDynamic,
    dependencies: [],
  };
}

function outputPort(idx: number): PortDescription {
  return {
    portID: `output-${idx}`,
    displayName: "",
    disallowMultiInputs: false,
    isDynamicPort: false,
  };
}

interface OpInit {
  type: string;
  id: string;
  displayName?: string;
  properties: Record<string, any>;
  numInputs: number;
  numOutputs: number;
  viewResult?: boolean;
}

function buildOperator(init: OpInit): OperatorPredicate {
  const inputPorts: PortDescription[] = [];
  for (let i = 0; i < init.numInputs; i++) inputPorts.push(inputPort(i, i > 0));
  const outputPorts: PortDescription[] = [];
  for (let i = 0; i < init.numOutputs; i++) outputPorts.push(outputPort(i));

  return {
    operatorID: init.id,
    operatorType: init.type,
    operatorVersion: "N/A",
    operatorProperties: init.properties,
    inputPorts,
    outputPorts,
    showAdvanced: false,
    isDisabled: false,
    customDisplayName: init.displayName ?? init.type,
    dynamicInputPorts: init.numInputs > 1,
    dynamicOutputPorts: false,
    viewResult: init.viewResult ?? false,
  };
}

function buildLink(linkID: string, fromOp: string, fromPort: number, toOp: string, toPort: number): OperatorLink {
  return {
    linkID,
    source: { operatorID: fromOp, portID: `output-${fromPort}` },
    target: { operatorID: toOp, portID: `input-${toPort}` },
  };
}

function pythonSource(id: string, displayName: string, code: string): OperatorPredicate {
  return buildOperator({
    type: "PythonUDFSourceV2",
    id,
    displayName,
    properties: {
      code,
      workers: 1,
      columns: [],
      dynamicOutputSchema: true,
    },
    numInputs: 0,
    numOutputs: 1,
  });
}

function pythonTableUdf(
  id: string,
  displayName: string,
  code: string,
  numInputs: number,
  viewResult: boolean
): OperatorPredicate {
  return buildOperator({
    type: "PythonUDFV2",
    id,
    displayName,
    properties: {
      code,
      workers: 1,
      retainInputColumns: false,
      outputColumns: [],
      dynamicOutputSchema: true,
    },
    numInputs,
    numOutputs: 1,
    viewResult,
  });
}

/* ---------------- Workflow 1 — chain (Iris) ---------------- */

function buildIrisChain(dataDir: string): WorkflowContent {
  const irisPath = `${dataDir}/Iris.csv`;

  const sourceCode = [
    "from pytexera import *",
    "import pandas as pd",
    "",
    "class LoadIris(UDFSourceOperator):",
    "    @overrides",
    "    def produce(self) -> Iterator[Optional[TableLike]]:",
    `        df = pd.read_csv(${JSON.stringify(irisPath)})`,
    "        yield df",
  ].join("\n");

  const filterCode = [
    "from pytexera import *",
    "",
    "class FilterLargeSepals(UDFTableOperator):",
    "    @overrides",
    "    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:",
    "        yield table[table['SepalLengthCm'] > 5.0]",
  ].join("\n");

  const enrichCode = [
    "from pytexera import *",
    "",
    "class AddPetalArea(UDFTableOperator):",
    "    @overrides",
    "    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:",
    "        out = table.copy()",
    "        out['PetalAreaCm2'] = out['PetalLengthCm'] * out['PetalWidthCm']",
    "        yield out",
  ].join("\n");

  const src = pythonSource("PythonUDFSourceV2-operator-iris-load", "Load Iris", sourceCode);
  const filt = pythonTableUdf("PythonUDFV2-operator-iris-filter", "Filter Sepal>5cm", filterCode, 1, false);
  const enrich = pythonTableUdf("PythonUDFV2-operator-iris-enrich", "Add Petal Area", enrichCode, 1, true);

  return {
    operators: [src, filt, enrich],
    operatorPositions: {
      [src.operatorID]: pos(120, 200),
      [filt.operatorID]: pos(420, 200),
      [enrich.operatorID]: pos(720, 200),
    },
    links: [
      buildLink("link-iris-1", src.operatorID, 0, filt.operatorID, 0),
      buildLink("link-iris-2", filt.operatorID, 0, enrich.operatorID, 0),
    ],
    commentBoxes: [] as CommentBox[],
    settings: DEFAULT_SETTINGS,
  };
}

/* ---------------- Workflow 2 — DAG (TMDb fan-out) ---------------- */

function buildTmdbDag(dataDir: string): WorkflowContent {
  const tmdbPath = `${dataDir}/TMDb_updated.csv`;

  const sourceCode = [
    "from pytexera import *",
    "import pandas as pd",
    "",
    "class LoadTMDb(UDFSourceOperator):",
    "    @overrides",
    "    def produce(self) -> Iterator[Optional[TableLike]]:",
    `        df = pd.read_csv(${JSON.stringify(tmdbPath)})`,
    "        keep = ['title', 'original_language', 'overview', 'vote_count', 'vote_average']",
    "        df = df[[c for c in keep if c in df.columns]].fillna({",
    "            'title': '', 'original_language': '', 'overview': '',",
    "            'vote_count': 0, 'vote_average': 0.0,",
    "        })",
    "        yield df",
  ].join("\n");

  const englishFilterCode = [
    "from pytexera import *",
    "",
    "class KeepEnglish(UDFTableOperator):",
    "    @overrides",
    "    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:",
    "        yield table[table['original_language'] == 'en']",
  ].join("\n");

  const topPopularCode = [
    "from pytexera import *",
    "",
    "class TopByVoteAverage(UDFTableOperator):",
    "    @overrides",
    "    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:",
    "        yield table.sort_values('vote_average', ascending=False).head(10)",
  ].join("\n");

  const langCountCode = [
    "from pytexera import *",
    "",
    "class CountByLanguage(UDFTableOperator):",
    "    @overrides",
    "    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:",
    "        agg = table.groupby('original_language').size().reset_index(name='count')",
    "        yield agg.sort_values('count', ascending=False)",
  ].join("\n");

  const src = pythonSource("PythonUDFSourceV2-operator-tmdb-load", "Load TMDb", sourceCode);
  const enFilt = pythonTableUdf("PythonUDFV2-operator-tmdb-en", "Keep English", englishFilterCode, 1, false);
  const top = pythonTableUdf("PythonUDFV2-operator-tmdb-top", "Top Popular", topPopularCode, 1, true);
  const langCount = pythonTableUdf("PythonUDFV2-operator-tmdb-langcount", "Count by Language", langCountCode, 1, true);

  return {
    operators: [src, enFilt, top, langCount],
    operatorPositions: {
      [src.operatorID]: pos(120, 240),
      [enFilt.operatorID]: pos(420, 120),
      [top.operatorID]: pos(720, 120),
      [langCount.operatorID]: pos(420, 360),
    },
    links: [
      buildLink("link-tmdb-1", src.operatorID, 0, enFilt.operatorID, 0),
      buildLink("link-tmdb-2", enFilt.operatorID, 0, top.operatorID, 0),
      buildLink("link-tmdb-3", src.operatorID, 0, langCount.operatorID, 0),
    ],
    commentBoxes: [],
    settings: DEFAULT_SETTINGS,
  };
}

/* ---------------- Workflow 3 — three-input merge ---------------- */

function buildThreeInputMerge(dataDir: string): WorkflowContent {
  const irisPath = `${dataDir}/Iris.csv`;
  const tmdbPath = `${dataDir}/TMDb_updated.csv`;

  const irisSourceCode = [
    "from pytexera import *",
    "import pandas as pd",
    "",
    "class LoadIrisStats(UDFSourceOperator):",
    "    @overrides",
    "    def produce(self) -> Iterator[Optional[TableLike]]:",
    `        df = pd.read_csv(${JSON.stringify(irisPath)})`,
    "        out = pd.DataFrame({",
    "            'source': ['iris'] * len(df),",
    "            'category': df['Species'].astype(str),",
    "            'value': df['SepalLengthCm'].astype(float),",
    "        })",
    "        yield out",
  ].join("\n");

  const tmdbSourceCode = [
    "from pytexera import *",
    "import pandas as pd",
    "",
    "class LoadTMDbStats(UDFSourceOperator):",
    "    @overrides",
    "    def produce(self) -> Iterator[Optional[TableLike]]:",
    `        df = pd.read_csv(${JSON.stringify(tmdbPath)})`,
    "        df = df.dropna(subset=['vote_average'])",
    "        out = pd.DataFrame({",
    "            'source': ['tmdb'] * len(df),",
    "            'category': df['original_language'].fillna('').astype(str),",
    "            'value': df['vote_average'].astype(float),",
    "        })",
    "        yield out",
  ].join("\n");

  const syntheticSourceCode = [
    "from pytexera import *",
    "import pandas as pd",
    "",
    "class SyntheticReference(UDFSourceOperator):",
    "    @overrides",
    "    def produce(self) -> Iterator[Optional[TableLike]]:",
    "        yield pd.DataFrame({",
    "            'source': ['synthetic'] * 3,",
    "            'category': ['baseline', 'control', 'reference'],",
    "            'value': [1.0, 1.0, 1.0],",
    "        })",
  ].join("\n");

  const mergeCode = [
    "from pytexera import *",
    "import pandas as pd",
    "",
    "class MergeThreeStreams(UDFTableOperator):",
    "    PORT_NAMES = ['iris', 'tmdb', 'synthetic']",
    "",
    "    @overrides",
    "    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:",
    "        avg = float(table['value'].mean()) if len(table) else 0.0",
    "        yield pd.DataFrame([{",
    "            'source': self.PORT_NAMES[port],",
    "            'count': int(len(table)),",
    "            'avg_value': avg,",
    "        }])",
  ].join("\n");

  const src1 = pythonSource("PythonUDFSourceV2-operator-merge-iris", "Iris Stats", irisSourceCode);
  const src2 = pythonSource("PythonUDFSourceV2-operator-merge-tmdb", "TMDb Stats", tmdbSourceCode);
  const src3 = pythonSource("PythonUDFSourceV2-operator-merge-syn", "Synthetic Stats", syntheticSourceCode);
  const merge = pythonTableUdf("PythonUDFV2-operator-merge-3", "Merge 3 Streams", mergeCode, 3, true);

  return {
    operators: [src1, src2, src3, merge],
    operatorPositions: {
      [src1.operatorID]: pos(120, 120),
      [src2.operatorID]: pos(120, 280),
      [src3.operatorID]: pos(120, 440),
      [merge.operatorID]: pos(520, 280),
    },
    links: [
      buildLink("link-merge-1", src1.operatorID, 0, merge.operatorID, 0),
      buildLink("link-merge-2", src2.operatorID, 0, merge.operatorID, 1),
      buildLink("link-merge-3", src3.operatorID, 0, merge.operatorID, 2),
    ],
    commentBoxes: [],
    settings: DEFAULT_SETTINGS,
  };
}

/* ---------------- Workflow 4 — four-input aggregator ---------------- */

function buildFourInputAggregator(dataDir: string): WorkflowContent {
  const irisPath = `${dataDir}/Iris.csv`;

  function speciesSource(id: string, displayName: string, species: string): OperatorPredicate {
    const code = [
      "from pytexera import *",
      "import pandas as pd",
      "",
      `class Load_${species.replace(/[^a-zA-Z0-9_]/g, "_")}(UDFSourceOperator):`,
      "    @overrides",
      "    def produce(self) -> Iterator[Optional[TableLike]]:",
      `        df = pd.read_csv(${JSON.stringify(irisPath)})`,
      `        df = df[df['Species'] == ${JSON.stringify(species)}]`,
      "        yield pd.DataFrame({",
      "            'sepal_len': df['SepalLengthCm'].astype(float),",
      "            'petal_len': df['PetalLengthCm'].astype(float),",
      "            'species': df['Species'].astype(str),",
      "        })",
    ].join("\n");
    return pythonSource(id, displayName, code);
  }

  const aggregatorCode = [
    "from pytexera import *",
    "import pandas as pd",
    "",
    "class FourPortAggregator(UDFTableOperator):",
    "    PORT_LABELS = ['setosa_port', 'versicolor_port', 'virginica_port', 'all_species']",
    "",
    "    @overrides",
    "    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:",
    "        vals = table['sepal_len'].astype(float) if len(table) else pd.Series(dtype=float)",
    "        yield pd.DataFrame([{",
    "            'port': self.PORT_LABELS[port],",
    "            'count': int(len(vals)),",
    "            'mean_sepal_len': float(vals.mean()) if len(vals) else 0.0,",
    "            'min_sepal_len': float(vals.min()) if len(vals) else 0.0,",
    "            'max_sepal_len': float(vals.max()) if len(vals) else 0.0,",
    "        }])",
  ].join("\n");

  const setosa = speciesSource("PythonUDFSourceV2-operator-agg-setosa", "Setosa", "Iris-setosa");
  const versicolor = speciesSource("PythonUDFSourceV2-operator-agg-versicolor", "Versicolor", "Iris-versicolor");
  const virginica = speciesSource("PythonUDFSourceV2-operator-agg-virginica", "Virginica", "Iris-virginica");
  const allCode = [
    "from pytexera import *",
    "import pandas as pd",
    "",
    "class LoadAllIris(UDFSourceOperator):",
    "    @overrides",
    "    def produce(self) -> Iterator[Optional[TableLike]]:",
    `        df = pd.read_csv(${JSON.stringify(irisPath)})`,
    "        yield pd.DataFrame({",
    "            'sepal_len': df['SepalLengthCm'].astype(float),",
    "            'petal_len': df['PetalLengthCm'].astype(float),",
    "            'species': df['Species'].astype(str),",
    "        })",
  ].join("\n");
  const all = pythonSource("PythonUDFSourceV2-operator-agg-all", "All Iris", allCode);
  const agg = pythonTableUdf("PythonUDFV2-operator-agg-4", "4-Port Aggregate", aggregatorCode, 4, true);

  return {
    operators: [setosa, versicolor, virginica, all, agg],
    operatorPositions: {
      [setosa.operatorID]: pos(120, 80),
      [versicolor.operatorID]: pos(120, 220),
      [virginica.operatorID]: pos(120, 360),
      [all.operatorID]: pos(120, 500),
      [agg.operatorID]: pos(560, 280),
    },
    links: [
      buildLink("link-agg-1", setosa.operatorID, 0, agg.operatorID, 0),
      buildLink("link-agg-2", versicolor.operatorID, 0, agg.operatorID, 1),
      buildLink("link-agg-3", virginica.operatorID, 0, agg.operatorID, 2),
      buildLink("link-agg-4", all.operatorID, 0, agg.operatorID, 3),
    ],
    commentBoxes: [],
    settings: DEFAULT_SETTINGS,
  };
}

export const CODE_WORKFLOW_SPECS: CodeWorkflowSpec[] = [
  {
    name: "[Code] Iris Chain",
    description: "Single source → filter → enrich (chain shape).",
    build: buildIrisChain,
  },
  {
    name: "[Code] TMDb DAG",
    description: "Single source fans out to two independent branches (DAG shape).",
    build: buildTmdbDag,
  },
  {
    name: "[Code] 3-Input Merge",
    description: "Three sources merged through a 3-input UDF.",
    build: buildThreeInputMerge,
  },
  {
    name: "[Code] 4-Input Aggregator",
    description: "Four sources fan in to a 4-input UDF aggregator.",
    build: buildFourInputAggregator,
  },
];
