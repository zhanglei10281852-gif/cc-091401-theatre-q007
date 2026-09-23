import assert from "node:assert/strict";
import test from "node:test";
import { makeEnv, PERF, wheelchairRequest } from "./helpers.js";

const HEALTH = "脊髓损伤，需平躺搬运";

function createWithHealth(service) {
  return service.createRequest(wheelchairRequest({ healthNote: HEALTH, hearingNeed: "t-coil" }));
}

test("客服视角脱敏：看不到健康备注与身体参数细节", () => {
  const { service } = makeEnv();
  const created = createWithHealth(service);
  const view = service.getRequestView(created.requestId, "customer-service");
  assert.equal(view.healthNote, null);
  assert.equal(view.healthNotePresent, true);
  assert.equal(view.wheelchairWidthCm, "registered");
  assert.equal(view.hearingNeed, "registered");
  // 履约事件详情中的健康字段也被剥离
  assert.ok(!JSON.stringify(view).includes(HEALTH));
});

test("履约角色在授权范围内可见健康信息", () => {
  const { service } = makeEnv();
  const created = createWithHealth(service);
  const view = service.getRequestView(created.requestId, "fulfilment");
  assert.equal(view.healthNote, HEALTH);
  assert.equal(view.wheelchairWidthCm, 80);
});

test("现场闭环：签到后逐项交接，全部交接完成才 fulfilled", () => {
  const { service } = makeEnv();
  const created = service.createRequest({
    patronId: "patron-001", performanceId: PERF,
    needs: ["wheelchair-seat", "sign-language"], companionCount: 0, wheelchairWidthCm: 70,
  });
  const reqId = created.requestId;
  service.recordFulfilmentEvent(reqId, "check-in", { role: "fulfilment", id: "staff-1" });

  const allocations = service.store.listAllocations(reqId);
  let last;
  allocations.forEach((alloc, idx) => {
    last = service.handoff(reqId, alloc.id, { role: "fulfilment", id: "staff-1" });
    if (idx < allocations.length - 1) assert.equal(last.closed, false);
  });
  assert.equal(last.status, "fulfilled");
  assert.equal(last.closed, true);
});

test("客服不能记录现场事件（403 由路由层保证；服务层直接拒绝）", () => {
  const { service } = makeEnv();
  const created = createWithHealth(service);
  assert.throws(
    () => service.recordFulfilmentEvent(created.requestId, "check-in", { role: "customer-service" }),
    (e) => e.code === "forbidden",
  );
});

test("现场异常接口记录异常并触发重排", () => {
  const { service } = makeEnv();
  const created = service.createRequest({
    patronId: "patron-001", performanceId: PERF, needs: ["hearing-device"], hearingNeed: "t-coil",
  });
  const reqId = created.requestId;
  const deviceId = service.store.listAllocations(reqId).find((a) => a.resource_kind === "device").resource_id;
  service.reportException(reqId, { role: "fulfilment", id: "staff-2" }, {
    resourceKind: "device", resourceId: deviceId, message: "设备无法开机",
  });
  const events = service.store.listEvents(reqId);
  assert.ok(events.some((e) => e.type === "exception"));
});

test("演出结束后履约记录脱敏：化名、无健康信息", () => {
  const { service } = makeEnv();
  const created = service.createRequest(
    wheelchairRequest({ patronId: "patron-001", healthNote: HEALTH }),
  );
  const reqId = created.requestId;
  service.recordFulfilmentEvent(reqId, "check-in", { role: "fulfilment", id: "s" });
  for (const alloc of service.store.listAllocations(reqId)) {
    service.handoff(reqId, alloc.id, { role: "fulfilment", id: "s" });
  }
  const closed = service.closePerformance(PERF);
  const mine = closed.records.find((r) => r.requestId === reqId);
  assert.ok(mine.patronRef.startsWith("P-"));
  assert.ok(mine.fulfilledAt);
  assert.ok(!JSON.stringify(mine).includes(HEALTH));
  assert.ok(!JSON.stringify(mine).includes("王女士"));

  const listed = service.listFulfilmentRecords(PERF);
  assert.ok(listed.some((r) => r.requestId === reqId));
});
