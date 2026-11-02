import { createPool, migrateDatabase } from "../database.mjs";

const pool = createPool();
try {
  await migrateDatabase(pool);
  console.log("Database migrations are up to date.");
} finally {
  await pool.end();
}
