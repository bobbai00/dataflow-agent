### 1. edit: ok
function load_values registered
function scale_values registered
function combine_values registered

### 2. inspect namespace: ok
Current registered definitions. Operator invocations have isolated execution variables.

| name | kind | signature | description | direct graph users |
|---|---|---|---|---|
| COUNTER | constant |  |  | — |
| _adjust | helper | (value) |  | — |
| combine_values | operator function | (left, right, *, multiplier=1) | Combine the value sums of two input tables. | — |
| load_values | operator function | (*, start=1) | Create two synthetic records with a per-invocation counter. | — |
| pd | import |  |  | — |
| scale_values | operator function | (table, *, factor=1) | Adjust and scale values without changing input rows. | — |
