arms: ['gpt-5.6-terra-baseline-r1', 'gpt-5.6-terra-dsgym-r1', 'gpt-5.6-terra-ledger-r1']
turns judged in every arm: 172 (per arm: gpt-5.6-terra-baseline-r1=172, gpt-5.6-terra-dsgym-r1=172, gpt-5.6-terra-ledger-r1=172)

### Paired turns, all sessions (172 turns)

| arm | correct | acc | $/turn | calls/turn | out tok/turn | sec/turn |
|---|---:|---:|---:|---:|---:|---:|
| gpt-5.6-terra-baseline-r1 | 149/172 | 86.6% | 0.0958 | 3.73 | 1730 | 32 |
| gpt-5.6-terra-dsgym-r1 | 149/172 | 86.6% | 0.0939 | 2.35 | 1882 | 23 |
| gpt-5.6-terra-ledger-r1 | 153/172 | 89.0% | 0.0964 | 3.67 | 1696 | 33 |

### Cost decomposition per turn (paired turns, 172 turns)

| arm | fresh input $ | cached input $ | output $ | total $ | prompt tok (first call) | cached share |
|---|---:|---:|---:|---:|---:|---:|
| gpt-5.6-terra-baseline-r1 | 0.0578 | 0.0172 | 0.0208 | 0.0958 | — | 75% |
| gpt-5.6-terra-dsgym-r1 | 0.0648 | 0.0065 | 0.0226 | 0.0939 | — | 56% |
| gpt-5.6-terra-ledger-r1 | 0.0583 | 0.0178 | 0.0203 | 0.0964 | — | 75% |

### business__netflix_movies_and_tv_shows__task3 (35 turns)

| arm | correct | acc | $/turn | calls/turn | out tok/turn | sec/turn |
|---|---:|---:|---:|---:|---:|---:|
| gpt-5.6-terra-baseline-r1 | 32/35 | 91.4% | 0.0919 | 3.97 | 1716 | 37 |
| gpt-5.6-terra-dsgym-r1 | 32/35 | 91.4% | 0.0807 | 2.20 | 1521 | 20 |
| gpt-5.6-terra-ledger-r1 | 33/35 | 94.3% | 0.0889 | 3.69 | 1573 | 34 |

### business__nyc_restaurants_data_food_ordering_and_delivery__task2 (32 turns)

| arm | correct | acc | $/turn | calls/turn | out tok/turn | sec/turn |
|---|---:|---:|---:|---:|---:|---:|
| gpt-5.6-terra-baseline-r1 | 26/32 | 81.2% | 0.1176 | 4.41 | 2093 | 37 |
| gpt-5.6-terra-dsgym-r1 | 25/32 | 78.1% | 0.1072 | 2.50 | 2085 | 22 |
| gpt-5.6-terra-ledger-r1 | 25/32 | 78.1% | 0.1186 | 4.22 | 2005 | 37 |

### community__kaggle-survey-2022__task2 (28 turns)

| arm | correct | acc | $/turn | calls/turn | out tok/turn | sec/turn |
|---|---:|---:|---:|---:|---:|---:|
| gpt-5.6-terra-baseline-r1 | 23/28 | 82.1% | 0.0637 | 3.11 | 1372 | 25 |
| gpt-5.6-terra-dsgym-r1 | 27/28 | 96.4% | 0.0688 | 2.29 | 1591 | 19 |
| gpt-5.6-terra-ledger-r1 | 27/28 | 96.4% | 0.0662 | 3.36 | 1336 | 28 |

### social_good__data_science_for_good_kiva_crowdfunding__task1 (36 turns)

| arm | correct | acc | $/turn | calls/turn | out tok/turn | sec/turn |
|---|---:|---:|---:|---:|---:|---:|
| gpt-5.6-terra-baseline-r1 | 31/36 | 86.1% | 0.0977 | 3.64 | 1636 | 31 |
| gpt-5.6-terra-dsgym-r1 | 30/36 | 83.3% | 0.1018 | 2.53 | 2029 | 32 |
| gpt-5.6-terra-ledger-r1 | 32/36 | 88.9% | 0.1025 | 3.83 | 1747 | 32 |

