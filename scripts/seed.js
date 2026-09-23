// 样例数据：售罄演出的场馆设施、席位布局、服务班次、设备库存与隐私授权。
// 用法：node scripts/seed.js [dbPath]
import { createContainer } from "../src/container.js";
import { nowIso } from "../src/domain/util.js";

export function seed(store) {
  const now = nowIso();

  // ---- 场次：一场售罄演出 + 一场可转入的次日场次 ----
  store.upsertPerformance({
    id: "perf-2026-12-03-02",
    title: "冬日交响夜（售罄）",
    startsAt: "2026-12-03T19:30:00+08:00",
    endsAt: "2026-12-03T22:00:00+08:00",
    createdAt: now,
  });
  store.upsertPerformance({
    id: "perf-2026-12-04-02",
    title: "冬日交响夜（加场）",
    startsAt: "2026-12-04T19:30:00+08:00",
    endsAt: "2026-12-04T22:00:00+08:00",
    createdAt: now,
  });

  // ---- 陪同票库存（独立于座位的硬约束）----
  store.upsertCompanionQuota("perf-2026-12-03-02", 4);
  store.upsertCompanionQuota("perf-2026-12-04-02", 8);

  // ---- 席位布局：轮椅席与相邻陪同席成对，过道净宽各异 ----
  const layout = [
    { w: "A-access-01", aisle: 95, companions: ["A-access-01-c1", "A-access-01-c2"] },
    { w: "A-access-02", aisle: 88, companions: ["A-access-02-c1"] },
    { w: "A-access-03", aisle: 80, companions: ["A-access-03-c1"] },
    { w: "A-access-04", aisle: 72, companions: ["A-access-04-c1"] },
  ];
  for (const perf of ["perf-2026-12-03-02", "perf-2026-12-04-02"]) {
    for (const group of layout) {
      const seatId = `${perf}:${group.w}`;
      store.upsertSeat({
        id: seatId, performanceId: perf, zone: "A-access", label: group.w,
        kind: "wheelchair", accessibleRoute: true, aisleWidthCm: group.aisle,
      });
      group.companions.forEach((label) => {
        store.upsertSeat({
          id: `${perf}:${label}`, performanceId: perf, zone: "A-access", label,
          kind: "companion", accessibleRoute: true, aisleWidthCm: group.aisle,
          adjacentTo: seatId,
        });
      });
    }
  }

  // ---- 手语翻译志愿者与班次 ----
  const volunteers = [
    { id: "vol-lin", name: "林译", skills: ["sign-language"] },
    { id: "vol-zhao", name: "赵声", skills: ["sign-language", "captioning"] },
  ];
  for (const v of volunteers) {
    store.upsertVolunteer(v);
    store.upsertShift(v.id, "perf-2026-12-03-02");
    store.upsertShift(v.id, "perf-2026-12-04-02");
  }

  // ---- 助听设备：不同兼容需求，库存紧张 ----
  for (const d of [
    { id: "dev-loop-1", type: "hearing-loop", model: "LoopMate L1", compatibleNeeds: ["t-coil"] },
    { id: "dev-fm-1", type: "fm-system", model: "FM Clear 200", compatibleNeeds: ["bluetooth", "none"] },
    { id: "dev-cap-1", type: "captioned-receiver", model: "CaptionGo X", compatibleNeeds: ["captioning", "none"] },
  ]) {
    store.upsertDevice(d);
    // 加场各备一台同款（id 加后缀，跨场次独立借用）
    store.upsertDevice({ ...d, id: `${d.id}-alt` });
  }

  // ---- 观众与隐私授权（健康信息仅履约角色可见）----
  store.upsertPatron({
    id: "patron-001", name: "王女士", contact: "138****0001",
    consentVersion: "sample-v1", consentScope: ["fulfilment"], consentAt: now,
  });
  store.upsertPatron({
    id: "patron-002", name: "陈先生", contact: "139****0002",
    consentVersion: "sample-v1", consentScope: ["fulfilment"], consentAt: now,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] ?? ".runtime/theatre.db";
  const container = createContainer({ dbPath });
  seed(container.store);
  console.log(`样例数据已写入 ${dbPath}`);
  container.db.close();
}
