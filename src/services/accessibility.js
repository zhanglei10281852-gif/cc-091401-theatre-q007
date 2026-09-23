// 无障碍申请编排：申请/变更/取消/转场/故障/现场闭环，全部在事务内锁定资源。
import { REQUEST_STATUS, ROLES } from "../domain/constants.js";
import { badRequest, conflict, forbidden, notFound } from "../domain/errors.js";
import { id, nowIso, parseTime } from "../domain/util.js";
import { commitPlan, findAlternatives, PlanningError, replanSamePerformance } from "../domain/planning.js";
import { pseudonymize, redactRequest } from "../domain/privacy.js";
import { withTransaction } from "../db/sqlite.js";
import { scheduleNotification, dedupKey as makeDedupKey } from "./notifications.js";

const REMINDER_LEAD_MS = 60 * 60 * 1000; // 开场前 1 小时提醒

export class AccessibilityService {
  constructor(store, { clock = () => new Date() } = {}) {
    this.store = store;
    this.clock = clock;
  }

  // ---------- 申请 ----------
  createRequest(input) {
    const now = nowIso(this.clock());
    return this._tx(() => {
      const requestId = id("req");
      this.store.insertRequest({ ...input, id: requestId, status: REQUEST_STATUS.SUBMITTED, createdAt: now, updatedAt: now });
      const request = this.store.getRequest(requestId);
      const result = this._planAndConfirm(request, { now, trigger: "planning", notifyVariant: "create" });
      return result;
    });
  }

  // 购票后补充或变更：乐观锁 + 重排。
  amendRequest(requestId, patch, expectedVersion) {
    const now = nowIso(this.clock());
    return this._tx(() => {
      const current = this.store.getRequest(requestId);
      if (!current) throw notFound("request_not_found", "申请不存在");
      if (current.status === REQUEST_STATUS.CANCELLED) {
        throw conflict("request_cancelled", "申请已取消，不能变更；请重新提交");
      }
      if (current.status === REQUEST_STATUS.FULFILLED) {
        throw conflict("request_fulfilled", "演出已履约，不能变更");
      }
      if (expectedVersion !== undefined && expectedVersion !== current.version) {
        throw conflict("version_conflict", "申请已被他人修改，请基于最新版本重试", {
          currentVersion: current.version,
        });
      }
      const updated = this.store.updateRequest(requestId, patch, current.version, now);
      if (!updated) {
        throw Object.assign(new Error("version_race"), { race: true });
      }
      const request = this.store.getRequest(requestId);

      // 仅元数据变更（票号、健康备注、通知偏好）不影响资源，无需重排。
      const resourceFields = ["needs", "companionCount", "hearingNeed", "wheelchairWidthCm"];
      const touchesResources = resourceFields.some((key) => key in patch);
      if (!touchesResources) {
        return {
          requestId, status: request.status, version: request.version,
          allocations: this.store.listAllocations(requestId),
        };
      }

      // 尚未确认（资源不足候补中）：重新尝试规划。
      if (current.status === REQUEST_STATUS.SUBMITTED || current.status === REQUEST_STATUS.REPLANNING) {
        return this._planAndConfirm(request, { now, trigger: "planning", notifyVariant: `amend-v${request.version}` });
      }
      // 已确认：释放旧资源后按新需求重排；失败则保留替代方案，申请回到候补中。
      this._releaseResources(request, { refund: true });
      return this._planAndConfirm(request, { now, trigger: "amend", notifyVariant: `amend-v${request.version}` });
    });
  }

  cancelRequest(requestId, { reason = "customer_cancelled" } = {}) {
    const now = nowIso(this.clock());
    return this._tx(() => {
      const request = this.store.getRequest(requestId);
      if (!request) throw notFound("request_not_found", "申请不存在");
      if (request.status === REQUEST_STATUS.CANCELLED) return { requestId, status: REQUEST_STATUS.CANCELLED, alreadyCancelled: true };
      if (request.status === REQUEST_STATUS.FULFILLED) {
        throw conflict("request_fulfilled", "演出已履约，不能取消");
      }
      this._releaseResources(request, { refund: true });
      this.store.updateRequest(requestId, { status: REQUEST_STATUS.CANCELLED }, request.version, now);
      this.store.expireProposedAlternatives(requestId);
      this._notify(request, "request-cancelled", now, { reason });
      return { requestId, status: REQUEST_STATUS.CANCELLED };
    });
  }

