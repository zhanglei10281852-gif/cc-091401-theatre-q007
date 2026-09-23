// 纯函数领域引擎：席位/服务资源匹配、硬约束识别、可解释替代方案。
// 不在此模块修改状态；所有分配在串行写事务中重新评估后落锁，避免 TOCTOU。

export const STANDARD_WHEELCHAIR_WIDTH_MM = 900; // 常规手动轮椅通行包络
export const TRANSFER_PASSAGE_WIDTH_MM = 800; // 使用过道转换席所需的最小通行宽度
export const MAX_WHEELCHAIR_COMPANIONS = 2; // 每个轮椅位相邻陪同席数量

// 助听器兼容特征 -> 可搭配的设备型号（精确匹配，不跨兼容类型替代）
const HEARING_MODEL_PREFERENCE = {
  telecoil: ["induction-neck-loop"],
  "bluetooth-le-audio": ["bluetooth-streamer"],
  infrared: ["ir-receiver"],
  universal: ["fm-receiver"],
};

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function getPerformance(state, performanceId) {
  return state.performances.find((p) => p.id === performanceId) ?? null;
}

export function getSeat(state, seatId) {
  return state.seats.find((s) => s.id === seatId) ?? null;
}

export function getZone(state, performance, zoneId) {
  const venue = state.venues[performance.venueId];
  return venue?.zones.find((z) => z.id === zoneId) ?? null;
}

// 通道最窄处净宽
export function routeMinWidth(zone) {
  return Math.min(...zone.routes.map((r) => r.minWidth));
}

export function activeRequests(state, performanceId) {
  return Object.values(state.requests ?? {}).filter(
    (r) => r.performanceId === performanceId && r.status === "confirmed",
  );
}

function seatTakenBy(state, performanceId, seatId, excludeRequestId) {
  return activeRequests(state, performanceId).some(
    (r) =>
      r.id !== excludeRequestId &&
      r.plan &&
      [r.plan.seatId, ...(r.plan.companionSeatIds ?? [])].includes(seatId),
  );
}

function deviceTakenBy(state, performanceId, deviceId, excludeRequestId) {
  return activeRequests(state, performanceId).some(
    (r) => r.id !== excludeRequestId && (r.plan?.deviceIds ?? []).includes(deviceId),
  );
}

function interpreterTaken(state, performanceId, excludeRequestId) {
  return activeRequests(state, performanceId).some(
    (r) => r.id !== excludeRequestId && r.plan?.interpreter === true,
  );
}

function coveringShifts(state, performance) {
  return (state.shifts ?? []).filter(
    (s) =>
      s.status !== "cancelled" &&
      Date.parse(s.startAt) <= Date.parse(performance.startAt) &&
      Date.parse(s.endAt) >= Date.parse(performance.endAt),
  );
}

function shiftRemaining(state, shiftId, performance, excludeRequestId) {
  const shift = state.shifts.find((s) => s.id === shiftId);
  if (!shift) return 0;
  const used = activeRequests(state, performance.id).filter(
    (r) => r.id !== excludeRequestId && r.plan?.shiftId === shiftId,
  ).length;
  return shift.capacity - used;
}

function violation(code, message, details = {}) {
  return { code, message, ...details };
}

