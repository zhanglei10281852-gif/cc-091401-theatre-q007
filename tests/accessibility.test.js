import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { JsonStore } from "../src/store/json-store.js";
import { enqueue, deliverDue } from "../src/services/notify.js";

const EVENING = "perf-2026-12-03-02";
const MATINEE = "perf-2026-12-03-01";
const NEXT_DAY = "perf-2026-12-04-01";

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "acc-"));
  const store = new JsonStore(join(dir, "state.json"));
  await store.ready;
  const server = createApp(store);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, body, role) {
    const headers = { "content-type": "application/json" };
    if (role) headers["x-role"] = role;
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  }

  return {
    store,
    call,
    shutdown: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function patronRequest(overrides = {}) {
  return {
    performanceId: EVENING,
    ticketRef: "T-1001",
    patronId: "P-0001",
    patron: { name: "张观众", contact: { phone: "13800001234", email: "zhang@example.com" } },
    mobility: "wheelchair",
    companionCount: 1,
    signLanguageNeeded: false,
    hearingAssistanceNeeded: false,
    consentScopes: ["need.mobility", "contact.notify", "health.note"],
    healthNote: "需要平缓坡道，无电梯恐惧",
    ...overrides,
  };
}

test("创建申请：锁定轮椅位与相邻陪同席并生成确认通知", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  const { status, json } = await h.call("POST", "/requests", patronRequest());
  assert.equal(status, 201);
  assert.equal(json.request.status, "confirmed");
  assert.equal(json.request.plan.seatId, "WC-A-1");
  assert.deepEqual(json.request.plan.companionSeatIds, ["C-A-1a"]);
  assert.ok(json.request.plan.shiftId, "应排入覆盖场次的志愿者班次");

  const notes = await h.call("GET", "/notifications?audience=patron");
  const types = notes.json.notifications.map((n) => n.type);
  assert.ok(types.includes("confirmation"));
});

test("硬约束：陪同人数超过相邻陪同席容量被拒，返回可解释原因", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  const { status, json } = await h.call("POST", "/requests", patronRequest({ companionCount: 5 }));
  assert.equal(status, 400);
  assert.match(json.error, /validation:companion/);

  // companionCount=2 合法但占满相邻两个陪同席
  const ok = await h.call("POST", "/requests", patronRequest({ patronId: "P-0002", companionCount: 2 }));
  assert.equal(ok.status, 201);
});

test("硬约束：过道净宽小于轮椅包络时 B 区不可通行，只能分配 A 区", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  // 先占掉全部 A 区轮椅位
  for (let i = 0; i < 4; i += 1) {
    const r = await h.call("POST", "/requests", patronRequest({ patronId: `P-A-${i}`, companionCount: 0 }));
    assert.equal(r.status, 201, `第 ${i + 1} 个 A 区申请应成功`);
  }
  // B 区通道 850mm，常规轮椅需要 900mm
  const blocked = await h.call("POST", "/requests", patronRequest({ patronId: "P-B-1", companionCount: 0 }));
  assert.equal(blocked.status, 409);
  const codes = blocked.json.details.violations.map((v) => v.code);
  assert.ok(codes.includes("seat:aisle-width"), JSON.stringify(codes));
  assert.equal(blocked.json.details.violations[0].aisleWidthMm, 850);

  // 窄轮椅（800mm 包络）可使用 B 区
  const narrow = await h.call(
    "POST",
    "/requests",
    patronRequest({ patronId: "P-B-2", companionCount: 0, chairWidthMm: 800 }),
  );
  assert.equal(narrow.status, 201);
  assert.equal(narrow.json.request.plan.seatId, "WC-B-1");
});

