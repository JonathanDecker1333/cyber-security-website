import { openDatabase } from "./lib/database.mjs";
import { runMigrations } from "./lib/migrations.mjs";

if (!process.env.DATABASE_URL) {
  throw new Error("Set DATABASE_URL to the target PostgreSQL database before running migrations.");
}

const db = await openDatabase();
try {
  await runMigrations(db);
  console.log("PostgreSQL schema migrations are up to date.");
} finally {
  await db.close();
}
