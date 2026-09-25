<!--
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements. See the NOTICE file
distributed with this work for additional information
regarding copyright ownership. The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License. You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied. See the License for the
specific language governing permissions and limitations
under the License.
-->

First-pass results are primary. Recovery trials are separate; no best-of selection.
Model costs use repository cache-aware rates. Infrastructure is excluded.
Where recorded, session-budget.json defines the wall limit; unreached questions count as failures.
Missing sessions remain unjudged. Incomplete trial costs cover only recorded sessions and are not comparable to complete trials.
Scoring models: gpt-5.2.

| Trial | Arm | Correct / judged / planned | Attempted | Budget stops | Task macro | Model USD | Calls |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | dsgym | 57/209/209 | 209 | 0 | 30.1% | 0.7690 | 424 |
| 1 | dsgym-functions | 55/209/209 | 209 | 0 | 29.1% | 0.8505 | 418 |
| 1 | react-analysis | 73/209/209 | 189 | 2 | 37.6% | 1.8372 | 875 |
| 1 | react-entries | 76/209/209 | 177 | 1 | 40.1% | 1.3613 | 534 |
| 2 | dsgym | 47/209/209 | 209 | 0 | 25.1% | 0.6054 | 368 |
| 2 | dsgym-functions | 50/209/209 | 209 | 0 | 26.0% | 0.6760 | 409 |
| 2 | react-analysis | 72/209/209 | 185 | 1 | 36.6% | 1.6635 | 758 |
| 2 | react-entries | 83/209/209 | 178 | 1 | 42.8% | 1.5451 | 536 |
| 3 | dsgym | 50/209/209 | 209 | 0 | 26.5% | 0.6634 | 379 |
| 3 | dsgym-functions | 50/209/209 | 209 | 0 | 25.0% | 0.7523 | 397 |
| 3 | react-analysis | 57/179/209 | running | 1 | excluded | 1.5127 | 741 |
| 3 | react-entries | 28/149/209 | 118 | 1 | incomplete | 1.2219 | 381 |

Recorded model spending for this report's run prefix: $13.4583.
Judge spending for these runs, including archived judge attempts: $0.0000 provider-reported + $17.6217 estimated from recorded tokens.
Unpriced judge responses: 0; failed requests without usage: 0 (billing unavailable).

