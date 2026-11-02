import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export function createPool(env = process.env) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const databaseUrl = new URL(env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL.");
  }
  if (env.NODE_ENV === "production" && env.DATABASE_SSL === "disable") {
    throw new Error("DATABASE_SSL=disable is not permitted in production.");
  }
  const sslDisabled = env.DATABASE_SSL === "disable";
  databaseUrl.searchParams.set("sslmode", sslDisabled ? "disable" : "verify-full");

  const configuredMax = Number(env.DATABASE_POOL_MAX || 5);
  if (!Number.isInteger(configuredMax) || configuredMax < 1 || configuredMax > 20) {
    throw new Error("DATABASE_POOL_MAX must be an integer from 1 to 20.");
  }
  const pool = new Pool({
    connectionString: databaseUrl.toString(),
    ssl: sslDisabled ? false : { rejectUnauthorized: true },
    max: configuredMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true
  });
  pool.on("error", error => console.error("Database pool error:", error.code || error.name));
  return pool;
}

export async function migrateDatabase(pool) {
  const migrationNames = (await readdir(migrationsDirectory))
    .filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(1280195151, 1)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const appliedRows = await client.query("SELECT version FROM schema_migrations");
    const applied = new Set(appliedRows.rows.map(row => row.version));
    for (const name of migrationNames) {
      if (applied.has(name)) continue;
      const sql = await readFile(join(migrationsDirectory, name), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [name]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
