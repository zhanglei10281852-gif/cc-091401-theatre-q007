import assert from "node:assert/strict";
import test from "node:test";
import { makeEnv, PERF, PERF_ALT, wheelchairRequest } from "./helpers.js";

test("过道净宽满足时锁定轮椅席，不满足时给出可解释违规", () => {
  const { service } = makeEnv();

  const ok = service.createRequest(wheelchairRequest({ wheelchairWidthCm: 70 }));
  assert.equal(ok.status, "confirmed");
  const seat = ok.allocations.find((a) => a.resource_kind === "seat");
  assert.ok(seat);

  // 全部轮椅席最大过道净宽 95；96cm 无法安排
  const fail = service.createRequest(wheelchairRequest({
    patronId: "patron-002", wheelchairWidthCm: 96,
  }));
  assert.equal(fail.status, "submitted");
  assert.equal(fail.violations[0].code, "aisle_width_unsatisfied");
  assert.equal(fail.violations[0].requiredAisleWidthCm, 96);
});

test("陪同人数受相邻陪同席与陪同票余量双重硬约束", () => {
  const { service } = makeEnv();

  // A-access-02 只有 1 个相邻陪同位；申请 2 人应失败（即使先占 02）
  const one = service.createRequest(wheelchairRequest({
    wheelchairWidthCm: 88, companionCount: 1,
  }));
  assert.equal(one.status, "confirmed");

  const two = service.createRequest(wheelchairRequest({
    patronId: "patron-002", wheelchairWidthCm: 80, companionCount: 2,
  }));
  assert.equal(two.status, "submitted");
  assert.ok(two.violations.some((v) => v.code === "adjacent_companion_unavailable"));
  // 替代方案含减少陪同/候补/转场
  const types = two.alternatives.map((o) => o.type);
  assert.ok(types.includes("reduce_companions"));
  assert.ok(types.includes("waitlist"));
});

test("陪同票总余量耗尽时拒绝并退款一致", () => {
  const { service, store } = makeEnv();
  // 本场陪同票总量 4：2（席01）+1（席02）+1（席03）= 4
  const a = service.createRequest(wheelchairRequest({ companionCount: 2 }));
  assert.equal(a.status, "confirmed");
  const b = service.createRequest(wheelchairRequest({
    patronId: "patron-002", wheelchairWidthCm: 88, companionCount: 1,
  }));
  assert.equal(b.status, "confirmed");
  const c = service.createRequest({
    patronId: "patron-001", performanceId: PERF, needs: ["wheelchair-seat"],
    companionCount: 1, wheelchairWidthCm: 80,
  });
  assert.equal(c.status, "confirmed");
  assert.equal(store.getCompanionQuota(PERF).total, 0);

  const d = service.createRequest(wheelchairRequest({ companionCount: 1 }));
  assert.ok(d.violations.some((v) => v.code === "companion_quota_exceeded"));

  // 取消后陪同票回补
  service.cancelRequest(b.requestId);
  assert.equal(store.getCompanionQuota(PERF).total, 1);
});

test("设备兼容性：t-coil 需求不会分配给蓝牙设备", () => {
  const { service } = makeEnv();
  const r = service.createRequest({
    patronId: "patron-001", performanceId: PERF,
    needs: ["hearing-device"], hearingNeed: "t-coil",
  });
  assert.equal(r.status, "confirmed");
  assert.equal(r.allocations.find((a) => a.resource_kind === "device").resource_id, "dev-loop-1");

  const r2 = service.createRequest({
    patronId: "patron-002", performanceId: PERF,
    needs: ["hearing-device"], hearingNeed: "t-coil",
  });
  // t-coil 设备（含 -alt 共 2 台）——第二台可用
  assert.equal(r2.status, "confirmed");
  assert.equal(r2.allocations.find((a) => a.resource_kind === "device").resource_id, "dev-loop-1-alt");
});

test("手语翻译按技能与班次锁定，第二人耗尽则失败", () => {
  const { service } = makeEnv();
  const a = service.createRequest({
    patronId: "patron-001", performanceId: PERF, needs: ["sign-language"],
  });
  const b = service.createRequest({
    patronId: "patron-002", performanceId: PERF, needs: ["sign-language"],
  });
  assert.equal(a.status, "confirmed");
  assert.equal(b.status, "confirmed");

  const c = service.createRequest({
    patronId: "patron-001", performanceId: PERF, needs: ["sign-language"], healthNote: "x",
  });
  assert.equal(c.status, "submitted");
  assert.ok(c.violations.some((v) => v.code === "sign_language_unavailable"));
  // 可解释替代：转场或字幕设备
  assert.ok(c.alternatives.some((o) => o.type === "transfer" || o.type === "substitute_service"));
});

test("并发申请不会占用同一席位（唯一索引兜底，竞争方重试）", async () => {
  const { service } = makeEnv();
  const inputs = [1, 2, 3, 4, 5].map((i) => () => service.createRequest(wheelchairRequest({
    patronId: i === 1 ? "patron-001" : "patron-002",
    wheelchairWidthCm: 70,
  })));
  // 同步 node:sqlite 下事务串行；这里用 Promise 模拟并发入口，结果必须无重复 resource_id
  const results = await Promise.allSettled(inputs.map((fn) => Promise.resolve().then(fn)));
  const seatIds = results
    .filter((r) => r.status === "fulfilled" && r.value.status === "confirmed")
    .flatMap((r) => r.value.allocations.filter((a) => a.resource_kind === "seat").map((a) => a.resource_id));
  assert.equal(new Set(seatIds).size, seatIds.length);
  assert.equal(seatIds.length, 4); // 本场恰好 4 个轮椅席
});
