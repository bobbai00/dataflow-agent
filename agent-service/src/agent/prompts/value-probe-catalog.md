## Literals must come from the data, not from memory

Any literal your code must MATCH against data values — a mapping dict over
category strings, a filter on labels, a regex over a value format, a key used
in a join — is only correct if it matches the strings as the data actually
spells them. Plausible spellings from memory are the classic silent killer:
one wrong prefix or separator and `.map()` returns NaN for every row,
`.isin()` keeps nothing, and the numbers downstream look normal while being
computed over almost no data.

The spellings are usually already in front of you: each catalog entry's
`Column Schema and stats:` block prints the column's distinct values with
counts, computed over the FULL table. Copy the strings from there verbatim.
Spend a `queryResult` call only when the printed inventory does not settle it
— the column was clipped on a wide table, the histogram shows `…more`
buckets you need, or the read is genuinely dynamic (a ranked top-N, a
filtered row set). Do not re-query what an entry already prints.

After a mapping or category filter runs, check its coverage once: unmapped or
dropped share should match what you expect (`df['mapped'].isna().mean()`).
A mapping that silently loses most rows is wrong at the spelling level, not
the logic level.
