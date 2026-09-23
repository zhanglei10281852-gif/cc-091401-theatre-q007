// 通知：dedup_key 唯一索引保证同一事件不重复打扰；scheduled_for 持久化绝对时间，
// 进程重启后未发送的提醒仍按原截止点补发/续发。
import { id, nowIso } from "../domain/util.js";

export function scheduleNotification(store, {
  requestId, template, channel, dedupKey, scheduledFor, payload = {}, createdAt,
}) {
  const result = store.insertNotification({
    id: id("ntf"),
    requestId,
    template,
    channel,
    dedupKey,
    payload,
    scheduledFor,
    createdAt: createdAt ?? nowIso(),
  });
  // changes=0 表示命中 dedup：重复通知被静默抑制。
  return result.changes === 1 ? "scheduled" : "suppressed";
}

// 申请确认/变更/取消等即时通知的统一去重键。
export function dedupKey(requestId, template, channel = "sms", variant = "") {
  return [requestId, template, channel, variant].filter(Boolean).join(":");
}

export function createNotificationDispatcher(store, { send, intervalMs = 15_000, clock = () => new Date(), logger } = {}) {
  let timer = null;
  const sender = send ?? defaultSender(logger);

  async function flushDue() {
    const due = store.listDueNotifications(nowIso(clock()));
    const results = [];
    for (const notification of due) {
      try {
        await sender(notification);
        store.markNotificationSent(notification.id, nowIso(clock()));
        results.push({ id: notification.id, status: "sent" });
      } catch (error) {
        // 保留 pending，下个 tick 重试，截止点不变。
        results.push({ id: notification.id, status: "failed", error: String(error?.message ?? error) });
      }
    }
    return results;
  }

  return {
    flushDue,
    start() {
      if (timer) return;
      // 启动立即补一次：重启前积压的提醒按原 scheduled_for 补发。
      flushDue().catch(() => {});
      timer = setInterval(() => { flushDue().catch(() => {}); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function defaultSender(logger) {
  return async (notification) => {
    logger?.(`通知已发送 ${notification.channel}:${notification.template} -> 申请 ${notification.request_id}`);
  };
}
