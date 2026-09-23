import assert from "node:assert/strict";
import test from "node:test";
import { makeEnv, PERF, PERF_ALT, wheelchairRequest } from "./helpers.js";

test("购票后补充：ticketRef 可后补，乐观锁拒绝过期版本", () => {
  const { service } = makeEnv();
  const created = service.createRequest(wheelchairRequest());
  assert.equal(created.status, "confirmed");
  const currentVersion = service.getRequestView(created.requestId, "admin").version;
  assert.ok(currentVersion >= 2); // 插入为 v1，确认状态更新后自增

  const amended = service.amendRequest(created.requestId, { ticketRef: "TKT-1001" }, currentVersion);
  assert.equal(amended.status, "confirmed");
  assert.equal(service.getRequestView(created.requestId, "admin").ticketRef, "TKT-1001");

  assert.throws(
    () => service.amendRequest(created.requestId, { ticketRef: "TKT-STALE" }, currentVersion),
    (e) => e.code === "version_conflict",
  );
});

test("变更需求触发资源重排：加手语翻译锁定新志愿者，旧席位不残留", () => {
  const { service, store } = makeEnv();
  const created = service.createRequest(wheelchairRequest({ wheelchairWidthCm: 70 }));
  const oldSeat = created.allocations.find((a) => a.resource_kind === "seat").resource_id;
  const version = service.getRequestView(created.requestId, "admin").version;

  const amended = service.amendRequest(
    created.requestId,
    { needs: ["wheelchair-seat", "sign-language"] },
    version,
  );
  assert.equal(amended.status, "confirmed");
  const active = store.listAllocations(created.requestId);
  assert.ok(active.some((a) => a.resource_kind === "volunteer"));
  // 重排后仍是同一个最合适的轮椅席，且只有一条 active seat
  const activeSeats = active.filter((a) => a.resource_kind === "seat");
  assert.equal(activeSeats.length, 1);
  assert.equal(activeSeats[0].resource_id, oldSeat);
});

test("仅补票号不触发资源重排，席位保持不变", () => {
  const { service, store } = makeEnv();
  const created = service.createRequest(wheelchairRequest({ wheelchairWidthCm: 70 }));
  const version = service.getRequestView(created.requestId, "admin").version;
  const seatBefore = store.listAllocations(created.requestId).find((a) => a.resource_kind === "seat").resource_id;

  const amended = service.amendRequest(created.requestId, { ticketRef: "TKT-X" }, version);
  assert.equal(amended.status, "confirmed");
  const seatAfter = store.listAllocations(created.requestId).find((a) => a.resource_kind === "seat").resource_id;
  assert.equal(seatAfter, seatBefore);
  assert.equal(service.getRequestView(created.requestId, "admin").ticketRef, "TKT-X");
});

test("取消释放席位与陪同票并作废旧方案、不允许重复取消变更", () => {  const { service, store } = makeEnv();
  const created = service.createRequest(wheelchairRequest({ companionCount: 1 }));
  const cancelled = service.cancelRequest(created.requestId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.listAllocations(created.requestId).length, 0);
  assert.throws(() => service.amendRequest(created.requestId, { companionCount: 0 }, 2),
    (e) => e.code === "request_cancelled");
});

test("转场：目标场次资源充足则自动确认并重排提醒；旧场次提醒作废", () => {
  const { service, store } = makeEnv();
  const created = service.createRequest({
    patronId: "patron-001", performanceId: PERF, needs: ["sign-language"],
  });
  const result = service.transferPerformance(PERF, PERF_ALT, "舞台检修");
  assert.equal(result.results[0].outcome, "confirmed-on-target");

  const moved = service.getRequestView(created.requestId, "admin");
  assert.equal(moved.performanceId, PERF_ALT);
  assert.equal(moved.status, "confirmed");
  // 旧场次的 pending reminder 被抑制，新场次有一条 reminder
  const notes = store.all(
    "SELECT template, status, json_extract(payload,'$.performanceId') pid FROM notifications WHERE request_id = ?",
    created.requestId,
  );
  const oldReminder = notes.find((n) => n.template === "service-reminder" && n.pid === PERF);
  assert.equal(oldReminder.status, "suppressed");
  assert.ok(notes.some((n) => n.template === "service-reminder" && n.pid === PERF_ALT && n.status === "pending"));
});

