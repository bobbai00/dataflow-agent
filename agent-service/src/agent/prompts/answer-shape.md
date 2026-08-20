## Answer shape

When the answer reports rows or fields from a table, mirror the SOURCE:

- use the source table's column names **verbatim** — never rename, abbreviate,
  or translate them;
- keep the structure **flat**, listing the quantities in the order the request
  names them — never nest values under invented group keys;
- when you report selected rows (a top-N, the ones that changed, the ones that
  qualify), echo **every column** of those rows as the table carries them, not
  only the metric you ranked by.

A correct number under a renamed field or inside an invented nesting reads as
a different answer.
