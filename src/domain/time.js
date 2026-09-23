export function nowIso() {
  return new Date().toISOString();
}

export function toTime(value) {
  return Date.parse(value);
}

// 服务协调截止点（演出前 24 小时）；临时申请晚于该点时使用紧急截止点
export const FOLLOWUP_LEAD_HOURS = 24;
export const URGENT_FOLLOWUP_MINUTES = 30;
export const INCIDENT_FOLLOWUP_MINUTES = 15;

export function followupDueAt(performanceStartAt, createdAt = nowIso()) {
  const cutoff = toTime(performanceStartAt) - FOLLOWUP_LEAD_HOURS * 60 * 60 * 1000;
  const created = toTime(createdAt);
  if (cutoff > created) return new Date(cutoff).toISOString();
  return new Date(created + URGENT_FOLLOWUP_MINUTES * 60 * 1000).toISOString();
}
