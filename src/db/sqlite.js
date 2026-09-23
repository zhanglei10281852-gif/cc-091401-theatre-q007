import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

// 在 IMMEDIATE 事务中执行写入；遇到 BUSY / 资源竞争时整体重试。
// node:sqlite 同步执行，事务内不会穿插其他请求。
export function withTransaction(db, fn, retries = 8) {
  let attempt = 0;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      const busy = error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED";
      const race = error?.code === "SQLITE_CONSTRAINT_TRIGGER" || error?.race;
      if ((busy || race) && attempt < retries) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
}

export { SCHEMA_SQL } from "./schema.js";
