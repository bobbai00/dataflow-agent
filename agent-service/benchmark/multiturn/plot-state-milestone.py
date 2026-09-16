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
"""Standalone figure from the frozen aggregate; no alternate scoring."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter, StrMethodFormatter

root = Path(__file__).resolve().parent
r = json.loads((root/'STATE_MILESTONE_RESULTS.json').read_text())
colors = ['#147d64', '#65738c', '#c76c21']
labels = ['CodeAgent', 'Current Dataflow', 'Candidate Dataflow']
arms = ['code', 'tasks', 'reuse']
fig, (ax, bx) = plt.subplots(1, 2, figsize=(10, 3.8), layout='constrained')
for arm, label, color in zip(arms, labels, colors):
    s = r['arms'][arm]
    x, y = s['cost_usd']/s['sessions'], s['passed']/s['tasks']
    ax.scatter(x, y, color=color, s=70)
    ax.annotate(label, (x,y), xytext=(0,9), textcoords='offset points', ha='center', fontsize=9)
ax.set(xlabel='Recorded model cost per session (USD)', ylabel='Task success',
       xlim=(.006,.0185), ylim=(.91,.98), title='All seven session families')
ax.xaxis.set_major_formatter(StrMethodFormatter('${x:.3f}'))
ax.yaxis.set_major_formatter(PercentFormatter(1)); ax.grid(alpha=.18)
for i, (arm,label,color) in enumerate(zip(arms,labels,colors)):
    github, whole = r['families']['longds_github'][arm], r['arms'][arm]
    values = [(whole['passed']-github['passed'])/(whole['tasks']-github['tasks']), github['passed']/github['tasks']]
    bars = bx.bar([-.24+i*.24,1-.24+i*.24], values, width=.23, color=color, label=label)
    bx.bar_label(bars, labels=[f'{x:.1%}' for x in values], fontsize=8, padding=3)
bx.set(xticks=[0,1], xticklabels=['Controlled tasks','GitHub tasks'], ylim=(0,1.1), title='State probes and real-data session')
bx.yaxis.set_major_formatter(PercentFormatter(1))
fig.legend(*bx.get_legend_handles_labels(), loc='outside lower center', ncols=3, frameon=False)
fig.suptitle('Three fresh trials per family and arm • 567 scored task answers', fontsize=12)
svg = root/'STATE_MILESTONE_RESULTS.svg'
fig.savefig(svg, bbox_inches='tight')
svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines())+'\n')
fig.savefig('/tmp/texera-task-history/state-milestone/results.png', dpi=140, bbox_inches='tight')
plt.close(fig)
