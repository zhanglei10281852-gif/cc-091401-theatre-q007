// 隐私：按角色最小可见。敏感健康信息只对授权的履约角色开放；客服只看到服务编排所需的非敏感字段。
import { createHash } from "node:crypto";
import { ROLES } from "./constants.js";

const SENSITIVE_FIELDS = ["health_note", "healthNote"];

// 不可逆化名：演出结束后的履约记录不出现真实姓名/联系方式。
export function pseudonymize(patronId) {
  const hash = createHash("sha256").update(`patron:${patronId}`).digest("hex").slice(0, 12);
  return `P-${hash}`;
}

export function canViewHealth(role, patron) {
  if (role === ROLES.ADMIN) return true;
  if (role !== ROLES.FULFILMENT) return false;
  const scope = patron?.consent_scope ?? patron?.consentScope ?? ["fulfilment"];
  return scope.includes(ROLES.FULFILMENT);
}

// 申请序列化：客服视角下健康备注与精确身体参数被移除，仅保留服务类型与必要的匹配结论。
export function redactRequest(request, role, patron) {
  const base = {
    id: request.id,
    patronId: request.patron_id,
    performanceId: request.performance_id,
    ticketRef: request.ticket_ref ?? null,
    status: request.status,
    companionCount: request.companion_count,
    needs: request.needs,
    version: request.version,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
  };
  if (canViewHealth(role, patron)) {
    return {
      ...base,
      healthNote: request.health_note ?? null,
      healthNoteSource: request.health_note_source ?? null,
      healthNoteReceivedAt: request.health_note_received_at ?? null,
      hearingNeed: request.hearing_need ?? null,
      wheelchairWidthCm: request.wheelchair_width_cm ?? null,
    };
  }
  // 客服只看到是否有相关需求，不看到健康细节；身体参数以区间形式出现。
  return {
    ...base,
    healthNote: null,
    healthNotePresent: Boolean(request.health_note),
    hearingNeed: request.hearing_need ? "registered" : null,
    wheelchairWidthCm: request.wheelchair_width_cm != null ? "registered" : null,
  };
}

export { SENSITIVE_FIELDS };