  // ---------- 转场：场次整体调整 ----------
  transferPerformance(performanceId, targetPerformanceId, reason) {
    const now = nowIso(this.clock());
    return this._tx(() => {
      const target = this.store.getPerformance(targetPerformanceId);
      if (!target) throw badRequest("target_performance_not_found", "目标场次不存在");
      if (target.status !== "scheduled") throw badRequest("target_not_schedulable", "目标场次不可安排");
      this.store.setPerformanceStatus(performanceId, "transferred", targetPerformanceId);

      const results = [];
      for (const request of this.store.listRequestsForPerformance(performanceId)) {
        if (request.status === REQUEST_STATUS.CANCELLED || request.status === REQUEST_STATUS.FULFILLED) continue;
        // 旧场次未发送的提醒作废，避免转场后重复打扰。
        this.store.suppressPendingReminders(request.id, performanceId);
        this._releaseResources(request, { refund: true });
        const movedOk = this.store.updateRequest(
          request.id,
          { performanceId: targetPerformanceId, status: REQUEST_STATUS.REPLANNING },
          request.version, now,
        );
        if (!movedOk) throw Object.assign(new Error("version_race"), { race: true });

        let refreshed = this.store.getRequest(request.id);
        let outcome;
        try {
          commitPlan(this.store, refreshed, { now, trigger: "transfer" });
          const confirmOk = this.store.updateRequest(refreshed.id, { status: REQUEST_STATUS.CONFIRMED }, refreshed.version, now);
          if (!confirmOk) throw Object.assign(new Error("version_race"), { race: true });
          refreshed = this.store.getRequest(request.id);
          this._notify(refreshed, "transfer-confirmed", now, {
            from: performanceId, to: targetPerformanceId, reason,
          }, target);
          this._scheduleReminder(refreshed, target, now);
          outcome = "confirmed-on-target";
        } catch (error) {
          if (!(error instanceof PlanningError)) throw error;
          // 规划失败发生在任何落账之前；申请留在目标场次的 replanning 状态等待选择。
          this._proposeAlternatives(this.store.getRequest(request.id), error.violations, now, "transfer");
          this._notify(this.store.getRequest(request.id), "transfer-alternatives", now, {
            from: performanceId, to: targetPerformanceId, reason,
          }, target);
          outcome = "alternatives-proposed";
        }
        results.push({ requestId: request.id, outcome });
      }
      return { performanceId, targetPerformanceId, results };
    });
  }

  // ---------- 临时资源故障：席位封闭 / 设备故障 / 志愿者班次释放 ----------
  reportResourceFailure(kind, resourceId, performanceId, detail = {}) {
    const now = nowIso(this.clock());
    return this._tx(() => {
      if (kind === "seat") {
        const seat = this.store.getSeat(resourceId);
        if (!seat) throw notFound("seat_not_found", "席位不存在");
        this.store.setSeatUnavailable(resourceId, true);
      } else if (kind === "device") {
        const device = this.store.getDevice(resourceId);
        if (!device) throw notFound("device_not_found", "设备不存在");
        this.store.setDeviceStatus(resourceId, "faulty");
      } else if (kind === "volunteer") {
        this.store.releaseShift(resourceId, performanceId);
      } else {
        throw badRequest("invalid_resource_kind", "资源类型必须是 seat/device/volunteer");
      }

      const affected = this._activeRequestsUsing(kind, resourceId, performanceId);
      const results = [];
      for (const request of affected) {
        // 记录现场异常
        this.store.insertEvent({
          id: id("evt"), requestId: request.id, performanceId: request.performance_id,
          type: "exception", actorRole: ROLES.FULFILMENT,
          detail: { kind, resourceId, ...detail }, createdAt: now,
        });
        this._releaseResources(request, { refund: true });
        const replan = replanSamePerformance(this.store, request, { now });
        if (replan && !replan.failed) {
          this.store.updateRequest(request.id, { status: REQUEST_STATUS.CONFIRMED }, request.version, now);
          this._notify(request, "resource-reswapped", now, { kind, resourceId });
          results.push({ requestId: request.id, outcome: "replanned-same-performance" });
        } else {
          this.store.updateRequest(request.id, { status: REQUEST_STATUS.REPLANNING }, request.version, now);
          const violations = replan?.violations ?? [{
            code: "resource_failed", message: `资源 ${kind}/${resourceId} 临时故障且同场无替代`,
          }];
          this._proposeAlternatives(this.store.getRequest(request.id), violations, now, "resource-failure");
          this._notify(request, "resource-failure", now, { kind, resourceId });
          results.push({ requestId: request.id, outcome: "alternatives-proposed" });
        }
      }
      return { kind, resourceId, performanceId, affectedCount: affected.length, results };
    });
  }

