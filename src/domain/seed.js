// 样例主数据：场馆无障碍设施、席位布局、服务班次、设备库存、隐私授权模板。
// 仅用于说明字段含义与约束，时间均为带偏移量的 ISO 8601。

export function seedData() {
  return {
    version: 1,
    pseudonymSalt: "demo-salt-2026",
    venues: {
      "venue-grand": {
        id: "venue-grand",
        name: "大剧院",
        zones: [
          {
            id: "A-access",
            name: "A 区无障碍平台",
            kind: "wheelchair",
            interpreterSightline: true,
            // 从各入口到该区域通道的最小净宽（毫米），取最保守值
            routes: [
              { from: "accessible-entrance", minWidth: 1200 },
              { from: "main-lobby", minWidth: 1100 },
            ],
          },
          {
            id: "B-access",
            name: "B 区无障碍平台",
            kind: "wheelchair",
            interpreterSightline: false,
            // 拐角展架占道，净宽不足常规轮椅 900mm 要求
            routes: [{ from: "accessible-entrance", minWidth: 850 }],
          },
          {
            id: "stalls-j",
            name: "池座 J 排（过道席）",
            kind: "standard",
            interpreterSightline: true,
            routes: [{ from: "main-lobby", minWidth: 1000 }],
          },
          {
            id: "stalls-k",
            name: "池座 K 排",
            kind: "standard",
            interpreterSightline: false,
            routes: [{ from: "main-lobby", minWidth: 1200 }],
          },
        ],
      },
    },
    seats: buildSeats(),
    performances: [
      {
        id: "perf-2026-12-03-01",
        venueId: "venue-grand",
        title: "冬日童话（日场）",
        startAt: "2026-12-03T14:00:00+08:00",
        endAt: "2026-12-03T16:30:00+08:00",
        soldOut: true,
        interpreter: { scheduled: false },
      },
      {
        id: "perf-2026-12-03-02",
        title: "冬日童话（夜场）",
        venueId: "venue-grand",
        startAt: "2026-12-03T19:30:00+08:00",
        endAt: "2026-12-03T22:00:00+08:00",
        soldOut: true,
        interpreter: { scheduled: true, staffId: "INT-01", staffName: "林手语" },
      },
      {
        id: "perf-2026-12-04-01",
        title: "冬日童话（次日夜场）",
        venueId: "venue-grand",
        startAt: "2026-12-04T19:30:00+08:00",
        endAt: "2026-12-04T22:00:00+08:00",
        soldOut: false,
        interpreter: { scheduled: true, staffId: "INT-01", staffName: "林手语" },
      },
    ],
    // 志愿者陪同班次：capacity 为该班可服务的轮椅/过道席观众数
    shifts: [
      {
        id: "SHIFT-E1",
        type: "escort",
        staff: [{ id: "VOL-01", name: "王志愿" }, { id: "VOL-02", name: "赵志愿" }],
        startAt: "2026-12-03T12:00:00+08:00",
        endAt: "2026-12-03T17:30:00+08:00",
        // capacity 为整场内可接待的陪同到场数（志愿者入座后即可服务下一位）
        capacity: 4,
      },
      {
        id: "SHIFT-E2",
        type: "escort",
        staff: [{ id: "VOL-03", name: "孙志愿" }, { id: "VOL-04", name: "周志愿" }],
        startAt: "2026-12-03T17:00:00+08:00",
        endAt: "2026-12-03T22:30:00+08:00",
        capacity: 6,
      },
      {
        id: "SHIFT-E3",
        type: "escort",
        staff: [{ id: "VOL-03", name: "孙志愿" }],
        startAt: "2026-12-04T17:00:00+08:00",
        endAt: "2026-12-04T22:30:00+08:00",
        capacity: 2,
      },
    ],
    devices: [
      { id: "DEV-001", model: "fm-receiver", name: "FM 接收机", compatibleWith: ["universal"], status: "available" },
      { id: "DEV-002", model: "fm-receiver", name: "FM 接收机", compatibleWith: ["universal"], status: "available" },
      { id: "DEV-003", model: "fm-receiver", name: "FM 接收机", compatibleWith: ["universal"], status: "available" },
      { id: "DEV-004", model: "induction-neck-loop", name: "电感颈环", compatibleWith: ["telecoil"], status: "available" },
      { id: "DEV-005", model: "bluetooth-streamer", name: "蓝牙音频串流器", compatibleWith: ["bluetooth-le-audio"], status: "available" },
      { id: "DEV-006", model: "fm-receiver", name: "FM 接收机（待修）", compatibleWith: ["universal"], status: "maintenance" },
    ],
    consentTemplates: [
      {
        id: "consent-accessibility-v1",
        title: "无障碍服务个人信息授权样例",
        scopes: [
          { code: "need.mobility", title: "行动辅助需求（轮椅席、过道席、陪同人数）", required: true },
          { code: "need.sign", title: "手语翻译需求", required: false },
          { code: "need.hearing", title: "助听设备需求与助听器兼容特征", required: false },
          { code: "contact.notify", title: "使用联系方式发送服务通知", required: false },
          { code: "health.note", title: "自由文本健康补充说明（敏感）", required: false, sensitive: true },
        ],
      },
    ],
  };
}

function buildSeats() {
  const seats = [];
  const add = (seat) => seats.push(seat);
  // A 区：4 个轮椅位，每个配 2 个相邻陪同席
  for (let i = 1; i <= 4; i += 1) {
    const wc = `WC-A-${i}`;
    add({ id: wc, zone: "A-access", type: "wheelchair" });
    add({ id: `C-A-${i}a`, zone: "A-access", type: "companion", adjacentTo: wc });
    add({ id: `C-A-${i}b`, zone: "A-access", type: "companion", adjacentTo: wc });
  }
  // B 区：2 个轮椅位（通道净宽受限）
  for (let i = 1; i <= 2; i += 1) {
    const wc = `WC-B-${i}`;
    add({ id: wc, zone: "B-access", type: "wheelchair" });
    add({ id: `C-B-${i}a`, zone: "B-access", type: "companion", adjacentTo: wc });
    add({ id: `C-B-${i}b`, zone: "B-access", type: "companion", adjacentTo: wc });
  }
  // J 排：4 个过道转换席
  for (let i = 1; i <= 4; i += 1) add({ id: `AT-J-${i}`, zone: "stalls-j", type: "aisle-transfer" });
  // K 排普通席
  for (let i = 1; i <= 6; i += 1) add({ id: `STD-K-${i}`, zone: "stalls-k", type: "standard" });
  return seats;
}
