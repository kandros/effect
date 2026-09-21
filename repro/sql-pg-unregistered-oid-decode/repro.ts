/**
 * Reproduction: @effect/sql-pg 4.0.0-rc.117 fails to decode result columns whose
 * OIDs have no registered binary codec (e.g. `interval`, OID 1186).
 *
 * Root cause (see ANALYSIS.md): the new in-house PgConnection requests the
 * BINARY result format for every column in the Bind message
 * (packages/sql/pg/src/PgProtocol.ts, encodeBindUnsafe: "One result format
 * code, binary, for every column"), while PgTypes decode falls back to
 * "UTF-8 text" for unregistered OIDs (PR #8240). Binary bytes are decoded as
 * UTF-8 text and fail with "Invalid UTF-8 in text value".
 *
 * Run: POSTGRES_URL=postgres://user:pass@127.0.0.1:5432/db bun run repro.ts
 * (requires a live PostgreSQL; tested against postgres:16-alpine)
 */
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { PgClient } from "@effect/sql-pg"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Duration from "effect/Duration"
import { Client as PgDriver } from "pg"

const dsn = process.env.POSTGRES_URL ?? "postgres://effect_qb:effect_qb@127.0.0.1:55432/effect_qb_test"
const url = new URL(dsn)

const layer = PgClient.layer({
  host: url.hostname,
  port: Number(url.port || 5432),
  database: url.pathname.slice(1),
  username: decodeURIComponent(url.username),
  password: Redacted.make(decodeURIComponent(url.password)),
  // single connection so "connection poisoning" is deterministic
  minConnections: 1,
  maxConnections: 1,
  connectionTTL: Duration.minutes(5)
})

const attempt = (sqlText: string) =>
  Effect.exit(Effect.suspend(() =>
    sqlText.includes("$1")
      ? sqlRef!.unsafe(sqlText, ["2026-01-02"]).pipe(Effect.map((rows) => (rows[0] as any)?.v))
      : sqlRef!.unsafe(sqlText).pipe(Effect.map((rows) => (rows[0] as any)?.v))
  ))

let sqlRef: SqlClient.SqlClient | undefined

const section = (title: string) => console.log(`\n=== ${title} ===`)

const program = Effect.gen(function*() {  const sql = yield* SqlClient.SqlClient
  sqlRef = sql

  console.log(`@effect/sql-pg repro — effect ${process.env.EFFECT_VERSION ?? "4.0.0-rc.117"}, driver: in-house PgConnection`)
  console.log(`target: ${dsn}`)

  // ------------------------------------------------------------------ A
  section("A. minimal reproduction — unregistered OID (interval, 1186)")
  const a = yield* attempt(`select interval '1 day 2 hours' as v`)
  console.log(a._tag === "Success"
    ? `interval → OK: ${typeof a.value} ${String(a.value)}`
    : `interval → FAILED: ${String(JSON.stringify(a.cause, null, 2)).slice(0, 900)}`)

  // ------------------------------------------------------------------ B
  section("B. same connection after the failure — subsequent queries")
  const b = yield* attempt(`select 1 as v`)
  console.log(b._tag === "Success"
    ? `select 1 → OK: ${String(b.value)}`
    : `select 1 → ALSO FAILED: ${String(JSON.stringify(a.cause)).slice(0, 300)}`)

  // ------------------------------------------------------------------ C
  section("C. result shape matrix (separate fresh statements)")
  const matrix: Array<[string, string]> = [
    ["date        (1082)", `select date '2026-01-02' as v`],
    ["numeric     (1700)", `select 1.25::numeric as v`],
    ["time        (1083)", `select time '12:34:56.789012' as v`],
    ["timetz      (1266)", `select time '12:34:56.789012+02' as v`],
    ["timestamptz (1184)", `select timestamptz '2026-01-02 03:04:05+00' as v`],
    ["bool        (   16)", `select true as v`],
    ["int4        (   23)", `select 42::int4 as v`],
    ["text        (   25)", `select 'abc'::text as v`],
    ["uuid        (2950)", `select 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid as v`],
    ["jsonb       (3802)", `select '{"a":1}'::jsonb as v`],
    ["interval    (1186)", `select interval '1 day 2 hours' as v`],
    ["point       ( 600)", `select point(1,2) as v`],
    ["money       ( 790)", `select money(1.5) as v`]
  ]
  for (const [label, sqlText] of matrix) {
    const result = yield* attempt(sqlText)
    if (result._tag === "Success") {
      const v = result.value
      console.log(`${label} → OK   ${typeof v} = ${String(v)}`)
    } else {
      const cause = String(result.cause)
      const message = cause.includes("Invalid UTF-8") ? "Invalid UTF-8 in text value" : cause.slice(0, 120)
      console.log(`${label} → FAIL ${message}`)
    }
  }

}).pipe(Effect.provide(layer), Effect.scoped)


// ------------------------------------------------------------------ D
section("D. control — same queries through node-postgres (the pre-rc.112 driver)")
const pgClient = new PgDriver({ connectionString: dsn })
await pgClient.connect()
for (const [label, sqlText] of [
  ["interval", "select interval '1 day 2 hours' as v"],
  ["point", "select point(1,2) as v"],
  ["money", "select money(1.5) as v"]
] as const) {
  const res = await pgClient.query(sqlText)
  const v = res.rows[0]?.v
  console.log(`${label.padEnd(9)} → OK   ${typeof v} = ${String(v)}`)
}
await pgClient.end()

await Effect.runPromise(program as Effect.Effect<void, unknown, never>).catch((e) => {
  console.error("FATAL:", String(e))
  process.exit(1)
})
