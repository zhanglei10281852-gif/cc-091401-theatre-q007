import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { seed } from "../scripts/seed.js";
import { PERF } from "./helpers.js";

async function startServer(container, context) {
  const server = createApp(container);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    container.db.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}` };
}

async function api(base, method, path, body, role) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(role ? { "x-role": role } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

test("健康检查", async (context) => {
  const container = createContainer({ dbPath: ":memory:" });
  const { base } = await startServer(container, context);
  const { status, json } = await api(base, "GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.service, "theatre-accessibility");
});

test("完整 HTTP 流程：录入→申请→客服脱敏→现场闭环→关场记录", async (context) => {
  const container = createContainer({ dbPath: ":memory:" });
  seed(container.store);
  const { base } = await startServer(container, context);

  const created = await api(base, "POST", "/requests", {
    patronId: "patron-001", performanceId: PERF,
    needs: ["wheelchair-seat", "sign-language"],
    companionCount: 1, wheelchairWidthCm: 80,
    healthNote: "需平躺搬运",
  }, "customer-service");
  assert.equal(created.status, 201);
  assert.equal(created.json.status, "confirmed");
  const reqId = created.json.requestId;

  // 默认角色（无 x-role）即客服最小视角，看不到健康信息
  const csView = await api(base, "GET", `/requests/${reqId}`);
  assert.equal(csView.json.healthNote, null);
  assert.equal(csView.json.healthNotePresent, true);

  // 客服不能签到
  const denied = await api(base, "POST", `/requests/${reqId}/check-in`, { actorId: "s1" }, "customer-service");
  assert.equal(denied.status, 403);

  // 履约角色签到并逐项交接
  await api(base, "POST", `/requests/${reqId}/check-in`, { actorId: "s1" }, "fulfilment");
  let last;
  for (const alloc of csView.json.allocations) {
    last = await api(base, "POST", `/requests/${reqId}/handoff`,
      { actorId: "s1", allocationId: alloc.id }, "fulfilment");
  }
  assert.equal(last.json.status, "fulfilled");

  // 关场后查询脱敏记录
  const closed = await api(base, "POST", `/performances/${PERF}/close`, {}, "admin");
  assert.equal(closed.status, 200);
  const records = await api(base, "GET", `/performances/${PERF}/fulfilment-records`);
  const mine = records.json.records.find((r) => r.requestId === reqId);
  assert.ok(mine.patronRef.startsWith("P-"));
  assert.ok(!JSON.stringify(mine).includes("平躺搬运"));
});

test("乐观锁冲突返回 409", async (context) => {
  const container = createContainer({ dbPath: ":memory:" });
  seed(container.store);
  const { base } = await startServer(container, context);
  const created = await api(base, "POST", "/requests", {
    patronId: "patron-001", performanceId: PERF, needs: ["sign-language"],
  }, "customer-service");
  const reqId = created.json.requestId;
  const version = created.json.version; // 确认后已自增（>=2）
  const amended = await api(base, "PATCH", `/requests/${reqId}`, { version, ticketRef: "T1" }, "customer-service");
  assert.equal(amended.status, 200);
  const stale = await api(base, "PATCH", `/requests/${reqId}`, { version, ticketRef: "T2" }, "customer-service");
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, "version_conflict");
});

test("并发 HTTP 申请不会重复占用同一席位", async (context) => {
  const container = createContainer({ dbPath: ":memory:" });
  seed(container.store);
  const { base } = await startServer(container, context);

  const bodies = [1, 2, 3, 4, 5].map((i) => ({
    patronId: i === 1 ? "patron-001" : "patron-002",
    performanceId: PERF, needs: ["wheelchair-seat"], wheelchairWidthCm: 70,
  }));
  const responses = await Promise.all(bodies.map((body) => api(base, "POST", "/requests", body, "customer-service")));
  const confirmed = responses.filter((r) => r.json.status === "confirmed");
  assert.equal(confirmed.length, 4);
  const seats = confirmed.flatMap((r) =>
    r.json.allocations.filter((a) => a.resourceKind === "seat").map((a) => a.resourceId));
  assert.equal(new Set(seats).size, seats.length);

  const failed = responses.find((r) => r.json.status === "submitted");
  assert.ok(failed.json.violations.some((v) => v.code === "aisle_width_unsatisfied"));
});

test("资源故障与替代方案接受的 HTTP 闭环", async (context) => {
  const container = createContainer({ dbPath: ":memory:" });
  seed(container.store);
  const { base } = await startServer(container, context);
  const created = await api(base, "POST", "/requests", {
    patronId: "patron-001", performanceId: PERF, needs: ["hearing-device"], hearingNeed: "t-coil",
  }, "customer-service");
  const reqId = created.json.requestId;
  const deviceId = created.json.allocations.find((a) => a.resourceKind === "device").resourceId;

  const failure = await api(base, "POST", "/resource-failures",
    { kind: "device", resourceId: deviceId, performanceId: PERF, detail: { reason: "x" } }, "fulfilment");
  assert.equal(failure.json.results[0].outcome, "replanned-same-performance");

  // 备机再故障 -> 替代方案（履约视角的分配为 snake_case）
  const view = await api(base, "GET", `/requests/${reqId}`, undefined, "fulfilment");
  const backup = view.json.allocations.find((a) => a.resourceKind === "device").resourceId;
  await api(base, "POST", "/resource-failures",
    { kind: "device", resourceId: backup, performanceId: PERF }, "fulfilment");
  const view2 = await api(base, "GET", `/requests/${reqId}`, undefined, "fulfilment");
  const alt = view2.json.alternatives[0];
  const idx = alt.options.findIndex((o) => o.type === "substitute_service");
  const accepted = await api(base, "POST", `/alternatives/${alt.id}/accept`,
    { optionIndex: idx, version: view2.json.version }, "customer-service");
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.status, "confirmed");
});