// 候选席位评估：返回 {chosen, candidates, reasons[]}
function evaluateSeat(state, performance, input, excludeRequestId) {
  const reasons = [];
  const mobility = input.mobility ?? "none";
  if (mobility === "none") return { chosen: null, candidates: [], reasons };

  const needWidth =
    mobility === "wheelchair"
      ? input.chairWidthMm ?? STANDARD_WHEELCHAIR_WIDTH_MM
      : input.chairWidthMm ?? TRANSFER_PASSAGE_WIDTH_MM;
  const candidateType = mobility === "wheelchair" ? "wheelchair" : "aisle-transfer";
  const companions = input.companionCount ?? 0;

  const candidates = [];

  for (const seat of state.seats.filter((s) => s.type === candidateType && s.status !== "broken")) {
    const zone = getZone(state, performance, seat.zone);
    if (!zone) continue;
    const width = routeMinWidth(zone);
    const taken = seatTakenBy(state, performance.id, seat.id, excludeRequestId);
    const companionSeats = state.seats.filter(
      (s) => s.type === "companion" && s.adjacentTo === seat.id && s.status !== "broken",
    );
    const freeCompanionSeats = companionSeats.filter(
      (s) => !seatTakenBy(state, performance.id, s.id, excludeRequestId),
    );

    candidates.push({
      seatId: seat.id,
      zoneId: zone.id,
      aisleWidthMm: width,
      requiredWidthMm: needWidth,
      widthOk: width >= needWidth,
      taken,
      companionCapacity: freeCompanionSeats.length,
      companionNeeded: companions,
      sightline: zone.interpreterSightline,
    });
  }

  const feasible = candidates
    .filter((c) => c.widthOk && !c.taken && c.companionCapacity >= companions)
    .sort((a, b) => {
      if (input.signLanguageNeeded) {
        // 手语需求下，看得见译员的区域优先
        if (a.sightline !== b.sightline) return a.sightline ? -1 : 1;
      }
      return a.seatId.localeCompare(b.seatId);
    });

  const chosen = feasible[0] ?? null;
  if (!chosen) {
    if (candidates.length === 0) {
      reasons.push(
        violation("seat:none-available", "该场次没有可分配的无障碍席", { mobility }),
      );
    } else {
      // 只考虑当前未被占用的候选：已占席位不是该观众的通行障碍
      const untaken = candidates.filter((c) => !c.taken);
      const widthBlocked = untaken.filter((c) => !c.widthOk);
      const companionBlocked = untaken.filter((c) => c.widthOk && c.companionCapacity < companions);

      if (untaken.length === 0) {
        reasons.push(violation("seat:all-taken", "该场次符合条件的无障碍席位已被占用", { mobility }));
      } else if (widthBlocked.length > 0 && widthBlocked.length + companionBlocked.length >= untaken.length) {
        // 剩余席位均因过道净宽（可能叠加陪同席不足）不可用：净宽是首要硬约束
        const worst = widthBlocked.reduce((a, b) => (a.aisleWidthMm < b.aisleWidthMm ? a : b));
        reasons.push(
          violation("seat:aisle-width", "通往无障碍区的过道净宽小于轮椅通行要求，无法安全通行", {
            mobility,
            zoneId: worst.zoneId,
            aisleWidthMm: worst.aisleWidthMm,
            requiredWidthMm: worst.requiredWidthMm,
          }),
        );
        if (companions > 0 && companionBlocked.length > 0) {
          reasons.push(
            violation("companion:over-capacity", "相邻陪同席不足，陪同人员必须与轮椅席位相邻", {
              companionNeeded: companions,
              maxAvailable: Math.max(...companionBlocked.map((c) => c.companionCapacity)),
              hardLimit: MAX_WHEELCHAIR_COMPANIONS,
            }),
          );
        }
      } else if (companionBlocked.length > 0) {
        reasons.push(
          violation("companion:over-capacity", "相邻陪同席不足，陪同人员必须与轮椅席位相邻", {
            companionNeeded: companions,
            maxAvailable: Math.max(...companionBlocked.map((c) => c.companionCapacity)),
            hardLimit: MAX_WHEELCHAIR_COMPANIONS,
          }),
        );
      } else {
        reasons.push(violation("seat:all-taken", "该场次符合条件的无障碍席位已被占用", { mobility }));
      }
    }
  }

  return { chosen, candidates, reasons };
}

function evaluateDevice(state, performance, input, excludeRequestId) {
  const reasons = [];
  if (!input.hearingAssistanceNeeded) return { chosen: null, reasons };
  // 未声明兼容特征（不戴助听器或通用接口）默认走 FM 通用接收机
  const token = input.hearingCompatibility ?? "universal";
  const requiredModels = HEARING_MODEL_PREFERENCE[token] ?? ["fm-receiver"];

  const available = (model) =>
    state.devices.find(
      (d) =>
        d.model === model &&
        d.status === "available" &&
        !deviceTakenBy(state, performance.id, d.id, excludeRequestId),
    );

  let chosen = null;
  for (const model of requiredModels) {
    chosen = available(model);
    if (chosen) break;
  }

  if (!chosen) {
    const stockOfKind = state.devices.filter((d) => requiredModels.includes(d.model));
    const code = stockOfKind.length === 0 ? "device:incompatible" : "device:unavailable";
    reasons.push(
      violation(
        code,
        code === "device:incompatible"
          ? "库存设备与观众助听器的兼容特征不匹配，不能跨类型替代"
          : "兼容设备已全部借出或送修",
        {
          hearingCompatibility: token,
          requiredModels,
        },
      ),
    );
  }

  // 说明性替代：列出观众助听器若支持其他特征时可借用的型号，供人工沟通，不自动替代
  const fallback = [];
  if (!chosen) {
    for (const [otherToken, models] of Object.entries(HEARING_MODEL_PREFERENCE)) {
      if (otherToken === token) continue;
      for (const model of models) {
        const d = available(model);
        if (d) {
          fallback.push({
            type: "device",
            model,
            deviceId: d.id,
            note: `仅当助听器支持 ${otherToken} 特征时可用，需现场与观众确认`,
          });
        }
      }
    }
  }
  return { chosen, reasons, fallback };
}

function evaluateInterpreter(state, performance, input, chosenSeat, excludeRequestId) {
  const reasons = [];
  if (!input.signLanguageNeeded) return { ok: true, reasons };
  if (!performance.interpreter?.scheduled) {
    reasons.push(
      violation("interpreter:not-scheduled", "该场次未安排手语译员，无法提供现场手语翻译", {
        performanceId: performance.id,
      }),
    );
    return { ok: false, reasons };
  }
  if (interpreterTaken(state, performance.id, excludeRequestId)) {
    reasons.push(
      violation("interpreter:taken", "该场次手语译员已有服务对象，译员不可同时服务第二席", {
        staffId: performance.interpreter.staffId,
      }),
    );
    return { ok: false, reasons };
  }
  if (chosenSeat && !chosenSeat.sightline) {
    reasons.push(
      violation("sightline:required", "所选席位看不到手语译员，必须安排在可视区域", {
        zoneId: chosenSeat.zoneId,
      }),
    );
    return { ok: false, reasons };
  }
  return { ok: true, reasons };
}

