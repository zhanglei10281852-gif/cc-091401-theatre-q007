import { newId } from "../domain/ids.js";
import { DomainError, evaluateRequest, getPerformance } from "../domain/match.js";
import { followupDueAt, nowIso } from "../domain/time.js";
import { cancelPendingForRequest, enqueue, ensureFollowup, planFingerprint, upsertConfirmation } from "./notify.js";

const MOBILITY_VALUES = new Set(["none", "wheelchair", "aisle-transfer"]);
const COMPATIBILITY_VALUES = new Set(["universal", "telecoil", "bluetooth-le-audio", "infrared"]);
const REQUIRED_CONSENT = new Set(["need.mobility", "need.sign", "need.hearing"]);

export function normalizeInput(body) {
  const input = {};
  if (body.mobility !== undefined) {
    if (!MOBILITY_VALUES.has(body.mobility)) {
      throw new DomainError("validation:mobility", "mobility 取值不合法", { allowed: [...MOBILITY_VALUES] });
    }
    input.mobility = body.mobility;
  } else {
    input.mobility = "none";
  }
  if (body.companionCount !== undefined) {
    const n = Number(body.companionCount);
    if (!Number.isInteger(n) || n < 0 || n > 2) {
      throw new DomainError("validation:companion", "陪同人数必须为 0–2 的整数", { hardLimit: 2 });
    }
    input.companionCount = n;
  } else {
    input.companionCount = 0;
  }
  if (body.chairWidthMm !== undefined) {
    const w = Number(body.chairWidthMm);
    if (!Number.isFinite(w) || w <= 0) throw new DomainError("validation:width", "轮椅宽度不合法");
    input.chairWidthMm = w;
  }
  input.signLanguageNeeded = body.signLanguageNeeded === true;
  input.hearingAssistanceNeeded = body.hearingAssistanceNeeded === true;
  if (body.hearingCompatibility !== undefined) {
    if (!COMPATIBILITY_VALUES.has(body.hearingCompatibility)) {
      throw new DomainError("validation:compatibility", "助听器兼容特征不合法", {
        allowed: [...COMPATIBILITY_VALUES],
      });
    }
    input.hearingCompatibility = body.hearingCompatibility;
  }
  input.needsVolunteer = body.needsVolunteer === true || input.mobility === "wheelchair";
  if (typeof body.healthNote === "string") input.healthNote = body.healthNote;
  return input;
}

function validateConsent(input, scopes) {
  const granted = new Set(scopes ?? []);
  const missing = [];
  if (input.mobility !== "none" && !granted.has("need.mobility")) missing.push("need.mobility");
  if (input.signLanguageNeeded && !granted.has("need.sign")) missing.push("need.sign");
  if (input.hearingAssistanceNeeded && !granted.has("need.hearing")) missing.push("need.hearing");
  if (missing.length > 0) {
    throw new DomainError("consent:missing", "观众未授权处理该类需求信息", { missingScopes: missing });
  }
  return granted;
}

function appendTimeline(request, event, detail = {}) {
  request.fulfillment ??= { timeline: [], incidents: [] };
  request.fulfillment.timeline ??= [];
  request.fulfillment.timeline.push({ at: nowIso(), event, ...detail });
}

function assertRequest(state, id) {
  const request = state.requests?.[id];
  if (!request) throw new DomainError("request:not-found", "申请不存在", { requestId: id });
  return request;
}

// 创建或变更申请。购票后补充信息与再次修改走同一入口（幂等按内容版本处理）。
export function upsertRequest(state, body, { requestId = null } = {}) {
  const performance = getPerformance(state, body.performanceId);
  if (!performance) {
    throw new DomainError("performance:not-found", "演出场次不存在", {
      performanceId: body.performanceId,
    });
  }

  const isAmendment = requestId !== null;
  const existing = isAmendment ? assertRequest(state, requestId) : null;
  if (existing && ["cancelled", "closed"].includes(existing.status)) {
    throw new DomainError("request:terminal", "申请已取消或已闭环，不能再变更", {
      status: existing.status,
    });
  }

  const input = normalizeInput(body);
  const scopes = body.consentScopes ?? existing?.consent?.scopes ?? [];
  validateConsent(input, scopes);

  // 评估时排除自身旧占用，避免把自己的席位/设备算作冲突
  const evaluation = evaluateRequest(state, performance.id, input, {
    excludeRequestId: existing?.id ?? null,
  });

  if (evaluation.violations.length > 0) {
    throw new DomainError("constraint:violations", "存在硬约束冲突，无法锁定资源", {
      violations: evaluation.violations,
      alternatives: evaluation.alternatives,
      diagnostics: evaluation.diagnostics,
    });
  }

  const now = nowIso();
  let request;
  if (existing) {
    const oldFingerprint = planFingerprint(existing.plan);
    request = existing;
    request.input = input;
    request.consent = { scopes: [...new Set(scopes)], version: existing.consent.version, updatedAt: now };
    request.plan = evaluation.plan;
    request.updatedAt = now;
    request.version += 1;
    request.alternatives = [];
    appendTimeline(request, "amended", { version: request.version });
    const newFingerprint = planFingerprint(evaluation.plan);
    if (oldFingerprint !== newFingerprint) {
      enqueue(state, {
        requestId: request.id,
        type: "plan-change",
        dedupKey: newFingerprint,
        audience: "patron",
        summary: "您的无障碍服务安排已更新",
      });
    }
  } else {
    request = {
      id: newId("req"),
      performanceId: performance.id,
      ticketRef: body.ticketRef ?? null,
      patronId: body.patronId,
      patron: body.patron ?? null,
      input,
      consent: { scopes: [...new Set(scopes)], version: "consent-accessibility-v1", acceptedAt: now },
      plan: evaluation.plan,
      status: "confirmed",
      version: 1,
      createdAt: now,
      updatedAt: now,
      followupDueAt: followupDueAt(performance.startAt, now),
      alternatives: [],
      fulfillment: { timeline: [], incidents: [] },
      outcome: null,
    };
    state.requests ??= {};
    state.requests[request.id] = request;
    appendTimeline(request, "created");
  }

  ensureFollowup(state, request);
  // 每个申请只保留一条确认通知；相同方案重复提交不重发
  upsertConfirmation(state, request);
  return request;
}

