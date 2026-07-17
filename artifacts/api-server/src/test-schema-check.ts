// Vitest globalSetup: fast schema-drift precheck.
//
// The integration tests hit the real dev database. If a merged task added a
// table or column in lib/db/src/schema/ but `db push` was never run, tests
// fail wholesale with confusing raw errors like
// "column X of relation Y does not exist". This check runs once before the
// suite, compares the Drizzle schema against information_schema, and fails
// with an actionable message instead.
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { pool } from "@workspace/db";
import * as schema from "@workspace/db/schema";

export default async function schemaDriftCheck(): Promise<void> {
  try {
    const res = await pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    const live = new Map<string, Set<string>>();
    for (const row of res.rows) {
      let cols = live.get(row.table_name);
      if (!cols) {
        cols = new Set();
        live.set(row.table_name, cols);
      }
      cols.add(row.column_name);
    }

    const missingTables: string[] = [];
    const missingColumns: string[] = [];
    for (const exported of Object.values(schema)) {
      if (!(exported instanceof PgTable)) continue;
      const { name: tableName, columns } = getTableConfig(exported);
      const liveCols = live.get(tableName);
      if (!liveCols) {
        missingTables.push(tableName);
        continue;
      }
      for (const col of columns) {
        if (!liveCols.has(col.name)) {
          missingColumns.push(`${tableName}.${col.name}`);
        }
      }
    }

    if (missingTables.length > 0 || missingColumns.length > 0) {
      const details = [
        ...missingTables.map((t) => `  missing table: ${t}`),
        ...missingColumns.map((c) => `  missing column: ${c}`),
      ].join("\n");
      throw new Error(
        `Dev database schema is out of date with lib/db/src/schema/:\n${details}\n\n` +
          `Run: pnpm --filter @workspace/db run push\n` +
          `(then re-run the tests)`,
      );
    }
  } finally {
    await pool.end();
  }
}