  // ---------- 接受替代方案 ----------
  acceptAlternative(alternativeId, optionIndex, expectedVersion) {
    const now = nowIso(this.clock());
    return this._tx(() => {
      const alternative = this.store.getAlternative(alternativeId);
      if (!alternative) throw notFound("alternative_not_found", "替代方案不存在");
      if (alternative.status !== "proposed") throw conflict("alternative_resolved", `方案已${alternative.status}`);
      const option = alternative.options[optionIndex];
      if (!option) throw badRequest("invalid_option", "选项序号无效");

      const request = this.store.getRequest(alternative.request_id);
      if (expectedVersion !== undefined && expectedVersion !== request.version) {
        throw conflict("version_conflict", "申请已变更，请刷新后重试", { currentVersion: request.version });
      }

      if (option.type === "transfer" && option.performanceId) {
        this.store.suppressPendingReminders(request.id, request.performance_id);
        this._releaseResources(request, { refund: true });
        const moved = { ...request, performance_id: option.performanceId };
        try {
          commitPlan(this.store, moved, { now, trigger: "transfer-accepted" });
        } catch (error) {
          if (error instanceof PlanningError) {
            throw conflict("alternative_no_longer_available", "该转场选项的资源已被占用", { violations: error.violations });
          }
          throw error;
        }
        const movedOk = this.store.updateRequest(
          request.id, { performanceId: option.performanceId, status: REQUEST_STATUS.CONFIRMED },
          request.version, now,
        );
        if (!movedOk) throw Object.assign(new Error("version_race"), { race: true });
        const target = this.store.getPerformance(option.performanceId);
        this._scheduleReminder(this.store.getRequest(request.id), target, now);
      } else if (option.type === "substitute_service" && option.service) {
        // 同场替代服务：如字幕接收器，按选项给定的兼容需求重排。
        const patch = { needs: [...new Set([...request.needs, option.service])] };
        if (option.hearingNeed) patch.hearingNeed = option.hearingNeed;
        const ok = this.store.updateRequest(request.id, patch, request.version, now);
        if (!ok) throw Object.assign(new Error("version_race"), { race: true });
        const refreshed = this.store.getRequest(request.id);
        this._releaseResources(refreshed, { refund: true });
        try {
          commitPlan(this.store, refreshed, { now, trigger: "substitute-accepted" });
        } catch (error) {
          if (error instanceof PlanningError) {
            throw conflict("alternative_no_longer_available", "替代服务当前不可用", { violations: error.violations });
          }
          throw error;
        }
        const confirmOk = this.store.updateRequest(refreshed.id, { status: REQUEST_STATUS.CONFIRMED }, refreshed.version, now);
        if (!confirmOk) throw Object.assign(new Error("version_race"), { race: true });
      } else if (option.type === "waitlist") {
        const ok = this.store.updateRequest(request.id, { status: REQUEST_STATUS.SUBMITTED }, request.version, now);
        if (!ok) throw Object.assign(new Error("version_race"), { race: true });
      } else if (option.type === "reduce_companions") {
        const reduced = Math.min(request.companion_count, option.maxCompanions ?? 0);
        const ok = this.store.updateRequest(request.id, { companionCount: reduced }, request.version, now);
        if (!ok) throw Object.assign(new Error("version_race"), { race: true });
        const refreshed = this.store.getRequest(request.id);
        this._releaseResources(refreshed, { refund: true });
        try {
          commitPlan(this.store, refreshed, { now, trigger: "reduce-companions-accepted" });
        } catch (error) {
          if (error instanceof PlanningError) {
            throw conflict("alternative_no_longer_available", "减少陪同后仍无法安排", { violations: error.violations });
          }
          throw error;
        }
        const confirmOk = this.store.updateRequest(refreshed.id, { status: REQUEST_STATUS.CONFIRMED }, refreshed.version, now);
        if (!confirmOk) throw Object.assign(new Error("version_race"), { race: true });
      } else {
        throw badRequest("unsupported_option", "该选项类型暂不支持在线确认");
      }

      const chosen = JSON.stringify(option);
      this.store.resolveAlternative(alternativeId, "accepted", chosen);
      this.store.expireProposedAlternatives(request.id);
      const finalRequest = this.store.getRequest(request.id);
      this._notify(finalRequest, "alternative-confirmed", now, { option: option.type });
      return { requestId: request.id, status: finalRequest.status, option };
    });
  }

