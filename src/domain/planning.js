// 资源规划：在一个 IMMEDIATE 事务内完成“读取余量 → 校验硬约束 → 写分配台账”。
// 硬约束：陪同人数与陪同票余量、过道净宽 vs 轮椅宽度、设备兼容需求、手语技能与班次。
import { SERVICES } from "./constants.js";
import { badRequest } from "./errors.js";
import { id } from "./util.js";

class PlanningError extends Error {
  constructor(violations) {
    super("planning_failed");
    this.name = "PlanningError";
    this.violations = violations;
  }
}

// 为申请构建并落账分配。调用方必须已开启事务；失败抛出 PlanningError 由事务回滚。
export function commitPlan(store, request, { now, trigger = "planning" } = {}) {
  const violations = [];
  const allocations = [];
  const performanceId = request.performance_id;
  const companionCount = request.companion_count ?? 0;
  const needs = request.needs ?? [];

  const performance = store.getPerformance(performanceId);
  if (!performance) {
    throw badRequest("performance_not_found", "演出场次不存在");
  }
  if (performance.status !== "scheduled") {
    violations.push({
      code: "performance_not_schedulable",
      message: `场次当前状态为 ${performance.status}，无法在本场锁定资源`,
    });
    throw new PlanningError(violations);
  }

  const quota = store.getCompanionQuota(performanceId);
  const quotaLeft = quota?.total ?? 0;

  let wheelchairSeat = null;
  let companionSeats = [];

  if (needs.includes(SERVICES.WHEELCHAIR_SEAT)) {
    const width = request.wheelchair_width_cm ?? null;
    const candidates = store.findFreeSeats({
      performanceId,
      kind: "wheelchair",
      ignoreRequestId: request.id,
    }).filter((seat) => seat.accessible_route === 1)
      .filter((seat) => width == null || seat.aisle_width_cm >= width);

    if (companionCount > 0 && quotaLeft < companionCount) {
      violations.push({
        code: "companion_quota_exceeded",
        need: SERVICES.WHEELCHAIR_SEAT,
        message: `陪同票需求 ${companionCount} 人，超过本场剩余 ${quotaLeft} 张`,
        required: companionCount,
        available: quotaLeft,
      });
    }

    // 在满足过道净宽的候选席中，寻找相邻陪同席足够的轮椅席。
    let chosen = null;
    const widthRejected = [];
    for (const seat of candidates) {
      const adjacent = store.findFreeSeats({
        performanceId,
        kind: "companion",
        adjacentTo: seat.id,
        ignoreRequestId: request.id,
      });
      if (adjacent.length >= companionCount) {
        chosen = { seat, adjacent: adjacent.slice(0, companionCount) };
        break;
      }
      widthRejected.push({ seatId: seat.id, adjacentFree: adjacent.length });
    }

    if (!candidates.length) {
      violations.push({
        code: "aisle_width_unsatisfied",
        need: SERVICES.WHEELCHAIR_SEAT,
        message: width
          ? `没有过道净宽 ≥ ${width} cm 的无障碍轮椅席`
          : "本场没有可用的无障碍轮椅席",
        requiredAisleWidthCm: width,
      });
    } else if (!chosen) {
      violations.push({
        code: "adjacent_companion_unavailable",
        need: SERVICES.WHEELCHAIR_SEAT,
        message: `轮椅席相邻陪同位不足 ${companionText(companionCount)}`,
        companionCount,
        candidates: widthRejected,
      });
    } else {
      wheelchairSeat = chosen.seat;
      companionSeats = chosen.adjacent;
    }
  } else if (companionCount > 0) {
    // 无轮椅席需求时，陪同人仍计入陪同票硬约束。
    if (quotaLeft < companionCount) {
      violations.push({
        code: "companion_quota_exceeded",
        message: `陪同票需求 ${companionCount} 人，超过本场剩余 ${quotaLeft} 张`,
        required: companionCount,
        available: quotaLeft,
      });
    }
  }

  let volunteer = null;
  if (needs.includes(SERVICES.SIGN_LANGUAGE)) {
    volunteer = store.findFreeVolunteer({
      performanceId,
      skill: SERVICES.SIGN_LANGUAGE,
      ignoreRequestId: request.id,
    });
    if (!volunteer) {
      violations.push({
        code: "sign_language_unavailable",
        need: SERVICES.SIGN_LANGUAGE,
        message: "本场没有可排班的手语翻译志愿者",
      });
    }
  }

  let device = null;
  if (needs.includes(SERVICES.HEARING_DEVICE)) {
    const hearingNeed = request.hearing_need ?? "none";
    const devices = store.findFreeDevices({
      performanceId,
      need: hearingNeed,
      ignoreRequestId: request.id,
    });
    device = devices[0] ?? null;
    if (!device) {
      violations.push({
        code: "device_incompatible_or_unavailable",
        need: SERVICES.HEARING_DEVICE,
        message: `本场没有兼容“${hearingNeed}”需求的助听设备`,
        requiredNeed: hearingNeed,
      });
    }
  }

  if (violations.length) throw new PlanningError(violations);

  // ---- 硬约束全部满足，开始落账（台账唯一索引是并发兜底）----
  const add = (resourceKind, resourceId, detail = {}) => {
    try {
      store.insertAllocation({
        id: id("alloc"),
        requestId: request.id,
        performanceId,
        resourceKind,
        resourceId,
        detail: { trigger, ...detail },
        createdAt: now,
      });
      allocations.push({ resourceKind, resourceId, detail });
    } catch (error) {
      if (error?.code?.startsWith?.("SQLITE_CONSTRAINT")) {
        // 并发竞争：同席/同设备已被抢先占用，标记 race 让事务整体重试。
        throw Object.assign(new Error("resource_race"), { race: true });
      }
      throw error;
    }
  };

  if (wheelchairSeat) {
    add("seat", wheelchairSeat.id, {
      zone: wheelchairSeat.zone,
      label: wheelchairSeat.label,
      kind: "wheelchair",
      aisleWidthCm: wheelchairSeat.aisle_width_cm,
    });
  }
  for (const seat of companionSeats) {
    add("seat", seat.id, { zone: seat.zone, label: seat.label, kind: "companion" });
  }
  if (companionCount > 0) {
    // 陪同票余量是独立库存：原子扣减，失败则回滚整组分配。
    const consumed = store.tryConsumeCompanionQuota(performanceId, companionCount);
    if (!consumed) throw Object.assign(new Error("quota_race"), { race: true });
    // 台账中保留一条陪同票记录（resource_id 含申请 id，天然每申请唯一），重排时据此回补。
    add("companion-ticket", `quota:${request.id}`, { count: companionCount });
  }
  if (volunteer) {
    add("volunteer", volunteer.id, { skill: SERVICES.SIGN_LANGUAGE, name: volunteer.name });
  }
  if (device) {
    add("device", device.id, { type: device.type, model: device.model });
  }

  return allocations;
}

