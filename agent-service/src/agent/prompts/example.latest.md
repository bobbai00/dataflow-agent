Task: *I have customers.csv and orders.csv. Find the top 5 premium customers who made recent purchases. Definitions in readme.md.*

Thought: I need definitions plus both data files. Load all three in parallel.

Tool call (parallel):
- `readme`: load `/data/readme.md` content into a single-row DataFrame.
- `customers`: `pd.read_csv('/data/customers.csv')`
- `orders`: `pd.read_csv('/data/orders.csv')`

Observation — `# Current Dataflow`:
```
### Operator `readme` (DataLoading)
Summary: Load /data/readme.md into a single-row DataFrame.
Result:
  Output Table: 1 rows, 1 cols
  	content
  0	Premium = total spend >= $1000. Recent = last 30 days.

### Operator `customers` (DataLoading)
Summary: Load /data/customers.csv.
Result:
  Output Table: 10000 rows, 5 cols
  	customer_id	name	email	signup_date	tier
  0	1	Alice	a@x.com	2023-01-15	gold
  ...
  Column Schema and stats:
  - "tier" (str): null=0, distinct=3, top_5={"gold"=4200, "silver"=3800, "bronze"=2000}
  - "customer_id" (numeric): null=0, min=1, max=10000

### Operator `orders` (DataLoading)
Summary: Load /data/orders.csv.
Result:
  Output Table: 50000 rows, 4 cols
  	order_id	customer_id	amount	order_date
  0	...
  Column Schema and stats:
  - "customer_id" (numeric): null=0, min=1, max=10000
  - "amount" (numeric): null=0, mean=219.2, min=95, max=520
  - "order_date" (datetime): null=0, min=2024-09-15, max=2024-11-12
```

Thought: `customer_id` ranges align (both 1–10000) → clean inner join. Now join and filter to the last 30 days.

Tool call: `recent_orders` = from `customers` and `orders`, inner-join on `customer_id`, then filter `order_date >= today - 30d`.

Observation:
```
### Operator `recent_orders` (DataProcessing)
Summary: Join `customers` and `orders` on `customer_id`, filter to the last 30 days.
Inputs: customers (10000 rows, 5 cols), orders (50000 rows, 4 cols)
Result:
  Output Table: 1247 rows, 8 cols
  ...
  Column Schema and stats:
  - "amount" (numeric): null=0, mean=485.3, min=95, max=2500
```

Thought: aggregate by customer, filter to the premium threshold, return top 5.

Tool call: `top5` = from `recent_orders`, groupby `[customer_id, name]` sum `amount` as `total_spending`, filter `>= 1000`, return `.nlargest(5, 'total_spending')`.

Observation:
```
### Operator `top5` (DataProcessing)
Summary: From `recent_orders`, sum `amount` per customer, keep total_spending >= 1000, return the top 5.
Inputs: recent_orders (1247 rows, 8 cols)
Result:
  Output Table: 5 rows, 3 cols
  	customer_id	name	total_spending
  0	1	Alice	12450
  ...
```

Final answer: Alice ($12,450), Bob ($9,820), Carol ($8,150), David ($7,340), Eve ($6,290).