| Trial | Arm | Task | Correct / judged / planned | Attempted | Model USD |
| ---: | --- | --- | ---: | ---: | ---: |
| 1 | dsgym-functions | business__goodbooks_10k__task1 | 0/35/35 | 35 | 0.1630 |
| 1 | dsgym-functions | community__kaggle-survey-2022__task2 | 20/30/30 | 30 | 0.0929 |
| 1 | dsgym-functions | education__bi__task2 | 21/30/30 | 30 | 0.0392 |
| 1 | dsgym-functions | geoscience__water-potability__task3 | 10/36/36 | 36 | 0.1402 |
| 1 | dsgym-functions | social_good__data_science_for_good_city_of_los_angeles__task1 | 1/36/36 | 36 | 0.2160 |
| 1 | dsgym-functions | sports__nfl_big_data_bowl_2023__task1 | 3/42/42 | 42 | 0.1991 |
| 2 | dsgym-functions | business__goodbooks_10k__task1 | 1/35/35 | 35 | 0.2217 |
| 2 | dsgym-functions | community__kaggle-survey-2022__task2 | 14/30/30 | 30 | 0.0651 |
| 2 | dsgym-functions | education__bi__task2 | 20/30/30 | 30 | 0.0378 |
| 2 | dsgym-functions | geoscience__water-potability__task3 | 8/36/36 | 36 | 0.0579 |
| 2 | dsgym-functions | social_good__data_science_for_good_city_of_los_angeles__task1 | 2/36/36 | 36 | 0.1526 |
| 2 | dsgym-functions | sports__nfl_big_data_bowl_2023__task1 | 5/42/42 | 42 | 0.1410 |
| 3 | dsgym-functions | business__goodbooks_10k__task1 | 0/35/35 | 35 | 0.1367 |
| 3 | dsgym-functions | community__kaggle-survey-2022__task2 | 8/30/30 | 30 | 0.1047 |
| 3 | dsgym-functions | education__bi__task2 | 20/30/30 | 30 | 0.0400 |
| 3 | dsgym-functions | geoscience__water-potability__task3 | 10/36/36 | 36 | 0.1385 |
| 3 | dsgym-functions | social_good__data_science_for_good_city_of_los_angeles__task1 | 1/36/36 | 36 | 0.1771 |
| 3 | dsgym-functions | sports__nfl_big_data_bowl_2023__task1 | 11/42/42 | 42 | 0.1553 |
| 1 | dsgym | business__goodbooks_10k__task1 | 0/35/35 | 35 | 0.1699 |
| 1 | dsgym | community__kaggle-survey-2022__task2 | 18/30/30 | 30 | 0.1114 |
| 1 | dsgym | education__bi__task2 | 23/30/30 | 30 | 0.0371 |
| 1 | dsgym | geoscience__water-potability__task3 | 15/36/36 | 36 | 0.1948 |
| 1 | dsgym | social_good__data_science_for_good_city_of_los_angeles__task1 | 0/36/36 | 36 | 0.1178 |
| 1 | dsgym | sports__nfl_big_data_bowl_2023__task1 | 1/42/42 | 42 | 0.1380 |
| 2 | dsgym | business__goodbooks_10k__task1 | 1/35/35 | 35 | 0.2332 |
| 2 | dsgym | community__kaggle-survey-2022__task2 | 20/30/30 | 30 | 0.0932 |
| 2 | dsgym | education__bi__task2 | 16/30/30 | 30 | 0.0361 |
| 2 | dsgym | geoscience__water-potability__task3 | 10/36/36 | 36 | 0.1481 |
| 2 | dsgym | social_good__data_science_for_good_city_of_los_angeles__task1 | 0/36/36 | 36 | 0.0770 |
| 2 | dsgym | sports__nfl_big_data_bowl_2023__task1 | 0/42/42 | 42 | 0.0179 |
| 3 | dsgym | business__goodbooks_10k__task1 | 0/35/35 | 35 | 0.1301 |
| 3 | dsgym | community__kaggle-survey-2022__task2 | 11/30/30 | 30 | 0.0866 |
| 3 | dsgym | education__bi__task2 | 27/30/30 | 30 | 0.0548 |
| 3 | dsgym | geoscience__water-potability__task3 | 8/36/36 | 36 | 0.1146 |
| 3 | dsgym | social_good__data_science_for_good_city_of_los_angeles__task1 | 2/36/36 | 36 | 0.1166 |
| 3 | dsgym | sports__nfl_big_data_bowl_2023__task1 | 2/42/42 | 42 | 0.1606 |
| 1 | react-analysis | business__goodbooks_10k__task1 | 0/35/35 | 17 | 0.2589 |
| 1 | react-analysis | community__kaggle-survey-2022__task2 | 19/30/30 | 28 | 0.1724 |
| 1 | react-analysis | education__bi__task2 | 28/30/30 | 30 | 0.0927 |
| 1 | react-analysis | geoscience__water-potability__task3 | 13/36/36 | 36 | 0.3749 |
| 1 | react-analysis | social_good__data_science_for_good_city_of_los_angeles__task1 | 4/36/36 | 36 | 0.3859 |
| 1 | react-analysis | sports__nfl_big_data_bowl_2023__task1 | 9/42/42 | 42 | 0.5523 |
| 2 | react-analysis | business__goodbooks_10k__task1 | 0/35/35 | 11 | 0.1237 |
| 2 | react-analysis | community__kaggle-survey-2022__task2 | 19/30/30 | 30 | 0.1708 |
| 2 | react-analysis | education__bi__task2 | 27/30/30 | 30 | 0.0857 |
| 2 | react-analysis | geoscience__water-potability__task3 | 8/36/36 | 36 | 0.3357 |
| 2 | react-analysis | social_good__data_science_for_good_city_of_los_angeles__task1 | 3/36/36 | 36 | 0.4326 |
| 2 | react-analysis | sports__nfl_big_data_bowl_2023__task1 | 15/42/42 | 42 | 0.5151 |
| 3 | react-analysis | business__goodbooks_10k__task1 | 1/35/35 | 11 | 0.1221 |
| 3 | react-analysis | community__kaggle-survey-2022__task2 | 0/0/30 | running | 0.0258 |
| 3 | react-analysis | education__bi__task2 | 20/30/30 | 30 | 0.0912 |
| 3 | react-analysis | geoscience__water-potability__task3 | 15/36/36 | 36 | 0.3212 |
| 3 | react-analysis | social_good__data_science_for_good_city_of_los_angeles__task1 | 4/36/36 | 36 | 0.4180 |
| 3 | react-analysis | sports__nfl_big_data_bowl_2023__task1 | 17/42/42 | 42 | 0.5343 |
| 1 | react-entries | business__goodbooks_10k__task1 | 0/35/35 | 3 | 0.0292 |
| 1 | react-entries | community__kaggle-survey-2022__task2 | 27/30/30 | 30 | 0.1695 |
| 1 | react-entries | education__bi__task2 | 28/30/30 | 30 | 0.0748 |
| 1 | react-entries | geoscience__water-potability__task3 | 9/36/36 | 36 | 0.2510 |
| 1 | react-entries | social_good__data_science_for_good_city_of_los_angeles__task1 | 10/36/36 | 36 | 0.3459 |
| 1 | react-entries | sports__nfl_big_data_bowl_2023__task1 | 2/42/42 | 42 | 0.4909 |
| 2 | react-entries | business__goodbooks_10k__task1 | 0/35/35 | 4 | 0.0411 |
| 2 | react-entries | community__kaggle-survey-2022__task2 | 27/30/30 | 30 | 0.1973 |
| 2 | react-entries | education__bi__task2 | 29/30/30 | 30 | 0.0833 |
| 2 | react-entries | geoscience__water-potability__task3 | 11/36/36 | 36 | 0.2513 |
| 2 | react-entries | social_good__data_science_for_good_city_of_los_angeles__task1 | 3/36/36 | 36 | 0.3897 |
| 2 | react-entries | sports__nfl_big_data_bowl_2023__task1 | 13/42/42 | 42 | 0.5824 |
| 3 | react-entries | business__goodbooks_10k__task1 | 0/35/35 | 4 | 0.0477 |
| 3 | react-entries | geoscience__water-potability__task3 | 10/36/36 | 36 | 0.2349 |
| 3 | react-entries | social_good__data_science_for_good_city_of_los_angeles__task1 | 2/36/36 | 36 | 0.4039 |
| 3 | react-entries | sports__nfl_big_data_bowl_2023__task1 | 16/42/42 | 42 | 0.5355 |