test("并发申请不会占用同一席位", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  // 让 A 区只剩 1 个轮椅位
  for (const seat of ["WC-A-2", "WC-A-3", "WC-A-4"]) {
    const f = await h.call("POST", `/admin/seats/${seat}/fault`, { reason: "测试占用" });
    assert.equal(f.status, 200);
  }

  const [r1, r2] = await Promise.all([
    h.call("POST", "/requests", patronRequest({ patronId: "P-RACE-1", companionCount: 0 })),
    h.call("POST", "/requests", patronRequest({ patronId: "P-RACE-2", companionCount: 0 })),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const failed = r1.status === 409 ? r1 : r2;
  // 输家看到的是"可行席位已无"：占用或窄通道都是合法解释，关键是不能双重分配
  const codes = failed.json.details.violations.map((v) => v.code);
  assert.ok(codes.includes("seat:all-taken") || codes.includes("seat:aisle-width"), JSON.stringify(codes));
});

test("并发申请不会占用同一台助听设备", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  // 通用兼容只剩 DEV-001 一台 FM 接收机
  for (const device of ["DEV-002", "DEV-003"]) {
    const f = await h.call("POST", `/admin/devices/${device}/fault`, { reason: "测试占用" });
    assert.equal(f.status, 200);
  }

  const hearing = (patronId) =>
    patronRequest({
      patronId,
      mobility: "none",
      ticketRef: `T-${patronId}`,
      hearingAssistanceNeeded: true,
      hearingCompatibility: "universal",
      consentScopes: ["need.hearing", "contact.notify"],
      healthNote: undefined,
    });

  const [r1, r2] = await Promise.all([
    h.call("POST", "/requests", hearing("P-DEV-1")),
    h.call("POST", "/requests", hearing("P-DEV-2")),
  ]);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 409);
  assert.ok(r2.json.details.violations.some((v) => v.code === "device:unavailable"));
  // 不能用不兼容设备替代：给出说明性替代
  assert.ok(r2.json.details.alternatives.some((a) => a.type === "device"));
});

test("设备兼容硬约束：电感颈环不能配给无 telecoil 的观众", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  // telecoil 用户默认可匹配 DEV-004
  const telecoil = patronRequest({
    patronId: "P-T-1",
    mobility: "none",
    hearingAssistanceNeeded: true,
    hearingCompatibility: "telecoil",
    consentScopes: ["need.hearing", "contact.notify"],
  });
  const ok = await h.call("POST", "/requests", telecoil);
  assert.deepEqual(ok.json.request.plan.deviceIds, ["DEV-004"]);

  // 颈环送修：所需型号暂时不可用，物理可用的 FM/蓝牙与该助听器不兼容，不能自动替代
  await h.call("POST", "/admin/devices/DEV-004/fault", { reason: "线圈故障" });
  const second = await h.call("POST", "/requests", { ...telecoil, patronId: "P-T-2", ticketRef: "T-2" });
  assert.equal(second.status, 409);
  const violation = second.json.details.violations.find((v) => v.code === "device:unavailable");
  assert.ok(violation);
  assert.deepEqual(violation.requiredModels, ["induction-neck-loop"]);
});

test("手语译员唯一性与无译员场次的转场建议", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  const sign = (patronId, performanceId = EVENING) =>
    patronRequest({
      patronId,
      performanceId,
      ticketRef: `T-${patronId}`,
      mobility: "none",
      signLanguageNeeded: true,
      consentScopes: ["need.sign", "contact.notify"],
    });

  const [r1, r2] = await Promise.all([h.call("POST", "/requests", sign("P-S-1")), h.call("POST", "/requests", sign("P-S-2"))]);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 409);
  assert.ok(r2.json.details.violations.some((v) => v.code === "interpreter:taken"));

  // 日场没有译员 -> 拒绝；夜场译员已被 P-S-1 占用，真正可转的是次日场
  const matinee = await h.call("POST", "/requests", sign("P-S-3", MATINEE));
  assert.equal(matinee.status, 409);
  assert.ok(matinee.json.details.violations.some((v) => v.code === "interpreter:not-scheduled"));
  const perfAlts = matinee.json.details.alternatives.filter((a) => a.type === "performance");
  assert.deepEqual(perfAlts.map((a) => a.performanceId), [NEXT_DAY]);
});

test("购票后补充与变更：重新锁定资源，方案不变时不重复通知", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  // 先只购票、提交基础信息
  const created = await h.call(
    "POST",
    "/requests",
    patronRequest({ signLanguageNeeded: false, consentScopes: ["need.mobility", "contact.notify"] }),
  );
  const id = created.json.request.id;

  // 补充手语需求（夜场有译员；A 区可视区域）
  const amended = await h.call("POST", `/requests/${id}/amend`, {
    ...patronRequest(),
    signLanguageNeeded: true,
    consentScopes: ["need.mobility", "need.sign", "contact.notify", "health.note"],
  });
  assert.equal(amended.status, 200);
  assert.equal(amended.json.request.plan.interpreter, true);

  // 相同内容再次提交：不产生新的确认通知
  await h.call("POST", `/requests/${id}/amend`, {
    ...patronRequest(),
    signLanguageNeeded: true,
    consentScopes: ["need.mobility", "need.sign", "contact.notify", "health.note"],
  });
  const notes = await h.call("GET", "/notifications");
  const confirmations = notes.json.notifications.filter((n) => n.type === "confirmation");
  assert.equal(confirmations.length, 1, "同一方案指纹只能有一条确认通知");
});