function evaluateShift(state, performance, input, excludeRequestId) {
  const needs = input.needsVolunteer ?? input.mobility === "wheelchair";
  if (!needs) return { chosen: null };
  const shifts = coveringShifts(state, performance)
    .map((s) => ({ shift: s, remaining: shiftRemaining(state, s.id, performance, excludeRequestId) }))
    .filter((x) => x.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);
  if (shifts.length === 0) {
    return {
      chosen: null,
      reason: violation("shift:no-capacity", "覆盖该场次的志愿者陪同班次已满或不存在", {
        performanceId: performance.id,
      }),
    };
  }
  return { chosen: shifts[0] };
}

// 可解释的跨场次替代方案（转场建议）
function performanceAlternatives(state, performanceId, input) {
  const current = getPerformance(state, performanceId);
  if (!current) return [];
  const alts = [];
  for (const candidate of state.performances) {
    if (candidate.id === performanceId) continue;
    if (candidate.venueId !== current.venueId) continue;
    if (Date.parse(candidate.startAt) <= Date.now()) continue;
    // 转场候选是否可行以资源实时锁定情况为准；售罄场次仍可能通过票务协调完成转场
    if (input.signLanguageNeeded && !candidate.interpreter?.scheduled) continue;
    const evaluation = evaluateRequest(state, candidate.id, input, { lightweight: true });
    if (evaluation.violations.length === 0) {
      alts.push({
        type: "performance",
        performanceId: candidate.id,
        title: candidate.title,
        startAt: candidate.startAt,
        reason: "同剧目其他场次仍有完整无障碍资源",
      });
    }
  }
  return alts;
}

/**
 * 评估一份申请。
 * @param {object} opts.excludeRequestId 变更/续约时排除自身旧占用
 * @param {object} opts.lightweight 仅判断可行性（转场候选扫描时使用）
 */
export function evaluateRequest(state, performanceId, input, opts = {}) {
  const { excludeRequestId = null, lightweight = false } = opts;
  const violations = [];
  const alternatives = [];

  const performance = getPerformance(state, performanceId);
  if (!performance) {
    return {
      performanceId,
      violations: [violation("performance:not-found", "演出场次不存在", { performanceId })],
      alternatives: [],
      plan: null,
      diagnostics: null,
    };
  }
  if (Date.parse(performance.startAt) <= Date.now()) {
    violations.push(violation("performance:ended", "该场次已开场，无法在线锁定资源", { performanceId }));
  }

  const seatResult = evaluateSeat(state, performance, input, excludeRequestId);
  violations.push(...seatResult.reasons);

  const interpreterResult = evaluateInterpreter(
    state,
    performance,
    input,
    seatResult.chosen,
    excludeRequestId,
  );
  violations.push(...interpreterResult.reasons);

  const deviceResult = evaluateDevice(state, performance, input, excludeRequestId);
  violations.push(...deviceResult.reasons);

  const shiftResult = evaluateShift(state, performance, input, excludeRequestId);
  if (shiftResult.reason) violations.push(shiftResult.reason);

  if (violations.length > 0) {
    alternatives.push(...performanceAlternatives(state, performanceId, input));
    alternatives.push(...(deviceResult.fallback ?? []).map((f) => ({ type: "device", ...f })));
  }

  let plan = null;
  if (violations.length === 0) {
    const chosen = seatResult.chosen;
    plan = {
      performanceId,
      zoneId: chosen?.zoneId ?? null,
      seatId: chosen?.seatId ?? null,
      companionSeatIds: chosen
        ? state.seats
            .filter((s) => s.type === "companion" && s.adjacentTo === chosen.seatId)
            .filter((s) => !seatTakenBy(state, performanceId, s.id, excludeRequestId))
            .slice(0, input.companionCount ?? 0)
            .map((s) => s.id)
        : [],
      interpreter: input.signLanguageNeeded === true,
      interpreterStaffId: input.signLanguageNeeded ? performance.interpreter?.staffId ?? null : null,
      deviceIds: deviceResult.chosen ? [deviceResult.chosen.id] : [],
      shiftId: shiftResult.chosen?.shift.id ?? null,
      volunteerStaff: shiftResult.chosen?.shift.staff ?? [],
    };
  }

  return {
    performanceId,
    violations,
    alternatives,
    plan,
    diagnostics: lightweight
      ? null
      : {
          seatCandidates: seatResult.candidates,
          requiredAisleWidthMm:
            input.mobility === "wheelchair"
              ? input.chairWidthMm ?? STANDARD_WHEELCHAIR_WIDTH_MM
              : null,
        },
  };
}
