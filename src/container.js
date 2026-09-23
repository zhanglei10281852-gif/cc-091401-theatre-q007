// 组合根：打开数据库、装配 Store / Service / 通知分发器。
import { openDatabase } from "./db/sqlite.js";
import { SCHEMA_SQL } from "./db/schema.js";
import { Store } from "./db/store.js";
import { AccessibilityService } from "./services/accessibility.js";
import { createNotificationDispatcher } from "./services/notifications.js";

export function createContainer({ dbPath = process.env.DB_PATH ?? ".runtime/theatre.db", clock, sender } = {}) {
  const db = openDatabase(dbPath);
  db.exec(SCHEMA_SQL);
  const store = new Store(db);
  const effectiveClock = clock ?? (() => new Date());
  const service = new AccessibilityService(store, { clock: effectiveClock });
  const dispatcher = createNotificationDispatcher(store, { send: sender, clock: effectiveClock });
  return { db, store, service, dispatcher };
}