  rejectAlternative(alternativeId) {
    const result = this.store.resolveAlternative(alternativeId, "rejected", null);
    if (result.changes !== 1) throw conflict("alternative_resolved", "方案不存在或已处理");
    return { alternativeId, status: "rejected" };
  }

  // ---------- 现场闭环：签到 / 交接 / 异常 ----------
  recordFulfilmentEvent(requestId, type, actor, detail = {}) {
    const now = nowIso(this.clock());
    return this._tx(() => {
      const request = this.store.getRequest(requestId);
      if (!request) throw notFound("request_not_found", "申请不存在");
      if (request.status === REQUEST_STATUS.CANCELLED) throw conflict("request_cancelled", "申请已取消");
      if (actor?.role !== ROLES.FULFILMENT && actor?.role !== ROLES.ADMIN) {
        throw forbidden("forbidden", "仅现场履约角色可记录现场事件");
      }
      const event = {
        id: id("evt"), requestId, performanceId: request.performance_id,
        type, actorRole: actor.role, actorId: actor.id ?? null, detail, createdAt: now,
      };
      this.store.insertEvent(event);
      // 允许先交接后签到：签到时若所有分配已交接，同样闭环。
      if (type === "check-in") {
        const closure = this._maybeFulfil(this.store.getRequest(requestId), now);
        return { ...event, closure };
      }
      return event;
    });
  }

  // 交接：逐项确认分配的服务资源已交付；全部 active 分配完成则申请闭环。
  handoff(requestId, allocationId, actor, detail = {}) {
    const now = nowIso(this.clock());
    return this._tx(() => {
      const request = this.store.getRequest(requestId);
      if (!request) throw notFound("request_not_found", "申请不存在");
      if (actor?.role !== ROLES.FULFILMENT && actor?.role !== ROLES.ADMIN) {
        throw forbidden("forbidden", "仅现场履约角色可交接");
      }
      const allocation = this.store.listAllocations(requestId).find((a) => a.id === allocationId);
      if (!allocation) throw notFound("allocation_not_found", "分配不存在或已释放");
      this.store.insertEvent({
        id: id("evt"), requestId, performanceId: request.performance_id,
        type: "handoff", actorRole: actor.role, actorId: actor.id ?? null,
        detail: { allocationId, resourceKind: allocation.resource_kind, resourceId: allocation.resource_id, ...detail },
        createdAt: now,
      });
      return this._maybeFulfil(request, now);
    });
  }

  // 异常接口：现场无法交付时记录并触发同场重排/替代方案。
  reportException(requestId, actor, detail) {
    const now = nowIso(this.clock());
    return this._tx(() => {
      const request = this.store.getRequest(requestId);
      if (!request) throw notFound("request_not_found", "申请不存在");
      if (actor?.role !== ROLES.FULFILMENT && actor?.role !== ROLES.ADMIN) {
        throw forbidden("forbidden", "仅现场履约角色可上报异常");
      }
      this.store.insertEvent({
        id: id("evt"), requestId, performanceId: request.performance_id,
        type: "exception", actorRole: actor.role, actorId: actor.id ?? null, detail, createdAt: now,
      });
      if (detail?.resourceKind && detail?.resourceId) {
        // 整组释放后按原需求整体重排，避免部分重排与既有台账自冲突。
        this._releaseResources(request, { refund: true });
        const replan = replanSamePerformance(this.store, request, { now });
        if (replan && !replan.failed) {
          this.store.updateRequest(request.id, { status: REQUEST_STATUS.CONFIRMED }, request.version, now);
          this._notify(request, "resource-reswapped", now, detail);
          return { requestId, outcome: "replanned-same-performance" };
        }
        this.store.updateRequest(request.id, { status: REQUEST_STATUS.REPLANNING }, request.version, now);
        this._proposeAlternatives(this.store.getRequest(request.id), replan?.violations ?? [{
          code: "onsite_exception", message: detail.message ?? "现场异常，同场无替代",
        }], now, "resource-failure");
        this._notify(request, "resource-failure", now, detail);
        return { requestId, outcome: "alternatives-proposed" };
      }
      return { requestId, outcome: "exception-recorded" };
    });
  }