export function cancelRequest(state, requestId, reason = "观众取消") {
  const request = assertRequest(state, requestId);
  if (request.status === "cancelled") throw new DomainError("request:cancelled", "申请已取消");
  request.status = "cancelled";
  request.updatedAt = nowIso();
  request.outcome = { kind: "cancelled", at: nowIso(), reason };
  appendTimeline(request, "cancelled", { reason });
  cancelPendingForRequest(state, requestId);
  enqueue(state, {
    requestId,
    type: "cancellation",
    dedupKey: "cancel",
    audience: "patron",
    summary: "无障碍服务申请已取消",
  });
  return request;
}

// 现场闭环操作：checkin / handover / exception / close
const HANDOVER_STATES = ["seated", "device-handover", "in-service", "device-returned"];

export function recordFulfillment(state, requestId, action, payload = {}) {
  const request = assertRequest(state, requestId);
  request.fulfillment ??= { timeline: [], incidents: [] };
  const now = nowIso();

  switch (action) {
    case "checkin": {
      if (request.status === "cancelled") throw new DomainError("request:cancelled", "申请已取消");
      request.fulfillment.checkedIn = true;
      request.fulfillment.checkedInAt = now;
      request.fulfillment.checkedInBy = payload.staffId ?? null;
      appendTimeline(request, "checked-in", { staffId: payload.staffId ?? null });
      break;
    }
    case "handover": {
      if (!request.fulfillment.checkedIn) {
        throw new DomainError("fulfillment:not-checked-in", "观众尚未签到，不能交接");
      }
      const handoverState = payload.handoverState;
      if (!HANDOVER_STATES.includes(handoverState)) {
        throw new DomainError("fulfillment:bad-state", "交接状态不合法", {
          allowed: HANDOVER_STATES,
        });
      }
      if (handoverState === "device-handover" && (request.plan.deviceIds ?? []).length === 0) {
        throw new DomainError("fulfillment:no-device", "该申请没有借用设备");
      }
      request.fulfillment.handoverState = handoverState;
      request.fulfillment.lastHandoverAt = now;
      request.fulfillment.lastHandoverBy = payload.staffId ?? null;
      appendTimeline(request, "handover", {
        handoverState,
        from: payload.staffId ?? null,
        to: payload.toStaffId ?? null,
      });
      break;
    }
    case "exception": {
      const incident = {
        id: newId("inc"),
        at: now,
        kind: payload.kind ?? "onsite-exception",
        note: payload.note ?? "",
        reportedBy: payload.staffId ?? null,
        resolution: null,
        rebookedTo: null,
      };
      request.fulfillment.incidents.push(incident);
      appendTimeline(request, "exception", { incidentId: incident.id, kind: incident.kind });
      // 异常发生后尝试生成可解释替代方案
      const alternatives = proposeAfterIncident(state, request);
      request.alternatives = alternatives;
      enqueue(state, {
        requestId,
        type: "incident-alternative",
        dedupKey: incident.id,
        audience: "staff",
        summary: `现场异常 ${incident.kind}，已生成 ${alternatives.length} 个替代方案`,
      });
      return { request, incident, alternatives };
    }
    case "resolve-incident": {
      const incident = request.fulfillment.incidents.find((i) => i.id === payload.incidentId);
      if (!incident) throw new DomainError("incident:not-found", "异常记录不存在");
      incident.resolution = payload.resolution ?? "已现场处置";
      incident.resolvedAt = now;
      appendTimeline(request, "incident-resolved", { incidentId: incident.id });
      break;
    }
    case "close": {
      request.status = "closed";
      request.fulfillment.closed = true;
      request.fulfillment.closedAt = now;
      request.outcome = { kind: "served", at: now };
      appendTimeline(request, "closed");
      cancelPendingForRequest(state, requestId);
      break;
    }
    default:
      throw new DomainError("fulfillment:bad-action", "不支持的现场操作", { action });
  }
  return { request };
}

// 异常后的替代方案：同场次重排（例如设备故障后换设备）优先，其次推荐转场
function proposeAfterIncident(state, request) {
  const alternatives = [];
  const evaluation = evaluateRequest(state, request.performanceId, request.input, {
    excludeRequestId: request.id,
  });
  if (evaluation.violations.length === 0 && evaluation.plan) {
    const fp = planFingerprint(evaluation.plan);
    if (fp !== planFingerprint(request.plan)) {
      alternatives.push({
        type: "rearrange",
        reason: "同场次存在可立即重排的席位/设备组合",
        plan: evaluation.plan,
      });
    }
  }
  for (const alt of evaluation.alternatives ?? []) alternatives.push(alt);
  if (alternatives.length === 0) {
    alternatives.push({
      type: "manual",
      reason: "没有可自动重排的资源，需值班经理人工协调或办理退改",
    });
  }
  return alternatives;
}
