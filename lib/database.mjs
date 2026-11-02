import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function sqliteDatabase() {
  const dbPath = process.env.MARKET_DB_PATH || resolve(root, "data", "salonemarket.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,store_name TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',fee_percent REAL,role TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'approved',salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,last_activity INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,vendor_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,price REAL NOT NULL,currency TEXT NOT NULL,stock INTEGER NOT NULL,image TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS product_vendor_idx ON products(vendor_id,active);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES('commission_percent','5');
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES users(id),customer_name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,city TEXT NOT NULL,currency TEXT NOT NULL,gross REAL NOT NULL,commission REAL NOT NULL,vendor_net REAL NOT NULL,payment_method TEXT NOT NULL,payment_status TEXT NOT NULL,status TEXT NOT NULL,tx_ref TEXT UNIQUE,free_delivery INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS order_items(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),product_id TEXT NOT NULL REFERENCES products(id),vendor_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price REAL NOT NULL,currency TEXT NOT NULL,commission REAL NOT NULL,vendor_net REAL NOT NULL,fulfillment_status TEXT NOT NULL DEFAULT 'placed');
    CREATE INDEX IF NOT EXISTS order_item_vendor_idx ON order_items(vendor_id,order_id);
    CREATE TABLE IF NOT EXISTS payouts(id TEXT PRIMARY KEY,vendor_id TEXT NOT NULL REFERENCES users(id),amount REAL NOT NULL,currency TEXT NOT NULL,method TEXT NOT NULL,destination TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS contact_messages(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,topic TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS vendor_promotions(user_id TEXT PRIMARY KEY REFERENCES users(id),slot INTEGER NOT NULL UNIQUE,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS delivery_promotions(user_id TEXT PRIMARY KEY REFERENCES users(id),order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),status TEXT NOT NULL CHECK(status IN('reserved','redeemed')),claimed_at INTEGER NOT NULL);
  `);
  const ensureColumn = (table, name, definition) => {
    if (!sqlite.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  ensureColumn("users", "phone", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("users", "fee_percent", "REAL");
  ensureColumn("orders", "free_delivery", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("order_items", "fulfillment_status", "TEXT NOT NULL DEFAULT 'placed'");

  const prepare = sql => ({
    get: async (...params) => sqlite.prepare(sql).get(...params),
    all: async (...params) => sqlite.prepare(sql).all(...params),
    run: async (...params) => {
      const result = sqlite.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
  });
  return {
    dialect: "sqlite",
    prepare,
    exec: sql => sqlite.exec(sql),
    transaction: async callback => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = await callback({ prepare });
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close: async () => sqlite.close(),
  };
}

function postgresDatabase(pool) {
  const adapt = client => {
    const normalize = result => {
      const numericColumns = new Set(result.fields.filter(field => [20, 21, 23, 700, 701, 1700].includes(field.dataTypeID)).map(field => field.name));
      return result.rows.map(row => {
        for (const column of numericColumns) {
          if (row[column] !== null && row[column] !== undefined) row[column] = Number(row[column]);
        }
        return row;
      });
    };
    const prepare = sql => {
      const statement = sql.replace(/\?/g, (_, offset) => `$${(sql.slice(0, offset).match(/\?/g) || []).length + 1}`);
      return {
        get: async (...params) => {
          const result = await client.query(statement, params);
          return normalize(result)[0];
        },
        all: async (...params) => {
          const result = await client.query(statement, params);
          return normalize(result);
        },
        run: async (...params) => {
          const result = await client.query(statement, params);
          return { changes: result.rowCount };
        },
      };
    };
    return { prepare };
  };
  return {
    dialect: "postgres",
    prepare: sql => adapt(pool).prepare(sql),
    exec: sql => pool.query(sql),
    transaction: async callback => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = adapt(client);
        tx.exec = sql => client.query(sql);
        const result = await callback(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    pool,
    close: () => pool.end(),
  };
}

export async function openDatabase() {
  if (!process.env.DATABASE_URL) return sqliteDatabase();
  const url = new URL(process.env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use the postgres:// or postgresql:// scheme.");
  }
  const sslMode = process.env.PGSSLMODE?.toLowerCase();
  if (sslMode && !["disable", "require", "verify-ca", "verify-full"].includes(sslMode)) {
    throw new Error("PGSSLMODE must be disable, require, verify-ca, or verify-full.");
  }
  if (sslMode === "disable" && process.env.NODE_ENV === "production") {
    throw new Error("PGSSLMODE=disable is not permitted in production.");
  }
  const max = Number(process.env.PG_POOL_MAX || 10);
  if (!Number.isInteger(max) || max < 1 || max > 20) {
    throw new Error("PG_POOL_MAX must be an integer from 1 to 20.");
  }
  // Supabase URIs often include sslmode=require, which node-postgres treats as
  // disabling certificate verification; TLS policy is configured explicitly below.
  url.searchParams.delete("sslmode");
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: url.toString(),
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
    ssl: sslMode === "disable" ? false : { rejectUnauthorized: true },
    application_name: "e-market",
  });
  pool.on("error", error => console.error("Unexpected idle PostgreSQL client error:", error));
  return postgresDatabase(pool);
}
