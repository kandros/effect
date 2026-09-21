---
"@effect/sql-pg": patch
---

Fix result decoding for columns whose OIDs have no registered codec.

The connection now requests per-column result formats in `Bind`: binary (`1`)
only for OIDs that have a registered binary codec, text (`0`) for the rest, so
the UTF-8 fallback introduced for unregistered scalar OIDs receives text bytes
instead of binary ones. Previously every result column was requested as binary,
and an unregistered OID failed with `Invalid UTF-8 in text value` — or, when
the binary bytes happened to be valid UTF-8, silently decoded to a corrupted
string.

Because the column OIDs are unknown until the statement is described, the first
execution of a statement now runs `Parse` / `Describe` statement / `Sync`, then
`Bind` / `Execute` / `Sync` with the chosen formats. Cached statements keep a
single batch, choosing binary per column from the stored description. The
unnamed retry path still requests binary for every column.
