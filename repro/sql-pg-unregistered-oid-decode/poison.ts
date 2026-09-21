import * as SqlClient from "effect/unstable/sql/SqlClient"
import { PgClient } from "@effect/sql-pg"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Duration from "effect/Duration"

const dsn = new URL("postgres://effect_qb:effect_qb@127.0.0.1:55432/effect_qb_test")
const layer = PgClient.layer({
  host: dsn.hostname, port: Number(dsn.port), database: dsn.pathname.slice(1),
  username: decodeURIComponent(dsn.username), password: Redacted.make(decodeURIComponent(dsn.password)),
})

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  for (let round = 1; round <= 20; round++) {
    const fail = yield* Effect.exit(Effect.suspend(() => sql.unsafe("select interval '1 day 2 hours' as v").pipe(Effect.map((rows) => (rows[0] as any)?.v))))
    if (fail._tag === "Success") console.log(`  interval value: ${typeof fail.value} = ${String(fail.value)}`)
    const after = yield* Effect.exit(Effect.suspend(() => sql.unsafe("select 1::numeric as v")))
    console.log(
      `round ${round}: interval=${fail._tag}${fail._tag === "Failure" ? " (expected)" : " OK?!"} ` +
      `numeric-after=${after._tag}${after._tag === "Failure" ? ` [${String(after.cause).includes("Invalid UTF-8") ? "Invalid UTF-8 (POISONED)" : "other error"}]` : " OK"}`
    )
  }
}).pipe(Effect.provide(layer), Effect.scoped)

await Effect.runPromise(program as Effect.Effect<void, unknown, never>).catch((e) => console.error("FATAL:", String(e).slice(0, 200)))
