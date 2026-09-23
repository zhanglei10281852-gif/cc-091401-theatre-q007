// 数据访问层：所有 SQL 集中于此，业务层只看到对象。
import { parseJsonArray } from "../domain/util.js";

const NEGATIVE_PREFIX = "SQLITE_CONSTRAINT";

export class Store {
  constructor(db) {
    this.db = db;
    this._statements = new Map();
  }

  prepare(sql) {
    let stmt = this._statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this._statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  one(sql, ...params) {
    return this.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  // ---------- 场次 ----------
  upsertPerformance(p) {
    this.run(
      `INSERT INTO performances (id, title, starts_at, ends_at, status, transferred_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
         status=excluded.status, transferred_to=excluded.transferred_to`,
      p.id, p.title, p.startsAt, p.endsAt, p.status ?? "scheduled", p.transferredTo ?? null, p.createdAt,
    );
  }

  getPerformance(id) {
    return this.one("SELECT * FROM performances WHERE id = ?", id);
  }

  listPerformances() {
    return this.all("SELECT * FROM performances ORDER BY starts_at");
  }

  setPerformanceStatus(id, status, transferredTo) {
    return this.run(
      "UPDATE performances SET status = ?, transferred_to = ? WHERE id = ?",
      status, transferredTo ?? null, id,
    );
  }

  // ---------- 席位 ----------
  upsertSeat(seat) {
    this.run(
      `INSERT INTO seats (id, performance_id, zone, label, kind, accessible_route, aisle_width_cm, adjacent_to, unavailable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         zone=excluded.zone, label=excluded.label, kind=excluded.kind,
         accessible_route=excluded.accessible_route, aisle_width_cm=excluded.aisle_width_cm,
         adjacent_to=excluded.adjacent_to, unavailable=excluded.unavailable`,
      seat.id, seat.performanceId, seat.zone, seat.label, seat.kind,
      seat.accessibleRoute ? 1 : 0, seat.aisleWidthCm ?? 0,
      seat.adjacentTo ?? null, seat.unavailable ? 1 : 0,
    );
  }

  setSeatUnavailable(seatId, unavailable) {
    return this.run("UPDATE seats SET unavailable = ? WHERE id = ?", unavailable ? 1 : 0, seatId);
  }

  getSeat(id) {
    return this.one("SELECT * FROM seats WHERE id = ?", id);
  }

  listSeats(performanceId) {
    return this.all("SELECT * FROM seats WHERE performance_id = ? ORDER BY zone, label", performanceId);
  }

  // 查找候选：未封闭、未被 active 分配占用；可选择忽略本申请已占席位（改约时重排）。
  findFreeSeats({ performanceId, kind, adjacentTo = null, ignoreRequestId = null }) {
    const rows = this.all(
      `SELECT s.* FROM seats s
       WHERE s.performance_id = ? AND s.kind = ? AND s.unavailable = 0
         AND (? IS NULL OR s.adjacent_to = ?)
         AND NOT EXISTS (
           SELECT 1 FROM allocations a
           WHERE a.resource_kind = 'seat' AND a.resource_id = s.id
             AND a.performance_id = s.performance_id AND a.status = 'active'
             AND (? IS NULL OR a.request_id <> ?))
       ORDER BY s.zone, s.label`,
      performanceId, kind, adjacentTo, adjacentTo, ignoreRequestId, ignoreRequestId,
    );
    return rows;
  }

  // ---------- 陪同票 ----------
  upsertCompanionQuota(performanceId, total) {
    this.run(
      `INSERT INTO companion_quota (performance_id, total) VALUES (?, ?)
       ON CONFLICT(performance_id) DO UPDATE SET total = excluded.total`,
      performanceId, total,
    );
  }

  getCompanionQuota(performanceId) {
    return this.one("SELECT * FROM companion_quota WHERE performance_id = ?", performanceId);
  }

  // 原子占票：余量不足时 changes=0，由调用方判定硬约束失败。
  tryConsumeCompanionQuota(performanceId, count) {
    const result = this.run(
      "UPDATE companion_quota SET total = total - ? WHERE performance_id = ? AND total >= ?",
      count, performanceId, count,
    );
    return result.changes === 1;
  }

  refundCompanionQuota(performanceId, count) {
    this.run("UPDATE companion_quota SET total = total + ? WHERE performance_id = ?", count, performanceId);
  }

  // ---------- 志愿者与班次 ----------
  upsertVolunteer(v) {
    this.run(
      `INSERT INTO volunteers (id, name, skills) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, skills=excluded.skills`,
      v.id, v.name, JSON.stringify(v.skills ?? []),
    );
  }

  getVolunteer(id) {
    const row = this.one("SELECT * FROM volunteers WHERE id = ?", id);
    return row ? { ...row, skills: parseJsonArray(row.skills) } : null;
  }

  upsertShift(volunteerId, performanceId) {
    this.run(
      `INSERT INTO volunteer_shifts (volunteer_id, performance_id, status) VALUES (?, ?, 'available')
       ON CONFLICT(volunteer_id, performance_id) DO UPDATE SET status='available'`,
      volunteerId, performanceId,
    );
  }

  releaseShift(volunteerId, performanceId) {
    return this.run(
      "UPDATE volunteer_shifts SET status='released' WHERE volunteer_id = ? AND performance_id = ?",
      volunteerId, performanceId,
    );
  }

  findFreeVolunteer({ performanceId, skill, ignoreRequestId = null }) {
    const rows = this.all(
      `SELECT v.*, vs.status AS shift_status FROM volunteers v
       JOIN volunteer_shifts vs ON vs.volunteer_id = v.id AND vs.performance_id = ?
       WHERE vs.status = 'available'
         AND NOT EXISTS (
           SELECT 1 FROM allocations a
           WHERE a.resource_kind = 'volunteer' AND a.resource_id = v.id
             AND a.performance_id = vs.performance_id AND a.status = 'active'
             AND (? IS NULL OR a.request_id <> ?))`,
      performanceId, ignoreRequestId, ignoreRequestId,
    );
    return rows
      .map((row) => ({ ...row, skills: parseJsonArray(row.skills) }))
      .find((row) => row.skills.includes(skill)) ?? null;
  }

  // ---------- 设备 ----------
  upsertDevice(d) {
    this.run(
      `INSERT INTO devices (id, type, model, compatible_needs, status)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type=excluded.type, model=excluded.model,
         compatible_needs=excluded.compatible_needs, status=excluded.status`,
      d.id, d.type, d.model, JSON.stringify(d.compatibleNeeds ?? []), d.status ?? "available",
    );
  }

  setDeviceStatus(deviceId, status) {
    return this.run("UPDATE devices SET status = ? WHERE id = ?", status, deviceId);
  }

  getDevice(id) {
    const row = this.one("SELECT * FROM devices WHERE id = ?", id);
    return row ? { ...row, compatible_needs: parseJsonArray(row.compatible_needs) } : null;
  }

  findFreeDevices({ performanceId, need, ignoreRequestId = null }) {
    const rows = this.all(
      `SELECT d.* FROM devices d
       WHERE d.status = 'available'
         AND NOT EXISTS (
           SELECT 1 FROM allocations a
           WHERE a.resource_kind = 'device' AND a.resource_id = d.id
             AND a.performance_id = ? AND a.status = 'active'
             AND (? IS NULL OR a.request_id <> ?))`,
      performanceId, ignoreRequestId, ignoreRequestId,
    );
    return rows
      .map((row) => ({ ...row, compatibleNeeds: parseJsonArray(row.compatible_needs) }))
      .filter((row) => row.compatibleNeeds.includes(need));
  }

  // ---------- 观众 ----------
  upsertPatron(p) {
    this.run(
      `INSERT INTO patrons (id, name, contact, consent_version, consent_scope, consent_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, contact=excluded.contact,
         consent_version=excluded.consent_version, consent_scope=excluded.consent_scope,
         consent_at=excluded.consent_at`,
      p.id, p.name, p.contact, p.consentVersion ?? "sample-v1",
      JSON.stringify(p.consentScope ?? ["fulfilment"]), p.consentAt,
    );
  }

  getPatron(id) {
    const row = this.one("SELECT * FROM patrons WHERE id = ?", id);
    return row ? { ...row, consent_scope: parseJsonArray(row.consent_scope) } : null;
  }

  // ---------- 申请 ----------
  insertRequest(r) {
    this.run(
      `INSERT INTO access_requests
        (id, patron_id, performance_id, ticket_ref, status, companion_count, needs,
         health_note, health_note_source, health_note_received_at, hearing_need, wheelchair_width_cm,
         notification_prefs, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      r.id, r.patronId, r.performanceId, r.ticketRef ?? null,
      r.status ?? "submitted", r.companionCount ?? 0, JSON.stringify(r.needs ?? []),
      r.healthNote ?? null, r.healthNoteSource ?? null, r.healthNoteReceivedAt ?? null,
      r.hearingNeed ?? null, r.wheelchairWidthCm ?? null,
      JSON.stringify(r.notificationPrefs ?? ["sms"]), r.createdAt, r.updatedAt,
    );
  }

  getRequest(id) {
    const row = this.one("SELECT * FROM access_requests WHERE id = ?", id);
    return hydrateRequest(row);
  }

  // 乐观锁更新：expectedVersion 不匹配时 changes=0。
  updateRequest(id, patch, expectedVersion, updatedAt) {
    const fields = [];
    const values = [];
    for (const [key, column] of [
      ["performanceId", "performance_id"],
      ["ticketRef", "ticket_ref"],
      ["status", "status"],
      ["companionCount", "companion_count"],
      ["needs", "needs"],
      ["healthNote", "health_note"],
      ["healthNoteSource", "health_note_source"],
      ["healthNoteReceivedAt", "health_note_received_at"],
      ["hearingNeed", "hearing_need"],
      ["wheelchairWidthCm", "wheelchair_width_cm"],
      ["notificationPrefs", "notification_prefs"],
    ]) {
      if (!(key in patch)) continue;
      let value = patch[key];
      if (key === "needs" || key === "notificationPrefs") value = JSON.stringify(value ?? []);
      fields.push(`${column} = ?`);
      values.push(value);
    }
    if (!fields.length) return true;
    fields.push("version = version + 1", "updated_at = ?");
    values.push(updatedAt, id, expectedVersion);
    const result = this.run(
      `UPDATE access_requests SET ${fields.join(", ")} WHERE id = ? AND version = ?`,
      ...values,
    );
    return result.changes === 1;
  }

  listRequestsForPerformance(performanceId) {
    return this.all("SELECT * FROM access_requests WHERE performance_id = ?", performanceId)
      .map(hydrateRequest);
  }

  // ---------- 分配台账 ----------
  insertAllocation(a) {
    this.run(
      `INSERT INTO allocations (id, request_id, performance_id, resource_kind, resource_id, detail, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      a.id, a.requestId, a.performanceId, a.resourceKind, a.resourceId,
      JSON.stringify(a.detail ?? {}), a.createdAt,
    );
  }

  listAllocations(requestId, status = "active") {
    return this.all(
      "SELECT * FROM allocations WHERE request_id = ? AND status = ? ORDER BY resource_kind",
      requestId, status,
    ).map((row) => ({ ...row, detail: safeJson(row.detail) }));
  }

  releaseAllocations(requestId) {
    return this.run("UPDATE allocations SET status='released' WHERE request_id = ? AND status='active'", requestId);
  }

  releaseAllocation(allocationId) {
    return this.run("UPDATE allocations SET status='released' WHERE id = ? AND status='active'", allocationId);
  }

  // ---------- 履约事件 ----------
  insertEvent(e) {
    this.run(
      `INSERT INTO fulfilment_events (id, request_id, performance_id, type, actor_role, actor_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      e.id, e.requestId, e.performanceId, e.type, e.actorRole, e.actorId ?? null,
      JSON.stringify(e.detail ?? {}), e.createdAt,
    );
  }

  listEvents(requestId) {
    return this.all(
      "SELECT * FROM fulfilment_events WHERE request_id = ? ORDER BY created_at",
      requestId,
    ).map((row) => ({ ...row, detail: safeJson(row.detail) }));
  }

  // ---------- 替代方案 ----------
  insertAlternative(a) {
    this.run(
      `INSERT INTO alternatives (id, request_id, trigger, reason, options, status, chosen_option, created_at)
       VALUES (?, ?, ?, ?, ?, 'proposed', NULL, ?)`,
      a.id, a.requestId, a.trigger, a.reason, JSON.stringify(a.options ?? []), a.createdAt,
    );
  }

  getAlternative(id) {
    const row = this.one("SELECT * FROM alternatives WHERE id = ?", id);
    return row ? { ...row, options: safeJson(row.options) } : null;
  }

  listAlternatives(requestId) {
    return this.all(
      "SELECT * FROM alternatives WHERE request_id = ? ORDER BY created_at DESC",
      requestId,
    ).map((row) => ({ ...row, options: safeJson(row.options) }));
  }

  resolveAlternative(id, status, chosenOption) {
    return this.run(
      "UPDATE alternatives SET status = ?, chosen_option = ? WHERE id = ? AND status = 'proposed'",
      status, chosenOption ?? null, id,
    );
  }

  expireProposedAlternatives(requestId) {
    this.run("UPDATE alternatives SET status='expired' WHERE request_id = ? AND status='proposed'", requestId);
  }

  // ---------- 通知 ----------
  insertNotification(n) {
    return this.run(
      `INSERT INTO notifications (id, request_id, template, channel, dedup_key, payload, status, scheduled_for, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(dedup_key) DO NOTHING`,
      n.id, n.requestId, n.template, n.channel, n.dedupKey,
      JSON.stringify(n.payload ?? {}), n.scheduledFor, n.createdAt,
    );
  }

  listDueNotifications(nowIso, limit = 100) {
    return this.all(
      "SELECT * FROM notifications WHERE status='pending' AND scheduled_for <= ? ORDER BY scheduled_for LIMIT ?",
      nowIso, limit,
    ).map((row) => ({ ...row, payload: safeJson(row.payload) }));
  }

  listNotifications(requestId) {
    return this.all(
      "SELECT * FROM notifications WHERE request_id = ? ORDER BY scheduled_for",
      requestId,
    ).map((row) => ({ ...row, payload: safeJson(row.payload) }));
  }

  markNotificationSent(id, sentAt) {
    this.run("UPDATE notifications SET status='sent', sent_at=?, attempt_count=attempt_count+1 WHERE id=?", sentAt, id);
  }

  // 转场后，旧场次尚未发送的提醒作废，避免打扰。
  suppressPendingReminders(requestId, oldPerformanceId) {
    this.run(
      `UPDATE notifications SET status='suppressed'
       WHERE request_id = ? AND status = 'pending' AND template = 'service-reminder'
         AND json_extract(payload, '$.performanceId') = ?`,
      requestId, oldPerformanceId,
    );
  }

  // ---------- 脱敏履约记录 ----------
  upsertFulfilmentRecord(record) {
    this.run(
      `INSERT INTO fulfilment_records (request_id, performance_id, patron_ref, services, summary, checked_in_at, fulfilled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET services=excluded.services, summary=excluded.summary,
         checked_in_at=excluded.checked_in_at, fulfilled_at=excluded.fulfilled_at`,
      record.requestId, record.performanceId, record.patronRef,
      JSON.stringify(record.services ?? []), record.summary,
      record.checkedInAt ?? null, record.fulfilledAt ?? null, record.createdAt,
    );
  }

  listFulfilmentRecords(performanceId) {
    return this.all(
      "SELECT * FROM fulfilment_records WHERE performance_id = ? ORDER BY fulfilled_at",
      performanceId,
    ).map(hydrateRecord);
  }

  listAllFulfilmentRecords() {
    return this.all("SELECT * FROM fulfilment_records ORDER BY performance_id, fulfilled_at")
      .map(hydrateRecord);
  }
}

function hydrateRequest(row) {
  if (!row) return null;
  return {
    ...row,
    needs: parseJsonArray(row.needs),
    notificationPrefs: parseJsonArray(row.notification_prefs),
  };
}

function hydrateRecord(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    performanceId: row.performance_id,
    patronRef: row.patron_ref,
    services: safeJson(row.services),
    summary: row.summary,
    checkedInAt: row.checked_in_at,
    fulfilledAt: row.fulfilled_at,
    createdAt: row.created_at,
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value ?? "null") ?? {};
  } catch {
    return {};
  }
}

// node:sqlite 约束冲突错误码以 SQLITE_CONSTRAINT 开头。
export function isConstraintError(error) {
  return typeof error?.code === "string" && error.code.startsWith(NEGATIVE_PREFIX);
}
