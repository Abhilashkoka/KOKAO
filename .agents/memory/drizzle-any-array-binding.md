---
name: Drizzle ANY(array) binding
description: Why raw sql`col = ANY(${jsArray})` fails at runtime in Drizzle/pg and what to use instead.
---

Interpolating a JS array into a raw Drizzle fragment like sql`${col} = ANY(${arr})` does NOT bind a Postgres array — pg sends it in a form Postgres rejects with `op ANY/ALL (array) requires array on right side` (a runtime-only failure; typecheck and unit tests with mocked db won't catch it).

**Why:** Drizzle's sql template binds the array as a single untyped param, not a typed Postgres array.

**How to apply:** Use `inArray(col, arr)` (works with SQL fragments as the left side too), or inside raw SQL use `IN (${sql.join(arr.map(v => sql`${v}`), sql`, `)})`. Grep for `= ANY(` when touching analytics-style queries. Verify via a live request, not mocked tests.
