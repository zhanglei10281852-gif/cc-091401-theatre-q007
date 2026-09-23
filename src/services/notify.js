import { createHash } from "node:crypto";
import { newId } from "../domain/ids.js";
import { nowIso } from "../domain/time.js";

// 通知以 (requestId, type, dedupKey) 去重：同内容的重复操作不会再次打扰观众。
// 所有通知落盘（含 dueAt），进程重启后调度器只按原截止点扫描 pending 行，
// 不重新计算、不重复发送。

export function planFingerprint(plan) {
  if (!plan) return "none";
  const canonical = JSON.stringify({
    s: plan.seatId,
    c: [...(plan.companionSeatIds ?? [])].sort(),
    i: plan.interpreter,
    d: [...(plan.deviceIds ?? [])].sort(),
    h: plan.shiftId,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

function findDuplicate(state, requestId, type, dedupKey) {
  return (state.notifications ?? []).find(
    (n) =>
      n.requestId === requestId &&
      n.type === type &&
      n.dedupKey === dedupKey &&
      (n.status === "pending" || n.status === "sent"),
  );
}

// audience: "patron"（观众本人，受 contact.notify 授权约束）或 "staff"（履约人员）
export function enqueue(state, { requestId, type, dedupKey, audience, summary, dueAt = nowIso() }) {
  const existing = findDuplicate(state, requestId, type, dedupKey);
  if (existing) return { notification: existing, duplicated: true };
  state.notifications ??= [];
  const notification = {
    id: newId("ntf"),
    requestId,
    type,
    dedupKey,
    audience,
    summary,
    dueAt,
    status: "pending",
    createdAt: nowIso(),
    sentAt: null,
  };
  state.notifications.push(notification);
  return { notification, duplicated: false };
}

// 每个申请只有一条确认通知：方案变化时原地更新该行（实际变更另发 plan-change），
// 相同方案的重复提交不会再次打扰观众。
export function upsertConfirmation(state, request, fingerprint = planFingerprint(request.plan)) {
  state.notifications ??= [];
  let row = state.notifications.find((n) => n.requestId === request.id && n.type === "confirmation");
  if (!row) {
    row = {
      id: newId("ntf"),
      requestId: request.id,
      type: "confirmation",
      dedupKey: fingerprint,
      audience: "patron",
      summary: "无障碍服务已确认",
      dueAt: nowIso(),
      status: "pending",
      createdAt: nowIso(),
      sentAt: null,
    };
    state.notifications.push(row);
    return { notification: row, duplicated: false };
  }
  if (row.dedupKey === fingerprint) {
    // 方案未变：保留原发送状态，不重置、不重发
    return { notification: row, duplicated: true };
  }
  row.dedupKey = fingerprint;
  row.summary = "无障碍服务已确认（安排已更新）";
  row.dueAt = nowIso();
  row.status = "pending";
  row.sentAt = null;
  return { notification: row, duplicated: false };
}

// 履约跟进提醒：每个申请只有一行，截止点在创建时确定，变更/转场均不重置
export function ensureFollowup(state, request) {
  const key = "followup";
  const existing = findDuplicate(state, request.id, "reminder", key);
  if (existing) return existing;
  return enqueue(state, {
    requestId: request.id,
    type: "reminder",
    dedupKey: key,
    audience: "staff",
    summary: `申请 ${request.id} 需在演出前完成确认（截止 ${request.followupDueAt}）`,
    dueAt: request.followupDueAt,
  }).notification;
}

export function cancelPendingForRequest(state, requestId) {
  for (const n of state.notifications ?? []) {
    if (n.requestId === requestId && n.status === "pending") n.status = "cancelled";
  }
}

// 投递所有到期通知。sink 为实际发送通道（默认控制台），无 sink 时仅在状态机内流转。
export async function deliverDue(state, sink, at = nowIso()) {
  const delivered = [];
  for (const n of state.notifications ?? []) {
    if (n.status !== "pending") continue;
    if (Date.parse(n.dueAt) > Date.parse(at)) continue;
    const request = state.requests?.[n.requestId];
    // 观众未授权 contact.notify 的观众类通知不发送
    const scopes = request?.consent?.scopes ?? [];
    if (n.audience === "patron" && !scopes.includes("contact.notify")) {
      n.status = "suppressed";
      continue;
    }
    if (sink) await sink(n, request);
    n.status = "sent";
    n.sentAt = nowIso();
    delivered.push(n);
  }
  return delivered;
}
