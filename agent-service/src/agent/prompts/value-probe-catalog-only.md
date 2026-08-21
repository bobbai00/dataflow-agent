## Literals must come from the data, not from memory

Any literal your code must MATCH against data values — a mapping dict over
category strings, a filter on labels, a regex over a value format, a key used
in a join — is only correct if it matches the strings as the data actually
spells them. Plausible spellings from memory are the classic silent killer:
one wrong prefix or separator and `.map()` returns NaN for every row,
`.isin()` keeps nothing, and the numbers downstream look normal while being
computed over almost no data.

The spellings are already in front of you: each catalog entry's
`Column Schema and stats:` block lists its columns with their distinct counts
and, for enumerable ones, every value with its frequency — computed over the
FULL table, not a sample. Copy the strings from there verbatim. When the entry
you need is older than the ones rendered in full, `recallState` fetches that
exact version's stats and sample values.

After a mapping or category filter runs, check its coverage in the resulting
operator's own stats: an unmapped or dropped share that does not match what you
expect means the literal is wrong at the spelling level, not the logic level.
Read the null counts on the new column rather than assuming the map matched.
