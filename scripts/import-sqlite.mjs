import { DatabaseSync } from "node:sqlite";
import { createPool, migrateDatabase } from "../database.mjs";

const sourcePath = process.env.SQLITE_IMPORT_PATH;
if (!sourcePath) throw new Error("Set SQLITE_IMPORT_PATH to the existing SQLite database file.");

const source = new DatabaseSync(sourcePath, { readOnly: true });
const pool = createPool();
const tables = ["teachers", "sessions", "students", "student_shares", "reports", "school_logos"];
const importedCounts = {};

try {
  await migrateDatabase(pool);
  const rows = Object.fromEntries(tables.map(table => [table, source.prepare(`SELECT * FROM ${table}`).all()]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const targetCounts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM teachers) AS teachers,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM students) AS students,
        (SELECT COUNT(*) FROM student_shares) AS student_shares,
        (SELECT COUNT(*) FROM reports) AS reports,
        (SELECT COUNT(*) FROM school_logos) AS school_logos
    `);
    if (Object.values(targetCounts.rows[0]).some(count => Number(count) !== 0)) {
      throw new Error("SQLite import requires an empty PostgreSQL application database.");
    }

    const definitions = {
      teachers: {
        columns: ["id", "display_name", "username", "school_name", "salt", "password_hash", "created_at"],
        values: row => [row.id, row.display_name, row.username, row.school_name || "", row.salt, row.password_hash, row.created_at]
      },
      sessions: {
        columns: ["token_hash", "teacher_id", "last_activity"],
        values: row => [row.token_hash, row.teacher_id, row.last_activity]
      },
      students: {
        columns: ["id", "owner_id", "school", "student_name", "age", "class_name", "district", "guardian_name", "guardian_phone", "guardian_email", "created_at"],
        values: row => [row.id, row.owner_id, row.school, row.student_name, row.age, row.class_name, row.district, row.guardian_name, row.guardian_phone, row.guardian_email || "", row.created_at]
      },
      student_shares: {
        columns: ["student_id", "teacher_id", "permission", "granted_by", "created_at"],
        values: row => [row.student_id, row.teacher_id, row.permission, row.granted_by, row.created_at]
      },
      reports: {
        columns: ["id", "student_id", "created_by", "student_name", "class_name", "school", "term", "academic_year", "scores_json", "total", "average", "teacher_name", "head_teacher_name", "created_at"],
        values: row => [row.id, row.student_id, row.created_by, row.student_name, row.class_name, row.school, row.term, row.academic_year, row.scores_json, row.total, row.average, row.teacher_name || "", row.head_teacher_name || "", row.created_at]
      },
      school_logos: {
        columns: ["school_name", "school_name_key", "mime_type", "image_data", "created_by", "updated_at"],
        values: row => [row.school_name, row.school_name.toLowerCase(), row.mime_type, Buffer.from(row.image_data), row.created_by, row.updated_at]
      }
    };

    for (const table of tables) {
      const { columns, values } = definitions[table];
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      const insert = `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${placeholders})`;
      for (const row of rows[table]) await client.query(insert, values(row));
      importedCounts[table] = rows[table].length;
    }

    const yearlyCounters = new Map();
    for (const student of rows.students) {
      const match = /^SL-(\d{4})-(\d+)$/.exec(student.id);
      if (!match) continue;
      const year = Number(match[1]);
      const value = Number(match[2]);
      yearlyCounters.set(year, Math.max(yearlyCounters.get(year) || 0, value));
    }
    for (const [year, lastValue] of yearlyCounters) {
      await client.query("INSERT INTO student_id_counters(year, last_value) VALUES ($1, $2)", [year, lastValue]);
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('teachers', 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0) FROM teachers`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log(`SQLite import complete: ${Object.entries(importedCounts).map(([table, count]) => `${table}=${count}`).join(", ")}.`);
} finally {
  source.close();
  await pool.end();
}
