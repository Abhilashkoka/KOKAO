// Vitest globalSetup: fast schema-drift precheck.
//
// The integration tests hit the real dev database. If a merged task added a
// table or column in lib/db/src/schema/ but `db push` was never run, tests
// fail wholesale with confusing raw errors like
// "column X of relation Y does not exist". This check runs once before the
// suite, compares the Drizzle schema against information_schema, and fails
// with an actionable message instead.
import { getTableConfig, isPgEnum, PgTable } from "drizzle-orm/pg-core";
import { pool } from "@workspace/db";
import * as schema from "@workspace/db/schema";

interface LiveColumn {
  dataType: string;
  udtName: string;
  isNullable: boolean;
}

// Normalize a SQL type name to a canonical form so Drizzle's getSQLType()
// output (e.g. "varchar(255)", "serial", "timestamp with time zone") can be
// compared against information_schema values.
function normalizeType(raw: string): string {
  let t = raw.trim().toLowerCase();
  // Strip length/precision qualifiers: varchar(255), numeric(10, 2), timestamp (3) ...
  t = t.replace(/\s*\(\s*\d+(\s*,\s*\d+)?\s*\)/g, "");
  const isArray = t.endsWith("[]");
  if (isArray) t = t.slice(0, -2).trim();
  const aliases: Record<string, string> = {
    serial: "integer",
    smallserial: "smallint",
    bigserial: "bigint",
    int: "integer",
    int2: "smallint",
    int4: "integer",
    int8: "bigint",
    "character varying": "varchar",
    character: "char",
    bpchar: "char",
    bool: "boolean",
    "double precision": "float8",
    float: "float8",
    real: "float4",
    "timestamp without time zone": "timestamp",
    "timestamp with time zone": "timestamptz",
    "time without time zone": "time",
    "time with time zone": "timetz",
    decimal: "numeric",
  };
  t = aliases[t] ?? t;
  return isArray ? `${t}[]` : t;
}

// Resolve the live column's effective type name from information_schema.
function liveTypeName(col: LiveColumn): string {
  const dt = col.dataType.toLowerCase();
  if (dt === "array") {
    // udt_name is like "_text" for text[]
    return `${normalizeType(col.udtName.replace(/^_/, ""))}[]`;
  }
  if (dt === "user-defined") {
    // Enums and other custom types: compare by udt (type) name.
    return normalizeType(col.udtName);
  }
  return normalizeType(dt);
}

export default async function schemaDriftCheck(): Promise<void> {
  try {
    const res = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    const live = new Map<string, Map<string, LiveColumn>>();
    for (const row of res.rows) {
      let cols = live.get(row.table_name);
      if (!cols) {
        cols = new Map();
        live.set(row.table_name, cols);
      }
      cols.set(row.column_name, {
        dataType: row.data_type,
        udtName: row.udt_name,
        isNullable: row.is_nullable === "YES",
      });
    }

    const enumRes = await pool.query<{
      enum_name: string;
      enum_value: string;
    }>(
      `SELECT t.typname AS enum_name, e.enumlabel AS enum_value
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
        ORDER BY t.typname, e.enumsortorder`,
    );
    const liveEnums = new Map<string, string[]>();
    for (const row of enumRes.rows) {
      let values = liveEnums.get(row.enum_name);
      if (!values) {
        values = [];
        liveEnums.set(row.enum_name, values);
      }
      values.push(row.enum_value);
    }

    const missingTables: string[] = [];
    const missingColumns: string[] = [];
    const mismatchedColumns: string[] = [];
    const mismatchedEnums: string[] = [];
    for (const exported of Object.values(schema)) {
      if (isPgEnum(exported)) {
        const enumName = exported.enumName;
        const expectedValues = [...exported.enumValues];
        const actualValues = liveEnums.get(enumName);
        if (!actualValues) {
          mismatchedEnums.push(
            `${enumName}: missing enum type in database (expected values: ${expectedValues.join(", ")})`,
          );
          continue;
        }
        const actualSet = new Set(actualValues);
        const expectedSet = new Set(expectedValues);
        const missing = expectedValues.filter((v) => !actualSet.has(v));
        const extra = actualValues.filter((v) => !expectedSet.has(v));
        if (missing.length > 0 || extra.length > 0) {
          const parts: string[] = [];
          if (missing.length > 0)
            parts.push(`missing in database: ${missing.join(", ")}`);
          if (extra.length > 0)
            parts.push(`unexpected in database: ${extra.join(", ")}`);
          mismatchedEnums.push(`${enumName}: ${parts.join("; ")}`);
        }
        continue;
      }
      if (!(exported instanceof PgTable)) continue;
      const { name: tableName, columns } = getTableConfig(exported);
      const liveCols = live.get(tableName);
      if (!liveCols) {
        missingTables.push(tableName);
        continue;
      }
      for (const col of columns) {
        const liveCol = liveCols.get(col.name);
        if (!liveCol) {
          missingColumns.push(`${tableName}.${col.name}`);
          continue;
        }
        const expectedType = normalizeType(col.getSQLType());
        const actualType = liveTypeName(liveCol);
        if (expectedType !== actualType) {
          mismatchedColumns.push(
            `${tableName}.${col.name}: expected type ${expectedType}, database has ${actualType}`,
          );
        }
        const expectedNotNull = col.notNull;
        const actualNotNull = !liveCol.isNullable;
        if (expectedNotNull !== actualNotNull) {
          mismatchedColumns.push(
            `${tableName}.${col.name}: expected ${expectedNotNull ? "NOT NULL" : "nullable"}, database has ${actualNotNull ? "NOT NULL" : "nullable"}`,
          );
        }
      }
    }

    if (
      missingTables.length > 0 ||
      missingColumns.length > 0 ||
      mismatchedColumns.length > 0 ||
      mismatchedEnums.length > 0
    ) {
      const details = [
        ...missingTables.map((t) => `  missing table: ${t}`),
        ...missingColumns.map((c) => `  missing column: ${c}`),
        ...mismatchedColumns.map((c) => `  mismatched column: ${c}`),
        ...mismatchedEnums.map((e) => `  mismatched enum: ${e}`),
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