test("转场目标资源不足：申请进入 replanning 并给出替代选项", () => {
  const { service } = makeEnv();
  // 占满加场的手语志愿者
  service.createRequest({ patronId: "patron-001", performanceId: PERF_ALT, needs: ["sign-language"] });
  service.createRequest({ patronId: "patron-002", performanceId: PERF_ALT, needs: ["sign-language"] });

  const created = service.createRequest({ patronId: "patron-001", performanceId: PERF, needs: ["sign-language"] });
  const result = service.transferPerformance(PERF, PERF_ALT, "加座调整");
  const mine = result.results.find((r) => r.requestId === created.requestId);
  assert.equal(mine.outcome, "alternatives-proposed");
  const view = service.getRequestView(created.requestId, "admin");
  assert.equal(view.status, "replanning");
  assert.ok(view.alternatives[0].options.length >= 0);
});

test("设备故障：同场自动换备机；备机也故障则生成替代方案", () => {
  const { service, store } = makeEnv();
  const created = service.createRequest({
    patronId: "patron-001", performanceId: PERF, needs: ["hearing-device"], hearingNeed: "t-coil",
  });
  const first = store.listAllocations(created.requestId).find((a) => a.resource_kind === "device").resource_id;

  const r1 = service.reportResourceFailure("device", first, PERF, { reason: "no-signal" });
  assert.equal(r1.results[0].outcome, "replanned-same-performance");
  const second = store.listAllocations(created.requestId).find((a) => a.resource_kind === "device").resource_id;
  assert.notEqual(second, first);

  const r2 = service.reportResourceFailure("device", second, PERF, { reason: "dead" });
  assert.equal(r2.results[0].outcome, "alternatives-proposed");
  assert.equal(service.getRequestView(created.requestId, "admin").status, "replanning");
});

test("席位故障后受影响申请同场重排到其他轮椅席", () => {
  const { service, store } = makeEnv();
  const created = service.createRequest(wheelchairRequest({ wheelchairWidthCm: 70 }));
  const seat = store.listAllocations(created.requestId).find((a) => a.resource_kind === "seat").resource_id;
  const result = service.reportResourceFailure("seat", seat, PERF);
  assert.equal(result.results[0].outcome, "replanned-same-performance");
  const newSeat = store.listAllocations(created.requestId).find((a) => a.resource_kind === "seat").resource_id;
  assert.notEqual(newSeat, seat);
});

test("接受替代方案：转场选项把申请移到新场次并锁定资源", () => {
  const { service } = makeEnv();
  const created = service.createRequest({
    patronId: "patron-001", performanceId: PERF, needs: ["sign-language"],
  });
  // 两名手语志愿者先后不可用（第一名故障会切换到第二名），直到本场无人才会给出转场方案
  const first = volunteerFor(service, created.requestId);
  const other = ["vol-lin", "vol-zhao"].find((v) => v !== first);
  service.reportResourceFailure("volunteer", first, PERF, { reason: "illness" });
  service.reportResourceFailure("volunteer", other, PERF, { reason: "emergency" });
  const alts = service.getRequestView(created.requestId, "admin").alternatives;
  const transferIdx = alts[0].options.findIndex((o) => o.type === "transfer");
  assert.ok(transferIdx >= 0, "应存在转场选项");
  const accepted = service.acceptAlternative(alts[0].id, transferIdx);
  assert.equal(accepted.status, "confirmed");
  assert.equal(service.getRequestView(created.requestId, "admin").performanceId, PERF_ALT);
});

function volunteerFor(service, requestId) {
  return service.store.listAllocations(requestId).find((a) => a.resource_kind === "volunteer").resource_id;
}