test("隐私最小可见：客服看不到健康说明与联系方式，现场协调可以", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  const created = await h.call("POST", "/requests", patronRequest());
  const id = created.json.request.id;

  const boxOffice = await h.call("GET", `/requests/${id}`, undefined, "box_office");
  assert.equal(boxOffice.status, 200);
  assert.equal(boxOffice.json.request.healthNote, undefined);
  assert.match(boxOffice.json.request.patronName, /^\*+|张\*\*$/);
  assert.ok(boxOffice.json.request.contact.phone.includes("****"));

  const foh = await h.call("GET", `/requests/${id}`, undefined, "front_of_house");
  assert.equal(foh.json.request.healthNote, "需要平缓坡道，无电梯恐惧");
  assert.equal(foh.json.request.contact.phone, "13800001234");

  // 设备管理员看不到与设备无关的需求
  const steward = await h.call("GET", `/requests/${id}`, undefined, "device_steward");
  assert.equal(steward.json.request.needs.mobility, undefined);
});

test("设备故障：受影响申请生成可解释替代方案，接受后重新锁定", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  const created = await h.call(
    "POST",
    "/requests",
    patronRequest({
      patronId: "P-FAULT",
      mobility: "none",
      hearingAssistanceNeeded: true,
      hearingCompatibility: "universal",
      consentScopes: ["need.hearing", "contact.notify"],
    }),
  );
  const id = created.json.request.id;
  assert.deepEqual(created.json.request.plan.deviceIds, ["DEV-001"]);

  const fault = await h.call("POST", "/admin/devices/DEV-001/fault", { reason: "接收机无声" });
  assert.equal(fault.status, 200);
  assert.ok(fault.json.affected.some((a) => a.requestId === id));

  const view = await h.call("GET", `/requests/${id}`);
  const proposal = view.json.request.alternatives.find((a) => a.type === "rearrange");
  assert.ok(proposal, "应给出同场次换设备方案");
  assert.deepEqual(proposal.plan.deviceIds, ["DEV-002"]);

  const accepted = await h.call("POST", `/requests/${id}/accept-rearrangement`, {});
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.json.request.plan.deviceIds, ["DEV-002"]);
});

test("转场：释放原场次锁定并在新场次锁定，截止点保持不变", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  const created = await h.call("POST", "/requests", patronRequest({ patronId: "P-REBOOK" }));
  const id = created.json.request.id;
  const dueBefore = created.json.request.followupDueAt ?? (await h.call("GET", `/requests/${id}`)).json.request.followupDueAt;
  const detail = await h.call("GET", `/requests/${id}`);
  const originalDue = detail.json.request.followupDueAt;

  const rebooked = await h.call("POST", `/requests/${id}/rebook`, { targetPerformanceId: NEXT_DAY });
  assert.equal(rebooked.status, 200);
  assert.equal(rebooked.json.request.performanceId, NEXT_DAY);
  assert.equal(rebooked.json.previous.performanceId, EVENING);

  const again = await h.call("GET", `/requests/${id}`);
  assert.equal(again.json.request.followupDueAt, originalDue, "提醒截止点不应因转场重新计算");

  // 原场次席位已释放：另一观众可以占 WC-A-1
  const takeSeat = await h.call("POST", "/requests", patronRequest({ patronId: "P-AFTER-REBOOK" }));
  assert.equal(takeSeat.status, 201);
  assert.equal(takeSeat.json.request.plan.seatId, "WC-A-1");
});

test("取消：释放资源、中止待发通知，终态不能再变更", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  const created = await h.call("POST", "/requests", patronRequest({ patronId: "P-CANCEL" }));
  const id = created.json.request.id;
  const cancelled = await h.call("POST", `/requests/${id}/cancel`, { reason: "行程变更" });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.request.status, "cancelled");

  const amend = await h.call("POST", `/requests/${id}/amend`, patronRequest({ patronId: "P-CANCEL" }));
  assert.equal(amend.status, 409);

  // 资源被后续申请复用
  const reuse = await h.call("POST", "/requests", patronRequest({ patronId: "P-REUSE" }));
  assert.equal(reuse.status, 201);
  assert.equal(reuse.json.request.plan.seatId, "WC-A-1");
});

