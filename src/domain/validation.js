// 入站校验：只接受白名单字段，给出可解释的中文错误。
import { SERVICE_TYPES } from "./constants.js";
import { isValidIso } from "./util.js";
import { badRequest } from "./errors.js";

export function validateCreateRequest(body, { performance, patronExists }) {
  if (!body || typeof body !== "object") throw badRequest("invalid_body", "请求体必须是 JSON 对象");
  if (!body.patronId || typeof body.patronId !== "string") throw badRequest("invalid_patron", "缺少 patronId");
  if (!patronExists) throw badRequest("patron_not_found", "观众档案不存在");
  if (!performance) throw badRequest("performance_not_found", "演出场次不存在");

  const needs = validateNeeds(body.needs);
  const companionCount = validateCompanionCount(body.companionCount);
  const hearingNeed = needs.includes("hearing-device")
    ? validateHearingNeed(body.hearingNeed)
    : (body.hearingNeed ?? null);
  const wheelchairWidthCm = needs.includes("wheelchair-seat")
    ? validateWidth(body.wheelchairWidthCm)
    : (body.wheelchairWidthCm ?? null);

  if (body.ticketRef !== undefined && typeof body.ticketRef !== "string") {
    throw badRequest("invalid_ticket_ref", "ticketRef 必须是字符串");
  }
  if (body.healthNote !== undefined && body.healthNote !== null && typeof body.healthNote !== "string") {
    throw badRequest("invalid_health_note", "healthNote 必须是字符串");
  }
  if (body.healthNoteSource !== undefined && body.healthNoteSource !== null && typeof body.healthNoteSource !== "string") {
    throw badRequest("invalid_health_note_source", "healthNoteSource 必须是字符串");
  }
  if (body.healthNoteReceivedAt !== undefined && body.healthNoteReceivedAt !== null && !isValidIso(body.healthNoteReceivedAt)) {
    throw badRequest("invalid_received_at", "healthNoteReceivedAt 必须是 ISO 8601 时间");
  }
  const notificationPrefs = validateChannels(body.notificationPrefs);

  return {
    patronId: body.patronId,
    performanceId: performance.id,
    ticketRef: body.ticketRef ?? null,
    needs,
    companionCount,
    hearingNeed,
    wheelchairWidthCm,
    healthNote: body.healthNote ?? null,
    healthNoteSource: body.healthNoteSource ?? null,
    healthNoteReceivedAt: body.healthNoteReceivedAt ?? null,
    notificationPrefs,
  };
}

// 购票后补充/变更：仅允许白名单字段，needs 变化时联动重算约束参数。
export function validateAmend(body, current) {
  if (!body || typeof body !== "object") throw badRequest("invalid_body", "请求体必须是 JSON 对象");
  const patch = {};
  if ("ticketRef" in body) {
    if (typeof body.ticketRef !== "string" && body.ticketRef !== null) {
      throw badRequest("invalid_ticket_ref", "ticketRef 必须是字符串或 null");
    }
    patch.ticketRef = body.ticketRef;
  }
  let needs = current.needs;
  if ("needs" in body) {
    needs = validateNeeds(body.needs);
    patch.needs = needs;
  }
  if ("companionCount" in body) {
    patch.companionCount = validateCompanionCount(body.companionCount);
  }
  if ("healthNote" in body) {
    if (typeof body.healthNote !== "string" && body.healthNote !== null) {
      throw badRequest("invalid_health_note", "healthNote 必须是字符串或 null");
    }
    patch.healthNote = body.healthNote;
  }
  if ("healthNoteSource" in body) {
    if (typeof body.healthNoteSource !== "string" && body.healthNoteSource !== null) {
      throw badRequest("invalid_health_note_source", "healthNoteSource 必须是字符串或 null");
    }
    patch.healthNoteSource = body.healthNoteSource;
  }
  if ("healthNoteReceivedAt" in body) {
    if (body.healthNoteReceivedAt !== null && !isValidIso(body.healthNoteReceivedAt)) {
      throw badRequest("invalid_received_at", "healthNoteReceivedAt 必须是 ISO 8601 时间或 null");
    }
    patch.healthNoteReceivedAt = body.healthNoteReceivedAt;
  }
  if ("hearingNeed" in body || needs.includes("hearing-device")) {
    if (needs.includes("hearing-device")) {
      const value = body.hearingNeed ?? current.hearing_need ?? "none";
      patch.hearingNeed = validateHearingNeed(value);
    } else {
      patch.hearingNeed = null; // 服务已移除，清除兼容需求
    }
  }
  if ("wheelchairWidthCm" in body || needs.includes("wheelchair-seat")) {
    const value = body.wheelchairWidthCm ?? current.wheelchair_width_cm;
    patch.wheelchairWidthCm = needs.includes("wheelchair-seat")
      ? validateWidth(value)
      : null;
  }
  if ("notificationPrefs" in body) {
    patch.notificationPrefs = validateChannels(body.notificationPrefs);
  }
  return patch;
}

export function validatePerformance(body) {
  for (const field of ["id", "title", "startsAt", "endsAt"]) {
    if (!body?.[field] || typeof body[field] !== "string") {
      throw badRequest("invalid_performance", `缺少字段 ${field}`);
    }
  }
  if (!isValidIso(body.startsAt) || !isValidIso(body.endsAt)) {
    throw badRequest("invalid_time", "startsAt/endsAt 必须是带偏移量的 ISO 8601 时间");
  }
  if (Date.parse(body.endsAt) <= Date.parse(body.startsAt)) {
    throw badRequest("invalid_time", "endsAt 必须晚于 startsAt");
  }
  return {
    id: body.id,
    title: body.title,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
  };
}

function validateNeeds(value) {
  if (!Array.isArray(value) || !value.length) throw badRequest("invalid_needs", "needs 必须是非空数组");
  const needs = [...new Set(value)];
  for (const need of needs) {
    if (!SERVICE_TYPES.includes(need)) {
      throw badRequest("invalid_needs", `未知服务类型：${need}`);
    }
  }
  return needs;
}

function validateCompanionCount(value) {
  const count = value ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > 6) {
    throw badRequest("invalid_companion_count", "陪同人数必须是 0–6 的整数");
  }
  return count;
}

function validateHearingNeed(value) {
  const allowed = ["t-coil", "bluetooth", "none", "captioning"];
  const need = value ?? "none";
  if (!allowed.includes(need)) {
    throw badRequest("invalid_hearing_need", `助听兼容需求必须是 ${allowed.join("/")}`);
  }
  return need;
}

function validateWidth(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0 || value > 200) {
    throw badRequest("invalid_width", "轮椅宽度必须是 1–200 cm 的整数");
  }
  return value;
}

function validateChannels(value) {
  const channels = value ?? ["sms"];
  const allowed = ["sms", "email", "push"];
  if (!Array.isArray(channels) || channels.some((c) => !allowed.includes(c))) {
    throw badRequest("invalid_channels", `通知渠道必须是 ${allowed.join("/")} 的数组`);
  }
  return channels;
}