  getRequestView(requestId, role) {
    const request = this.store.getRequest(requestId);
    if (!request) throw notFound("request_not_found", "申请不存在");
    const patron = this.store.getPatron(request.patron_id);
    const view = redactRequest(request, role, patron);
    view.allocations = this.store.listAllocations(requestId).map((a) => ({
      id: a.id,
      resourceKind: a.resource_kind,
      resourceId: a.resource_id,
      detail: role === ROLES.CUSTOMER_SERVICE ? sanitizeDetail(a.detail) : a.detail,
      status: a.status,
      createdAt: a.created_at,
    }));
    view.events = this.store.listEvents(requestId).map((e) => ({
      id: e.id,
      type: e.type,
      actorRole: e.actor_role,
      actorId: e.actor_id,
      detail: role === ROLES.CUSTOMER_SERVICE ? sanitizeEvent(e).detail : e.detail,
      createdAt: e.created_at,
    }));
    view.alternatives = this.store.listAlternatives(requestId).map((a) => ({
      id: a.id,
      trigger: a.trigger,
      reason: a.reason,
      options: a.options,
      status: a.status,
      chosenOption: safeParseOption(a.chosen_option),
      createdAt: a.created_at,
    }));
    return view;
  }

  // ---------- 演出结束：脱敏履约记录 ----------
  closePerformance(performanceId) {
    const now = nowIso(this.clock());
    return this._tx(() => {
      const performance = this.store.getPerformance(performanceId);
      if (!performance) throw notFound("performance_not_found", "场次不存在");
      this.store.setPerformanceStatus(performanceId, "closed", performance.transferred_to);
      const records = [];
      for (const request of this.store.listRequestsForPerformance(performanceId)) {
        const events = this.store.listEvents(request.id);
        const checkIn = events.find((e) => e.type === "check-in");
        const active = this.store.listAllocations(request.id);
        const handedOff = new Set(
          events.filter((e) => e.type === "handoff").map((e) => e.detail?.allocationId),
        );
        const allHandedOff = active.length > 0 && active.every((a) => handedOff.has(a.id));
        const fulfilledAt = allHandedOff ? (events.filter((e) => e.type === "handoff").at(-1)?.created_at ?? now) : null;
        if (allHandedOff && request.status !== REQUEST_STATUS.FULFILLED) {
          this.store.updateRequest(request.id, { status: REQUEST_STATUS.FULFILLED }, request.version, now);
        }
        const services = active.map((a) => a.resource_kind);
        const record = {
          requestId: request.id,
          performanceId,
          patronRef: pseudonymize(request.patron_id),
          services,
          summary: summarize(request, active, events),
          checkedInAt: checkIn?.created_at ?? null,
          fulfilledAt,
          createdAt: now,
        };
        this.store.upsertFulfilmentRecord(record);
        records.push(record);
      }
      return { performanceId, records };
    });
  }

  listFulfilmentRecords(performanceId) {
    return performanceId
      ? this.store.listFulfilmentRecords(performanceId)
      : this.store.listAllFulfilmentRecords();
  }

  // ---------- 内部方法 ----------
  _tx(fn) {
    return withTransaction(this.store.db, fn);
  }

  _planAndConfirm(request, { now, trigger, notifyVariant }) {
    try {
      const allocations = commitPlan(this.store, request, { now, trigger });
      this.store.updateRequest(request.id, { status: REQUEST_STATUS.CONFIRMED }, request.version, now);
      const performance = this.store.getPerformance(request.performance_id);
      this._notify(request, "request-confirmed", now, { variant: notifyVariant }, performance);
      this._scheduleReminder(request, performance, now);
      const confirmed = this.store.getRequest(request.id);
      return {
        requestId: request.id,
        status: REQUEST_STATUS.CONFIRMED,
        version: confirmed.version,
        allocations: this.store.listAllocations(request.id),
      };
    } catch (error) {
      if (!(error instanceof PlanningError)) throw error;
      this.store.updateRequest(request.id, { status: REQUEST_STATUS.SUBMITTED }, request.version, now);
      const failed = this.store.getRequest(request.id);
      const alternativeId = this._proposeAlternatives(failed, error.violations, now, "planning");
      return {
        requestId: request.id,
        status: REQUEST_STATUS.SUBMITTED,
        version: failed.version,
        violations: error.violations,
        alternativeId,
        alternatives: this.store.getAlternative(alternativeId)?.options ?? [],
      };
    }
  }

  _proposeAlternatives(request, violations, now, trigger) {
    const options = findAlternatives(this.store, request, violations, { now });
    const alternativeId = id("alt");
    this.store.insertAlternative({
      id: alternativeId, requestId: request.id, trigger,
      reason: violations.map((v) => v.message).join("；"),
      options, createdAt: now,
    });
    return alternativeId;
  }