test("现场闭环：签到、设备交接、异常处置与关闭，且客服无权操作", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  const created = await h.call(
    "POST",
    "/requests",
    patronRequest({
      patronId: "P-FOH",
      hearingAssistanceNeeded: true,
      hearingCompatibility: "universal",
      consentScopes: ["need.mobility", "need.hearing", "contact.notify", "health.note"],
    }),
  );
  const id = created.json.request.id;

  const forbidden = await h.call("POST", `/requests/${id}/fulfillment`, { action: "checkin" }, "box_office");
  assert.equal(forbidden.status, 403);

  const checkin = await h.call(
    "POST",
    `/requests/${id}/fulfillment`,
    { action: "checkin", staffId: "VOL-01" },
    "front_of_house",
  );
  assert.equal(checkin.status, 200);
  assert.equal(checkin.json.request.fulfillment.checkedIn, true);

  const handover = await h.call(
    "POST",
    `/requests/${id}/fulfillment`,
    { action: "handover", handoverState: "device-handover", staffId: "VOL-01", toStaffId: "P-FOH" },
    "front_of_house",
  );
  assert.equal(handover.status, 200);
  assert.equal(handover.json.request.fulfillment.handoverState, "device-handover");

  // 未签到不能交接
  const other = await h.call("POST", "/requests", patronRequest({ patronId: "P-FOH-2" }));
  const badHandover = await h.call(
    "POST",
    `/requests/${other.json.request.id}/fulfillment`,
    { action: "handover", handoverState: "seated" },
    "front_of_house",
  );
  assert.equal(badHandover.status, 422);

  const close = await h.call(
    "POST",
    `/requests/${id}/fulfillment`,
    { action: "close" },
    "front_of_house",
  );
  assert.equal(close.json.request.status, "closed");
  assert.equal(close.json.request.fulfillment.closed, true);
});

test("脱敏履约记录：仅复盘角色可查，观众以假名出现", async (context) => {
  const h = await harness();
  context.after(h.shutdown);

  const created = await h.call(
    "POST",
    "/requests",
    patronRequest({ patronId: "P-AUDIT", hearingAssistanceNeeded: true, hearingCompatibility: "universal", consentScopes: ["need.mobility", "need.hearing", "contact.notify", "health.note"] }),
  );
  const id = created.json.request.id;
  await h.call("POST", `/requests/${id}/fulfillment`, { action: "checkin", staffId: "VOL-01" }, "front_of_house");

  const forbidden = await h.call("GET", "/fulfillment/records?ended=false", undefined, "box_office");
  assert.equal(forbidden.status, 403);

  const records = await h.call("GET", `/fulfillment/records?ended=false&performanceId=${EVENING}`, undefined, "auditor");
  assert.equal(records.status, 200);
  const mine = records.json.records.find((r) => r.id === id);
  assert.ok(mine);
  assert.match(mine.patron, /^观众-/);
  assert.equal(mine.healthNote, undefined);
  assert.equal(mine.patronId, undefined);
  assert.equal(mine.fulfillment.checkedIn, true);
});

test("重启持久化：未完成提醒按原截止点补发且只发一次", async (context) => {
  const dir = (await mkdtemp(join(tmpdir(), "acc-restart-")));
  context.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const file = join(dir, "state.json");

  const store1 = new JsonStore(file);
  await store1.ready;
  const server1 = createApp(store1);
  await new Promise((resolve) => server1.listen(0, "127.0.0.1", resolve));
  const base1 = `http://127.0.0.1:${server1.address().port}`;

  const created = await fetch(`${base1}/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patronRequest({ patronId: "P-RESTART" })),
  }).then((r) => r.json());
  const requestId = created.request.id;

  // 先排空创建时产生的通知，再注入一条已过截止点的待发提醒（模拟宕机期间到期）
  await store1.mutate((state) => deliverDue(state, null));
  await store1.mutate((state) => {
    enqueue(state, {
      requestId,
      type: "reminder",
      dedupKey: "overdue-test",
      audience: "staff",
      summary: "过期未发提醒",
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
  });
  await new Promise((resolve) => server1.close(resolve));

  // 重启：新 store 从同一文件恢复
  const store2 = new JsonStore(file);
  await store2.ready;
  const sent1 = await store2.mutate((state) => deliverDue(state, null));
  assert.equal(sent1.length, 1, "重启后应补发宕机期间到期的提醒");
  const sent2 = await store2.mutate((state) => deliverDue(state, null));
  assert.equal(sent2.length, 0, "同一提醒不能重复发送");

  const server2 = createApp(store2);
  await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server2.close(resolve)));
  const survived = await fetch(`http://127.0.0.1:${server2.address().port}/requests/${requestId}`).then((r) => r.json());
  assert.equal(survived.request.plan.seatId, "WC-A-1");
});
