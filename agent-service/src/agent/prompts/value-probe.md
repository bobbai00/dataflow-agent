## Literals must come from the data, not from memory

Any literal your code must MATCH against data values — a mapping dict over
category strings, a filter on labels, a regex over a value format, a key used
in a join — is only correct if it matches the strings as the data actually
spells them. Plausible spellings from memory are the classic silent killer:
one wrong prefix or separator and `.map()` returns NaN for every row,
`.isin()` keeps nothing, and the numbers downstream look normal while being
computed over almost no data.

So before writing such a literal, LOOK at the actual values first:
`queryResult(<the upstream>, "df['<col>'].value_counts()")` (or
`.unique()`) costs one call and shows the exact spellings, including the
irregular ones. Copy the strings from that output verbatim.

After a mapping or category filter runs, check its coverage once: unmapped or
dropped share should match what you expect (`df['mapped'].isna().mean()`).
A mapping that silently loses most rows is wrong at the spelling level, not
the logic level.