  _releaseResources(request, { refund = false, onlyKind = null, onlyResourceId = null } = {}) {
    const active = this.store.listAllocations(request.id).filter((a) =>
      (!onlyKind || a.resource_kind === onlyKind) &&
      (!onlyResourceId || a.resource_id === onlyResourceId));
    for (const allocation of active) {
      if (refund && allocation.resource_kind === "companion-ticket") {
        this.store.refundCompanionQuota(request.performance_id, allocation.detail?.count ?? 0);
      }
      this.store.releaseAllocation(allocation.id);
    }
  }

  _activeRequestsUsing(kind, resourceId, performanceId) {
    return this.store.listRequestsForPerformance(performanceId).filter((request) => {
      if (request.status === REQUEST_STATUS.CANCELLED || request.status === REQUEST_STATUS.FULFILLED) return false;
      return this.store.listAllocations(request.id).some(
        (a) => a.resource_kind === kind && a.resource_id === resourceId,
      );
    });
  }

  _notify(request, template, now, payload = {}, performance = null) {
    const perf = performance ?? this.store.getPerformance(request.performance_id);
    for (const channel of request.notificationPrefs ?? ["sms"]) {
      // 同一申请+模板+渠道+版本指纹只发一次，避免重复打扰。
      const fingerprint = `${template}:${channel}:v${request.version}:${JSON.stringify(payload)}`;
      scheduleNotification(this.store, {
        requestId: request.id, template, channel,
        dedupKey: makeDedupKey(request.id, template, channel, fingerprint),
        scheduledFor: now, payload: { ...payload, performanceStartsAt: perf?.starts_at ?? null },
        createdAt: now,
      });
    }
  }

  _scheduleReminder(request, performance, now) {
    if (!performance) return;
    const startsAt = parseTime(performance.starts_at);
    if (!startsAt) return;
    const scheduledFor = new Date(startsAt.getTime() - REMINDER_LEAD_MS).toISOString();
    for (const channel of request.notificationPrefs ?? ["sms"]) {
      // 去重键不含版本：变更后不重复排提醒，截止点始终是原场次开场前 1 小时。
      scheduleNotification(this.store, {
        requestId: request.id, template: "service-reminder", channel,
        dedupKey: makeDedupKey(request.id, "service-reminder", channel, performance.id),
        scheduledFor, payload: { performanceId: performance.id, startsAt: performance.starts_at },
        createdAt: now,
      });
    }
  }

  _maybeFulfil(request, now) {
    const active = this.store.listAllocations(request.id);
    const events = this.store.listEvents(request.id);
    const handedOff = new Set(events.filter((e) => e.type === "handoff").map((e) => e.detail?.allocationId));
    const checkedIn = events.some((e) => e.type === "check-in");
    const allHandedOff = active.length > 0 && active.every((a) => handedOff.has(a.id));
    if (checkedIn && allHandedOff && request.status !== REQUEST_STATUS.FULFILLED) {
      this.store.updateRequest(request.id, { status: REQUEST_STATUS.FULFILLED }, request.version, now);
      const patron = this.store.getPatron(request.patron_id);
      this.store.upsertFulfilmentRecord({
        requestId: request.id, performanceId: request.performance_id,
        patronRef: pseudonymize(request.patron_id),
        services: active.map((a) => a.resource_kind),
        summary: summarize(this.store.getRequest(request.id), active, events),
        checkedInAt: events.find((e) => e.type === "check-in")?.created_at ?? null,
        fulfilledAt: now, createdAt: now,
      });
      return { requestId: request.id, status: REQUEST_STATUS.FULFILLED, closed: true };
    }
    return { requestId: request.id, status: request.status, closed: false, remaining: active.filter((a) => !handedOff.has(a.id)).length };
  }
}

function sanitizeEvent(event) {
  const { health_note, healthNote, ...safeDetail } = event.detail ?? {};
  return { ...event, detail: safeDetail };
}

function sanitizeDetail(detail) {
  const { health_note, healthNote, ...safeDetail } = detail ?? {};
  return safeDetail;
}

function safeParseOption(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function summarize(request, allocations, events) {
  const kinds = allocations.map((a) => a.resource_kind);
  const exceptions = events.filter((e) => e.type === "exception").length;
  return `服务 ${kinds.join("、") || "无"}；异常 ${exceptions} 次；陪同 ${request.companion_count} 人`.trim();
}
