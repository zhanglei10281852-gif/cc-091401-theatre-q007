import assert from "node:assert/strict";
import { createContainer } from "../src/container.js";
import { seed } from "./seed.js";

const container = createContainer({ dbPath: ".runtime/smoke.db" });
const { service, store } = container;

// 1) 轮椅席（宽 90cm）+1 陪同 + 手语 + 助听
const r1 = service.createRequest({
  patronId: "patron-001", performanceId: "perf-2026-12-03-02",
  needs: ["wheelchair-seat", "sign-language", "hearing-device"],
  companionCount: 1, hearingNeed: "t-coil", wheelchairWidthCm: 90,
  healthNote: "脊髓损伤，需平躺搬运", notificationPrefs: ["sms"],
});
assert.equal(r1.status, "confirmed");
const reqId = r1.requestId;
console.log("R1 confirmed:", r1.allocations.map((a) => `${a.resource_kind}:${a.resource_id}@${a.status}`));

// 2) 并发第二单：≥90cm 的轮椅席只剩 A-access-01(95) 已被占 -> 过道约束失败并给出转场方案
const r2 = service.createRequest({
  patronId: "patron-002", performanceId: "perf-2026-12-03-02",
  needs: ["wheelchair-seat", "sign-language", "hearing-device"],
  companionCount: 1, hearingNeed: "t-coil", wheelchairWidthCm: 90,
});
console.log("R2:", r2.status, JSON.stringify(r2.violations?.map((v) => v.code)));
assert.equal(r2.status, "submitted");
assert.ok(r2.violations.some((v) => v.code === "aisle_width_unsatisfied"));
assert.ok(r2.alternatives.some((o) => o.type === "transfer" && o.performanceId === "perf-2026-12-04-02"));
console.log("R2 alternatives:", r2.alternatives.map((o) => `${o.type}:${o.performanceId ?? o.deviceId ?? ""}`));

// 3) 过道净宽硬约束：轮椅宽 95cm 应失败
const r3 = service.createRequest({
  patronId: "patron-001", performanceId: "perf-2026-12-03-02",
  needs: ["wheelchair-seat"], companionCount: 0, wheelchairWidthCm: 95,
});
console.log("R3:", r3.status, r3.violations?.map((v) => v.code));
assert.ok(r3.violations.some((v) => v.code === "aisle_width_unsatisfied"));

// 4) 隐私：客服看不到 healthNote
const csView = service.getRequestView(r1.requestId, "customer-service");
assert.equal(csView.healthNote, null);
assert.equal(csView.healthNotePresent, true);
const ffView = service.getRequestView(r1.requestId, "fulfilment");
assert.equal(ffView.healthNote, "脊髓损伤，需平躺搬运");
console.log("privacy OK");

// 5) 故障：r1 的设备故障 -> 同场有备用 t-coil 设备，自动重排
const deviceAlloc = () => store.listAllocations(reqId).find((a) => a.resource_kind === "device");
const fail1 = service.reportResourceFailure("device", deviceAlloc().resource_id, "perf-2026-12-03-02", { reason: "no-signal" });
console.log("failure 1:", fail1.results[0].outcome, "->", deviceAlloc().resource_id);
assert.equal(fail1.results[0].outcome, "replanned-same-performance");
assert.notEqual(deviceAlloc().resource_id, "dev-loop-1");

// 备用设备也故障 -> 同场无兼容设备，给出字幕替代/候补方案
const fail2 = service.reportResourceFailure("device", deviceAlloc().resource_id, "perf-2026-12-03-02", { reason: "dead-battery" });
assert.equal(fail2.results[0].outcome, "alternatives-proposed");
console.log("failure 2:", fail2.results[0].outcome);

// 6) 接受字幕替代服务
const alts = service.getRequestView(reqId, "fulfilment").alternatives;
const sub = alts[0];
const subOption = sub.options.findIndex((o) => o.type === "substitute_service");
console.log("accept substitute option index:", subOption);
assert.ok(subOption >= 0);
const acc = service.acceptAlternative(sub.id, subOption);
console.log("accepted:", acc.status, acc.option.type, acc.option.deviceId);
assert.equal(acc.status, "confirmed");

// 7) 现场闭环：签到 + 逐项交接
service.recordFulfilmentEvent(reqId, "check-in", { role: "fulfilment", id: "staff-1" });
let remaining;
for (const alloc of store.listAllocations(reqId)) {
  const res = service.handoff(reqId, alloc.id, { role: "fulfilment", id: "staff-1" });
  remaining = res;
}
assert.equal(remaining.status, "fulfilled");
console.log("fulfilled OK");

// 8) 关场 -> 脱敏记录
const closed = service.closePerformance("perf-2026-12-03-02");
const rec = closed.records.find((x) => x.requestId === reqId);
assert.ok(rec.fulfilledAt);
assert.ok(rec.patronRef.startsWith("P-"));
assert.ok(!JSON.stringify(rec).includes("脊髓损伤"));
console.log("record:", rec.patronRef, rec.summary);

// 9) 通知幂等：同一指纹连续两次调度，第二次被抑制
const payload = { variant: "create" };
const count = () => store.all("SELECT count(*) c FROM notifications WHERE request_id = ?", reqId)[0].c;
const before = count();
service._notify(store.getRequest(reqId), "request-confirmed", new Date().toISOString(), payload);
service._notify(store.getRequest(reqId), "request-confirmed", new Date().toISOString(), payload);
assert.equal(count(), before + 1);
console.log("notification idempotent OK");

container.db.close();
console.log("SMOKE OK");
