# `@effect/sql-pg` rc.117: result columns with unregistered OIDs fail to decode ("Invalid UTF-8 in text value")

## Summary

The new in-house `PgConnection` driver requests the **binary** result format for
**every** result column, but the type registry only has binary codecs for a
subset of scalar OIDs. For any column whose OID has no registered codec, the
decode path falls back to interpreting the bytes as UTF-8 text (the behavior
introduced by PR #8240, "decode unregistered scalar OIDs as UTF-8 text"). Since
the server honored the binary request, those bytes are a binary wire value, and
the UTF-8 fallback fails with `PgTypesCodecError: Invalid UTF-8 in text value`.

Every statement selecting such a column fails: `select interval '1 day 2 hours'`
is a one-line reproduction. `interval` (1186), `point` (600) and `money` (790)
all reproduce; the same queries work through `node-postgres`, and worked in
`4.0.0-rc.112`, whose client delegated to `pg` and used the simple/Text
protocol for parameter-less queries.

## Affected versions

- `@effect/sql-pg` 4.0.0-rc.113 … 4.0.0-rc.117 (the in-house PgConnection
  driver). `4.0.0-rc.112` and earlier used `pg` and are not affected.

## Root cause

1. `packages/sql/pg/src/PgProtocol.ts` — `encodeBindUnsafe` hardcodes one
   result format code, binary, for all columns:

   ```
   // One result format code, binary, for every column.
   bytes[offset] = 0
   bytes[offset + 1] = 1   // count = 1
   bytes[offset + 2] = 0
   bytes[offset + 3] = 1   // format = binary
   ```

2. `packages/sql/pg/src/PgTypes.ts:1694` — decode:

   ```ts
   return codec === undefined ? decodeUtf8(bytes, 0, bytes.length) : codec.decode(bytes)
   ```

   `decodeUtf8` fails on the binary bytes (`PgTypes.ts:230`,
   `fail("Invalid UTF-8 in text value")`), which surfaces as
   `SqlError: PgConnection: Failed to decode row`.

The two features are individually fine but mutually incompatible: #8240's text
fallback can only succeed if the column was actually requested in **text**
format (Bind result format code `0`).

## Reproduction

See `repro.ts` + captured `OUTPUT.txt` (PostgreSQL 16-alpine, Docker):

- `select interval '1 day 2 hours' as v` →
  `SqlError: PgConnection: Failed to decode row (cause: PgTypesCodecError: Invalid UTF-8 in text value)`
- Same for `point(1,2)` and `money(1.5)`.
- Control: identical queries through `pg` (node-postgres) succeed.
- Result-shape matrix for registered OIDs shows the codecs working
  (`date` → string, `timestamptz` → `Date` per #8241, `time`/`timetz` →
  `bigint` micros, `numeric` → string).

## Impact

- Any query touching an unregistered OID hard-fails. This regressed real
  consumers: upgrading effect-qb from rc.112 to rc.117 turned its live
  PostgreSQL integration suite red (28 failures), e.g. statements selecting
  `interval` columns through `sql.unsafe`.
- Write paths that merely *return* an unregistered column (e.g.
  `INSERT … RETURNING interval`) fail after the statement has executed, which
  makes retry wrappers unsafe.

## Fix direction

Request per-column result formats in `Bind`: binary (`1`) only for OIDs that
have a registered codec, text (`0`) otherwise, so #8240's UTF-8 fallback
receives text bytes as intended.

Constraint: the Bind message is encoded before the statement's `RowDescription`
is known on first execution (the response to `Describe` arrives with the rest
of the batch). Two viable shapes:

1. **Two round trips for first execution only**: encode
   `Parse → Describe(statement) → Flush`, await the `RowDescription`, then
   send `Bind → Execute → Sync` with per-column format codes derived from the
   now-known OIDs. Cached statements (description already stored) keep the
   single-batch path, choosing binary/text per column from the cached
   description's OIDs.
2. **All-text results for first execution**: single batch, but then registered
   OIDs would also arrive as text, and the codec registry is binary-only
   ("Version 1 implements the binary wire format only"), so every type would
   need a text decoder. Larger surface, not recommended.

Option 1 preserves the binary fast path and the single-round-trip replay of
cached statements, and makes #8240's contract ("unregistered OIDs decode as
UTF-8 text") actually reachable.

## Regression test

`packages/sql/pg/test/PgConnection.in-process.test.ts` drives the connection
against an in-process fake backend. The regression test asserts that the Bind
sent for a statement whose RowDescription advertises an unregistered OID
carries a text format code for that column, and that the returned value is the
UTF-8 text the fake backend wrote.
