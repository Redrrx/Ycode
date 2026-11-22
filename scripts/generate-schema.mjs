import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tables } from "../src/project/tables.ts";

const schema = await generateSQLiteDrizzleJson(tables);
for (const table of Object.values(schema.tables)) {
  delete table.columns.rowid;
}
const empty = await generateSQLiteDrizzleJson({});
const statements = await generateSQLiteMigration(empty, schema);
await writeFile(
  resolve(import.meta.dirname, "../src/project/schema.json"),
  `${JSON.stringify(statements, null, 2)}\n`,
);
