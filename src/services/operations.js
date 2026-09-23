import { newId } from "../domain/ids.js";
import { DomainError, evaluateRequest, getPerformance, getSeat } from "../domain/match.js";
import { nowIso, toTime } from "../domain/time.js";
import { enqueue, planFingerprint } from "./notify.js";
import { normalizeInput } from "./requests.js";

function appendTimeline(request, event, detail = {}) {
  request.fulfillment ??= { timeline: [], incidents: [] };
  request.fulfillment.timeline ??= [];
  request.fulfillment.timeline.push({ at: nowIso(), event, ...detail });
}

function activeFutureRequests(state, filter) {
  return Object.values(state.requests ?? {}).filter(
    (r) =>
      r.status === "confirmed" &&
      getPerformance(state, r.performanceId) &&
      toTime(getPerformance(state, r.performanceId).startAt) > Date.now() &&
      filter(r),
  );
}

function alternativesFor(state, request) {
  const evaluation = evaluateRequest(state, request.performanceId, request.input, {
    excludeRequestId: request.id,
  });
  const alternatives = [];
  if (evaluation.violations.length === 0 && evaluation.plan) {
    if (planFingerprint(evaluation.plan) !== planFingerprint(request.plan)) {
      alternatives.push({ type: "rearrange", reason: "同场次可立即重排", plan: evaluation.plan });
    }
  }
  alternatives.push(...(evaluation.alternatives ?? []));
  if (alternatives.length === 0) {
    alternatives.push({ type: "manual", reason: "无可自动重排资源，需值班经理人工协调或退改" });
  }
  return alternatives;
}

// 标记设备故障/维护：影响该设备已排演出的申请，逐单生成可解释替代方案并通知履约人员
export function reportDeviceFault(state, deviceId, reason = "") {
  const device = state.devices.find((d) => d.id === deviceId);
  if (!device) throw new DomainError("device:not-found", "设备不存在", { deviceId });
  device.status = "maintenance";
  device.faultReason = reason;
  device.faultAt = nowIso();

  const incident = { id: newId("inc"), kind: "device-fault", resourceType: "device", resourceId: deviceId, at: nowIso(), reason };
  state.incidents ??= [];
  state.incidents.push(incident);

  const affected = [];
  for (const request of activeFutureRequests(state, (r) => (r.plan.deviceIds ?? []).includes(deviceId))) {
    const alternatives = alternativesFor(state, request);
    request.alternatives = alternatives;
    appendTimeline(request, "resource-fault", { incidentId: incident.id, resourceType: "device", resourceId: deviceId });
    enqueue(state, {
      requestId: request.id,
      type: "incident-alternative",
      dedupKey: incident.id,
      audience: "staff",
      summary: `设备 ${deviceId} 故障，已生成 ${alternatives.length} 个替代方案`,
    });
    affected.push({ requestId: request.id, alternatives });
  }
  return { incident, affected };
}

// 席位故障（如平台临时占用）
export function reportSeatFault(state, seatId, reason = "") {
  const seat = getSeat(state, seatId);
  if (!seat) throw new DomainError("seat:not-found", "席位不存在", { seatId });
  seat.status = "broken";
  seat.faultReason = reason;
  seat.faultAt = nowIso();

  const incident = { id: newId("inc"), kind: "seat-fault", resourceType: "seat", resourceId: seatId, at: nowIso(), reason };
  state.incidents ??= [];
  state.incidents.push(incident);

  const affected = [];
  for (const request of activeFutureRequests(
    state,
    (r) => r.plan.seatId === seatId || (r.plan.companionSeatIds ?? []).includes(seatId),
  )) {
    const alternatives = alternativesFor(state, request);
    request.alternatives = alternatives;
    appendTimeline(request, "resource-fault", { incidentId: incident.id, resourceType: "seat", resourceId: seatId });
    enqueue(state, {
      requestId: request.id,
      type: "incident-alternative",
      dedupKey: incident.id,
      audience: "staff",
      summary: `席位 ${seatId} 不可用，已生成 ${alternatives.length} 个替代方案`,
    });
    affected.push({ requestId: request.id, alternatives });
  }
  return { incident, affected };
}