### sports__nfl_big_data_bowl_2023__task1 (41 turns)

| arm | correct | acc | $/turn | calls/turn | out tok/turn | sec/turn |
|---|---:|---:|---:|---:|---:|---:|
| gpt-5.6-terra-baseline-r1 | 37/41 | 90.2% | 0.1024 | 3.51 | 1784 | 30 |
| gpt-5.6-terra-dsgym-r1 | 35/41 | 85.4% | 0.1050 | 2.24 | 2103 | 21 |
| gpt-5.6-terra-ledger-r1 | 36/41 | 87.8% | 0.1008 | 3.29 | 1760 | 32 |

### By label (paired turns; a turn counts under each of its labels)

| label | n | gpt-5.6-terra-baseline-r1 | gpt-5.6-terra-dsgym-r1 | gpt-5.6-terra-ledger-r1 |
|---|---:|---:|---:|---:|
| Counterfactual | 50 | 45 | 44 | 45 |
| Initial | 69 | 58 | 62 | 62 |
| Rollback | 48 | 44 | 40 | 46 |
| Update | 55 | 46 | 47 | 46 |

### Paired turns where the arms disagree

- business__netflix_movies_and_tv_shows__t t04 ['Update']: baseline-r1=1, dsgym-r1=0, ledger-r1=1
- business__netflix_movies_and_tv_shows__t t05 ['Update']: baseline-r1=1, dsgym-r1=1, ledger-r1=0
- business__netflix_movies_and_tv_shows__t t07 ['Initial', 'Update']: baseline-r1=0, dsgym-r1=1, ledger-r1=1
- business__netflix_movies_and_tv_shows__t t25 ['Initial']: baseline-r1=0, dsgym-r1=1, ledger-r1=1
- business__netflix_movies_and_tv_shows__t t29 ['Rollback', 'Counterfactual']: baseline-r1=1, dsgym-r1=0, ledger-r1=1
- business__nyc_restaurants_data_food_orde t05 ['Initial']: baseline-r1=0, dsgym-r1=1, ledger-r1=1
- business__nyc_restaurants_data_food_orde t09 ['Update']: baseline-r1=1, dsgym-r1=1, ledger-r1=0
- business__nyc_restaurants_data_food_orde t14 ['Update']: baseline-r1=0, dsgym-r1=1, ledger-r1=0
- business__nyc_restaurants_data_food_orde t15 ['Counterfactual']: baseline-r1=1, dsgym-r1=0, ledger-r1=1
- business__nyc_restaurants_data_food_orde t17 ['Rollback']: baseline-r1=1, dsgym-r1=0, ledger-r1=1
- business__nyc_restaurants_data_food_orde t23 ['Initial']: baseline-r1=1, dsgym-r1=1, ledger-r1=0
- business__nyc_restaurants_data_food_orde t24 ['Initial', 'Rollback']: baseline-r1=1, dsgym-r1=0, ledger-r1=1
- business__nyc_restaurants_data_food_orde t29 ['Counterfactual']: baseline-r1=1, dsgym-r1=1, ledger-r1=0
- business__nyc_restaurants_data_food_orde t31 ['Initial']: baseline-r1=0, dsgym-r1=0, ledger-r1=1
- community__kaggle-survey-2022__task2 t04 ['Initial']: baseline-r1=0, dsgym-r1=1, ledger-r1=1
- community__kaggle-survey-2022__task2 t09 ['Initial']: baseline-r1=0, dsgym-r1=1, ledger-r1=1
- community__kaggle-survey-2022__task2 t12 ['Initial']: baseline-r1=1, dsgym-r1=1, ledger-r1=0
- community__kaggle-survey-2022__task2 t13 ['Initial']: baseline-r1=0, dsgym-r1=0, ledger-r1=1
- community__kaggle-survey-2022__task2 t17 []: baseline-r1=0, dsgym-r1=1, ledger-r1=1
- community__kaggle-survey-2022__task2 t27 ['Update', 'Counterfactual']: baseline-r1=0, dsgym-r1=1, ledger-r1=1
- social_good__data_science_for_good_kiva_ t06 ['Rollback']: baseline-r1=1, dsgym-r1=0, ledger-r1=1
- social_good__data_science_for_good_kiva_ t09 ['Initial', 'Update']: baseline-r1=0, dsgym-r1=1, ledger-r1=1
- social_good__data_science_for_good_kiva_ t13 ['Initial', 'Update']: baseline-r1=1, dsgym-r1=1, ledger-r1=0
- social_good__data_science_for_good_kiva_ t14 ['Counterfactual']: baseline-r1=1, dsgym-r1=0, ledger-r1=0
- social_good__data_science_for_good_kiva_ t18 ['Initial', 'Update']: baseline-r1=1, dsgym-r1=0, ledger-r1=1
- social_good__data_science_for_good_kiva_ t29 ['Rollback', 'Counterfactual']: baseline-r1=0, dsgym-r1=1, ledger-r1=1
- social_good__data_science_for_good_kiva_ t30 ['Rollback']: baseline-r1=0, dsgym-r1=0, ledger-r1=1
- sports__nfl_big_data_bowl_2023__task1 t03 ['Initial']: baseline-r1=1, dsgym-r1=1, ledger-r1=0
- sports__nfl_big_data_bowl_2023__task1 t08 ['Update']: baseline-r1=0, dsgym-r1=0, ledger-r1=1
- sports__nfl_big_data_bowl_2023__task1 t15 ['Counterfactual']: baseline-r1=1, dsgym-r1=0, ledger-r1=1
- sports__nfl_big_data_bowl_2023__task1 t29 ['Update']: baseline-r1=1, dsgym-r1=0, ledger-r1=0
- sports__nfl_big_data_bowl_2023__task1 t30 ['Counterfactual']: baseline-r1=0, dsgym-r1=1, ledger-r1=0
- sports__nfl_big_data_bowl_2023__task1 t34 ['Rollback']: baseline-r1=1, dsgym-r1=0, ledger-r1=1