// 可解释替代方案：按未满足的硬约束，扫描其他场次给出转场/候补/替代服务建议。
export function findAlternatives(store, request, violations, { now } = {}) {
  const options = [];
  const otherPerformances = store.listPerformances().filter(
    (p) => p.id !== request.performance_id && p.status === "scheduled",
  );

  for (const violation of violations) {
    if (violation.code === "aisle_width_unsatisfied" || violation.code === "adjacent_companion_unavailable") {
      const width = request.wheelchair_width_cm ?? null;
      for (const perf of otherPerformances) {
        const seat = store.findFreeSeats({ performanceId: perf.id, kind: "wheelchair" })
          .filter((s) => s.accessible_route === 1)
          .filter((s) => width == null || s.aisle_width_cm >= width)
          .find((s) => store.findFreeSeats({
            performanceId: perf.id, kind: "companion", adjacentTo: s.id,
          }).length >= (request.companion_count ?? 0));
        if (seat) {
          options.push({
            type: "transfer",
            performanceId: perf.id,
            title: perf.title,
            startsAt: perf.starts_at,
            reason: `该场次轮椅席 ${seat.zone}/${seat.label} 过道净宽 ${seat.aisle_width_cm} cm 且有相邻陪同位`,
            seatId: seat.id,
          });
        }
      }
      if (violation.code === "adjacent_companion_unavailable") {
        options.push({
          type: "waitlist",
          service: SERVICES.WHEELCHAIR_SEAT,
          reason: "登记候补：开场前 30 分钟释放的相邻陪同位优先分配",
        });
        options.push({
          type: "reduce_companions",
          reason: "减少陪同人数后本场可立即确认",
          maxCompanions: Math.max(0, ...violation.candidates?.map((c) => c.adjacentFree) ?? [0]),
        });
      }
    }

    if (violation.code === "companion_quota_exceeded") {
      options.push({
        type: "waitlist",
        service: "companion-ticket",
        reason: "陪同票候补：取消释放时按申请顺序补录",
      });
    }

    if (violation.code === "sign_language_unavailable") {
      for (const perf of otherPerformances) {
        const volunteer = store.findFreeVolunteer({ performanceId: perf.id, skill: SERVICES.SIGN_LANGUAGE });
        if (volunteer) {
          options.push({
            type: "transfer",
            performanceId: perf.id,
            title: perf.title,
            startsAt: perf.starts_at,
            reason: `手语志愿者 ${volunteer.name} 在该场次有空班`,
            volunteerId: volunteer.id,
          });
        }
      }
      const captionDevice = store.findFreeDevices({
        performanceId: request.performance_id, need: "captioning",
        ignoreRequestId: request.id,
      })[0];
      if (captionDevice) {
        options.push({
          type: "substitute_service",
          service: SERVICES.HEARING_DEVICE,
          hearingNeed: "captioning",
          deviceId: captionDevice.id,
          reason: `可借用字幕接收器 ${captionDevice.model} 作为本场替代`,
        });
      }
    }

    if (violation.code === "device_incompatible_or_unavailable") {
      for (const perf of otherPerformances) {
        const device = store.findFreeDevices({
          performanceId: perf.id, need: request.hearing_need ?? "none",
        })[0];
        if (device) {
          options.push({
            type: "transfer",
            performanceId: perf.id,
            title: perf.title,
            startsAt: perf.starts_at,
            reason: `${device.model} 兼容“${request.hearing_need}”，该场次可借`,
            deviceId: device.id,
          });
        }
      }
      // 同场替代：改用字幕接收器（不需要 t-coil/蓝牙匹配）。
      const captionDevice = store.findFreeDevices({
        performanceId: request.performance_id, need: "captioning",
        ignoreRequestId: request.id,
      })[0];
      if (captionDevice) {
        options.push({
          type: "substitute_service",
          service: SERVICES.HEARING_DEVICE,
          hearingNeed: "captioning",
          deviceId: captionDevice.id,
          reason: `原兼容设备不可用，可改用字幕接收器 ${captionDevice.model}`,
        });
      }
      options.push({
        type: "waitlist",
        service: SERVICES.HEARING_DEVICE,
        reason: "设备候补：故障设备返修或归还后优先通知",
      });
    }

    if (violation.code === "performance_not_schedulable") {
      for (const perf of otherPerformances) {
        options.push({
          type: "transfer",
          performanceId: perf.id,
          title: perf.title,
          startsAt: perf.starts_at,
          reason: "原场次已不可安排，可转至该场次",
        });
      }
    }
  }

  return dedupeOptions(options);
}

// 资源故障后优先在同场重排（故障资源已被标记不可用，自然跳过）。
export function replanSamePerformance(store, request, { now }) {
  const performance = store.getPerformance(request.performance_id);
  if (!performance || performance.status !== "scheduled") return null;
  try {
    return commitPlan(store, request, { now, trigger: "resource-failure" });
  } catch (error) {
    if (error instanceof PlanningError) return { failed: true, violations: error.violations };
    throw error;
  }
}

export { PlanningError };

function dedupeOptions(options) {
  const seen = new Set();
  return options.filter((option) => {
    const key = `${option.type}:${option.performanceId ?? ""}:${option.deviceId ?? ""}:${option.service ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function companionText(count) {
  return `${count} 个相邻陪同位`;
}