// 班次取消（志愿者缺勤等）
export function cancelShift(state, shiftId, reason = "") {
  const shift = state.shifts.find((s) => s.id === shiftId);
  if (!shift) throw new DomainError("shift:not-found", "班次不存在", { shiftId });
  shift.status = "cancelled";
  shift.cancelledAt = nowIso();

  const incident = { id: newId("inc"), kind: "shift-cancel", resourceType: "shift", resourceId: shiftId, at: nowIso(), reason };
  state.incidents ??= [];
  state.incidents.push(incident);

  const affected = [];
  for (const request of activeFutureRequests(state, (r) => r.plan.shiftId === shiftId)) {
    const alternatives = alternativesFor(state, request);
    request.alternatives = alternatives;
    appendTimeline(request, "resource-fault", { incidentId: incident.id, resourceType: "shift", resourceId: shiftId });
    enqueue(state, {
      requestId: request.id,
      type: "incident-alternative",
      dedupKey: incident.id,
      audience: "staff",
      summary: `志愿者班次 ${shiftId} 取消，已生成 ${alternatives.length} 个替代方案`,
    });
    affected.push({ requestId: request.id, alternatives });
  }
  return { incident, affected };
}

// 转场：观众/客服接受其他场次，原场次锁定释放，按新场次重新评估并锁定
export function rebookRequest(state, requestId, targetPerformanceId, body = {}) {
  const request = state.requests?.[requestId];
  if (!request) throw new DomainError("request:not-found", "申请不存在", { requestId });
  if (["cancelled", "closed"].includes(request.status)) {
    throw new DomainError("request:terminal", "申请已取消或闭环，不能转场", { status: request.status });
  }
  const target = getPerformance(state, targetPerformanceId);
  if (!target) throw new DomainError("performance:not-found", "目标场次不存在", { targetPerformanceId });
  if (toTime(target.startAt) <= Date.now()) {
    throw new DomainError("performance:ended", "目标场次已开场", { targetPerformanceId });
  }

  // 转场可同时调整需求，否则沿用原申请
  const input = Object.keys(body).length > 0 ? normalizeInput({ ...body, performanceId: targetPerformanceId }) : request.input;

  const evaluation = evaluateRequest(state, targetPerformanceId, input, { excludeRequestId: request.id });
  if (evaluation.violations.length > 0) {
    throw new DomainError("constraint:violations", "目标场次无法满足硬约束", {
      violations: evaluation.violations,
      alternatives: evaluation.alternatives,
    });
  }

  const previous = { performanceId: request.performanceId, plan: request.plan };
  request.performanceId = targetPerformanceId;
  request.input = input;
  request.plan = evaluation.plan;
  request.alternatives = [];
  request.version += 1;
  request.updatedAt = nowIso();
  // 截止点保持原值，不因转场重新计算（字段不重写即沿用创建时的 followupDueAt）
  appendTimeline(request, "rebooked", { from: previous.performanceId, to: targetPerformanceId });
  enqueue(state, {
    requestId,
    type: "plan-change",
    dedupKey: `rebook:${targetPerformanceId}:${planFingerprint(evaluation.plan)}`,
    audience: "patron",
    summary: `服务已转至场次 ${targetPerformanceId}`,
  });
  return { request, previous };
}

// 接受系统给出的同场次重排方案（接受时重新评估，防止提议后资源又被占用）
export function acceptRearrangement(state, requestId) {
  const request = state.requests?.[requestId];
  if (!request) throw new DomainError("request:not-found", "申请不存在", { requestId });
  const proposal = (request.alternatives ?? []).find((a) => a.type === "rearrange");
  if (!proposal) throw new DomainError("alternative:none", "没有可接受的同场次重排方案");

  const evaluation = evaluateRequest(state, request.performanceId, request.input, {
    excludeRequestId: request.id,
  });
  if (evaluation.violations.length > 0) {
    throw new DomainError("constraint:stale", "重排方案已失效，请查看最新替代方案", {
      violations: evaluation.violations,
      alternatives: evaluation.alternatives,
    });
  }
  request.plan = evaluation.plan;
  request.alternatives = [];
  request.version += 1;
  request.updatedAt = nowIso();
  appendTimeline(request, "rearranged", { fingerprint: planFingerprint(evaluation.plan) });
  enqueue(state, {
    requestId,
    type: "plan-change",
    dedupKey: planFingerprint(evaluation.plan),
    audience: "patron",
    summary: "您的无障碍服务安排已更新（同场次重排）",
  });
  return request;
}

export function repairDevice(state, deviceId) {
  const device = state.devices.find((d) => d.id === deviceId);
  if (!device) throw new DomainError("device:not-found", "设备不存在", { deviceId });
  device.status = "available";
  device.faultReason = null;
  device.repairedAt = nowIso();
  return device;
}
