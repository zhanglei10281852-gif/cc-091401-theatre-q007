import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainer } from "../src/container.js";
import { seed } from "../scripts/seed.js";
import { makeEnv, PERF } from "./helpers.js";

function freshDbPath() {
  return join(mkdtempSync(join(tmpdir(), "theatre-ntf-")), "theatre.db");
}

test("通知去重：同一事件重复触发不重复打扰", () => {
  const { service, store } = makeEnv();
  const created = service.createRequest({
    patronId: "patron-001", performanceId: PERF, needs: ["sign-language"],
  });
  const req = store.getRequest(created.requestId);
  const count = () => store.all("SELECT count(*) c FROM notifications WHERE request_id = ?", req.id)[0].c;
  const n = count();
  const payload = { variant: "create" };
  service._notify(req, "request-confirmed", new Date().toISOString(), payload);
  service._notify(req, "request-confirmed", new Date().toISOString(), payload);
  service._notify(req, "request-confirmed", new Date().toISOString(), payload);
  assert.equal(count(), n + 1);
});

test("重启后未发送提醒按原截止点继续（scheduled_for 持久化）", async () => {
  const path = freshDbPath();
  const c1 = createContainer({ dbPath: path });
  seed(c1.store);
  c1.service.createRequest({ patronId: "patron-001", performanceId: PERF, needs: ["sign-language"] });
  c1.db.close();

  // 截止点为开场前 1 小时：2026-12-03 18:30+08:00 = 10:30Z。时钟拨到 11:00Z，应补发且截止点不变。
  const future = new Date("2026-12-03T11:00:00Z");
  const sent = [];
  const c2 = createContainer({ dbPath: path, clock: () => future, sender: async (n) => sent.push(n) });
  const results = await c2.dispatcher.flushDue();
  assert.ok(results.some((r) => r.status === "sent"));
  const reminder = sent.find((n) => n.template === "service-reminder");
  assert.ok(reminder);
  assert.equal(reminder.scheduled_for, "2026-12-03T10:30:00.000Z");
  c2.db.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("已发送的通知重启后不再发送", async () => {
  const path = freshDbPath();
  const c1 = createContainer({ dbPath: path });
  seed(c1.store);
  c1.service.createRequest({ patronId: "patron-001", performanceId: PERF, needs: ["sign-language"] });
  c1.db.close();

  const sent = [];
  const future = new Date("2026-12-03T11:00:00Z");
  const c2 = createContainer({ dbPath: path, clock: () => future, sender: async (n) => sent.push(n) });
  await c2.dispatcher.flushDue();
  assert.equal(sent.filter((n) => n.template === "service-reminder").length, 1);
  // 再次 flush 不重复发送
  await c2.dispatcher.flushDue();
  const stored = c2.store.all("SELECT count(*) c FROM notifications WHERE template='service-reminder' AND status='sent'");
  assert.equal(stored[0].c, 1);
  c2.db.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});
