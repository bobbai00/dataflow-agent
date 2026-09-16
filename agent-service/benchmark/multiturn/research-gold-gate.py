# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
"""Reproduce candidate LongDS references with explicit missing notebook imports.

Does not rewrite reference calculations, answers, or scoring tolerance. Import
additions are recorded in each result. Invoke in separate processes: the numeric
gate changes cwd and stdout. This never sends reference material to an agent.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / 'benchmark/longds'))
import numeric_gate as gate

IMPORTS = {
    'business/netflix_movies_and_tv_shows/task1': 'from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer\nfrom sklearn.metrics.pairwise import linear_kernel\n',
    'community/kaggle-survey-2022/task3': 'from sklearn.linear_model import LinearRegression\n',
    'education/world_university_rankings/task2': 'import statsmodels.api as sm\n',
    'geoscience/water-potability/task3': 'from sklearn.tree import DecisionTreeClassifier\nfrom sklearn.ensemble import RandomForestClassifier\nfrom sklearn.model_selection import train_test_split, RandomizedSearchCV, RepeatedStratifiedKFold\nfrom sklearn.base import clone\nfrom sklearn.metrics import confusion_matrix, f1_score, precision_score, recall_score\nfrom scipy.stats import ks_2samp\n',
    'social_good/center_for_policing_equity/task1': 'from scipy.stats import fisher_exact\nimport statsmodels.formula.api as smf\n',
    'sports/nfl_big_data_bowl_2023/task1': '',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--task', choices=list(IMPORTS), required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    directory = args.upstream / 'task/longds' / args.task
    task_source = (directory/'task.py').read_text()
    source = task_source.replace(f'../../../../../data/longds/{args.task}', '.')
    assert '../../../../../data/longds' not in source
    turns = json.loads((directory/'task.json').read_text())
    gate.PRELUDE += IMPORTS[args.task]
    started = time.time()
    produced, errors, namespace = gate.run_turns(source, args.upstream/'data/longds'/args.task, len(turns))
    results = []
    for task in turns:
        key = str(task['turn_id'])
        mismatches = list(gate.diff(task['answer'], produced[key])) if key in produced else []
        results.append(dict(task=key, produced=key in produced, passed=key in produced and not mismatches,
                            mismatches=mismatches))
    import numpy, pandas, sklearn
    report = dict(task=args.task, imports_added=IMPORTS[args.task], tasks=len(turns),
                  passed=sum(r['passed'] for r in results), missing=sum(not r['produced'] for r in results),
                  errors=errors, header_succeeded=namespace is not None, elapsed_seconds=time.time()-started,
                  versions=dict(python=sys.version, numpy=numpy.__version__, pandas=pandas.__version__, sklearn=sklearn.__version__),
                  task_source_sha256=hashlib.sha256(task_source.encode()).hexdigest(),
                  task_json_sha256=hashlib.sha256((directory/'task.json').read_bytes()).hexdigest(), results=results)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps({k:v for k,v in report.items() if k not in ['results','versions']}),flush=True)


if __name__ == '__main__':
    main()
