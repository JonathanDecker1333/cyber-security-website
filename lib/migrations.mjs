import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationDirectory = join(dirname(dirname(fileURLToPath(import.meta.url))), "schema", "migrations");

export async function runMigrations(db) {
  if (db.dialect !== "postgres") return;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const files = (await readdir(migrationDirectory)).filter(file => file.endsWith(".sql")).sort();
  for (const file of files) {
    await db.transaction(async tx => {
      await tx.exec("SELECT pg_advisory_xact_lock(hashtext('e-market-schema-migrations'))");
      if (await tx.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(file)) return;
      await tx.exec(await readFile(join(migrationDirectory, file), "utf8"));
      await tx.prepare("INSERT INTO schema_migrations(version) VALUES(?)").run(file);
    });
  }
}