### Agreement on paired turns

- gpt-5.6-terra-baseline-r1 vs gpt-5.6-terra-dsgym-r1: both 138, only gpt-5.6-terra-baseline-r1 11, only gpt-5.6-terra-dsgym-r1 11, neither 12
- gpt-5.6-terra-baseline-r1 vs gpt-5.6-terra-ledger-r1: both 140, only gpt-5.6-terra-baseline-r1 9, only gpt-5.6-terra-ledger-r1 13, neither 10
- gpt-5.6-terra-dsgym-r1 vs gpt-5.6-terra-ledger-r1: both 140, only gpt-5.6-terra-dsgym-r1 9, only gpt-5.6-terra-ledger-r1 13, neither 10

### State use (all judged turns of each arm)

- gpt-5.6-terra-baseline-r1: 172 turns; wired a loaded table into new operators in 169 (right 147/169; without wiring right 2/3); retrieved a loaded table in 66; read a source file anew in 8; provenance cards in 0; execution notes in 0 (right 0/0); mean inspects 1.19
- gpt-5.6-terra-ledger-r1: 172 turns; wired a loaded table into new operators in 169 (right 150/169; without wiring right 3/3); retrieved a loaded table in 77; read a source file anew in 8; provenance cards in 169; execution notes in 122 (right 105/122); mean inspects 1.13
- script arm: 172 turns; 232 code blocks, 8 of them read a file; 9 turns answered without code

### Anomalies
 {'unavailable_result_read': 47} 

