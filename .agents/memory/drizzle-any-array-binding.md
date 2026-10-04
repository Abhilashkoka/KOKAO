---
name: Drizzle ANY(array) binding
description: Why raw sql`col = ANY(${jsArray})` fails at runtime in Drizzle/pg and what to use instead.
---

Interpolating a JS array into a raw Drizzle fragment like sql`${col} = ANY(${arr})` does NOT bind a Postgres array — pg sends it in a form Postgres rejects with `op ANY/ALL (array) requires array on right side` (a runtime-only failure; typecheck and unit tests with mocked db won't catch it).

**Why:** Drizzle's sql template binds the array as a single untyped param, not a typed Postgres array.

**How to apply:** Use `inArray(col, arr)` (works with SQL fragments as the left side too), or inside raw SQL use `IN (${sql.join(arr.map(v => sql`${v}`), sql`, `)})`. Grep for `= ANY(` when touching analytics-style queries. Verify via a live request, not mocked tests.

## Raw OR fragments

Parenthesize an entire raw `A OR B` fragment before combining it with Drizzle `and()`, or use Drizzle `or()` instead.

**Why:** `and()` does not wrap each raw fragment separately. SQL precedence can make `id = target AND A OR B` update every row satisfying B, including other tenants. Type checking cannot detect this.

**How to apply:** Test mutation predicates against unrelated same-tenant and cross-tenant rows, including JSON null and absent keys. Inspect generated SQL when mixing raw boolean fragments with query-builder conditions.
