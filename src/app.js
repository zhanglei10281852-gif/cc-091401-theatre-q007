import { createServer } from "node:http";
import { DomainError, evaluateRequest, getPerformance } from "./domain/match.js";
import { viewForRole } from "./domain/privacy.js";
import { acceptRearrangement, cancelShift, rebookRequest, repairDevice, reportDeviceFault, reportSeatFault } from "./services/operations.js";
import { cancelRequest, recordFulfillment, upsertRequest } from "./services/requests.js";
import { deliverDue } from "./services/notify.js";

const KNOWN_ROLES = ["box_office", "front_of_house", "device_steward", "interpreter", "auditor"];

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (request.headers["content-type"] && !request.headers["content-type"].includes("application/json")) {
    throw new DomainError("http:bad-content-type", "请求必须为 application/json");
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError("http:bad-json", "请求体不是合法 JSON");
  }
}

function roleOf(request) {
  const header = request.headers["x-role"];
  const role = Array.isArray(header) ? header[0] : header;
  if (!role) return "box_office";
  if (!KNOWN_ROLES.includes(role)) {
    throw new DomainError("auth:bad-role", "角色不被识别", { allowed: KNOWN_ROLES });
  }
  return role;
}

import { MemoryStore } from "./store/json-store.js";

export function createApp(store = new MemoryStore()) {
  if (!store) throw new Error("createApp 需要一个 store");

  async function handler(request, response) {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    const role = roleOf(request);

    try {
      // ---------- 基础与参考数据 ----------
      if (request.method === "GET" && path === "/health") {
        return send(response, 200, { status: "ok", service: "theatre-accessibility" });
      }

      if (request.method === "GET" && path === "/reference/consent-template") {
        const state = store.snapshot();
        return send(response, 200, { templates: state.consentTemplates });
      }

      if (request.method === "GET" && path === "/performances") {
        const state = store.snapshot();
        return send(response, 200, {
          performances: state.performances.map((p) => ({
            id: p.id,
            title: p.title,
            venueId: p.venueId,
            startAt: p.startAt,
            endAt: p.endAt,
            soldOut: p.soldOut,
            interpreterScheduled: p.interpreter?.scheduled === true,
          })),
        });
      }

      // ---------- 可行性预检：不锁定资源，只返回硬约束与替代方案 ----------
      const checkMatch = path.match(/^\/performances\/([^/]+)\/accessibility$/);
      if (request.method === "GET" && checkMatch) {
        const state = store.snapshot();
        const params = {
          performanceId: checkMatch[1],
          mobility: url.searchParams.get("mobility") ?? "none",
          companionCount: Number(url.searchParams.get("companionCount") ?? "0"),
          signLanguageNeeded: url.searchParams.get("signLanguageNeeded") === "true",
          hearingAssistanceNeeded: url.searchParams.get("hearingAssistanceNeeded") === "true",
        };
        const widthRaw = url.searchParams.get("chairWidthMm");
        if (widthRaw !== null && Number.isFinite(Number(widthRaw))) {
          params.chairWidthMm = Number(widthRaw);
        }
        const compat = url.searchParams.get("hearingCompatibility");
        if (compat !== null) params.hearingCompatibility = compat;
        const result = evaluateRequest(state, checkMatch[1], params);
        return send(response, 200, {
          feasible: result.violations.length === 0,
          violations: result.violations,
          alternatives: result.alternatives,
          diagnostics: result.diagnostics,
        });
      }

      // ---------- 申请 ----------
      if (request.method === "POST" && path === "/requests") {
        const body = await readJson(request);
        const created = await store.mutate((state) => upsertRequest(state, body));
        return send(response, 201, { request: viewForRole(created, role, { salt: store.snapshot().pseudonymSalt }) });
      }

      const requestMatch = path.match(/^\/requests\/([^/]+)$/);
      if (request.method === "GET" && requestMatch) {
        const state = store.snapshot();
        const request = state.requests?.[requestMatch[1]];
        if (!request) throw new DomainError("request:not-found", "申请不存在", { requestId: requestMatch[1] });
        return send(response, 200, { request: viewForRole(request, role, { salt: state.pseudonymSalt }) });
      }

      const amendMatch = path.match(/^\/requests\/([^/]+)\/amend$/);
      if (request.method === "POST" && amendMatch) {
        const body = await readJson(request);
        const amended = await store.mutate((state) => upsertRequest(state, body, { requestId: amendMatch[1] }));
        return send(response, 200, { request: viewForRole(amended, role, { salt: store.snapshot().pseudonymSalt }) });
      }

      const cancelMatch = path.match(/^\/requests\/([^/]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const body = await readJson(request).catch(() => ({}));
        const cancelled = await store.mutate((state) =>
          cancelRequest(state, cancelMatch[1], body.reason ?? "观众取消"),
        );
        return send(response, 200, { request: viewForRole(cancelled, role, { salt: store.snapshot().pseudonymSalt }) });
      }

      const rebookMatch = path.match(/^\/requests\/([^/]+)\/rebook$/);
      if (request.method === "POST" && rebookMatch) {
        const body = await readJson(request);
        const target = body.targetPerformanceId;
        const result = await store.mutate((state) =>
          rebookRequest(state, rebookMatch[1], target, body.needs ?? {}),
        );
        return send(response, 200, {
          request: viewForRole(result.request, role, { salt: store.snapshot().pseudonymSalt }),
          previous: { performanceId: result.previous.performanceId },
        });
      }

      const rearrangeMatch = path.match(/^\/requests\/([^/]+)\/accept-rearrangement$/);
      if (request.method === "POST" && rearrangeMatch) {
        const updated = await store.mutate((state) => acceptRearrangement(state, rearrangeMatch[1]));
        return send(response, 200, { request: viewForRole(updated, role, { salt: store.snapshot().pseudonymSalt }) });
      }

      // ---------- 现场闭环：签到 / 交接 / 异常 / 关闭 ----------
      const fulfillmentMatch = path.match(/^\/requests\/([^/]+)\/fulfillment$/);
      if (request.method === "POST" && fulfillmentMatch) {
        const body = await readJson(request);
        if (!["front_of_house", "device_steward"].includes(role)) {
          throw new DomainError("auth:forbidden", "只有现场履约角色可以记录签到/交接/异常", { role });
        }
        const result = await store.mutate((state) =>
          recordFulfillment(state, fulfillmentMatch[1], body.action, body),
        );
        return send(response, 200, {
          request: viewForRole(result.request, role, { salt: store.snapshot().pseudonymSalt }),
          incident: result.incident
            ? { id: result.incident.id, kind: result.incident.kind, alternatives: result.alternatives }
            : undefined,
        });
      }

      // ---------- 资源故障 / 修复 ----------
      const deviceFaultMatch = path.match(/^\/admin\/devices\/([^/]+)\/fault$/);
      if (request.method === "POST" && deviceFaultMatch) {
        const body = await readJson(request).catch(() => ({}));
        const result = await store.mutate((state) =>
          reportDeviceFault(state, deviceFaultMatch[1], body.reason ?? ""),
        );
        return send(response, 200, result);
      }
      const deviceRepairMatch = path.match(/^\/admin\/devices\/([^/]+)\/repair$/);
      if (request.method === "POST" && deviceRepairMatch) {
        const device = await store.mutate((state) => repairDevice(state, deviceRepairMatch[1]));
        return send(response, 200, { device: { id: device.id, status: device.status } });
      }
      const seatFaultMatch = path.match(/^\/admin\/seats\/([^/]+)\/fault$/);
      if (request.method === "POST" && seatFaultMatch) {
        const body = await readJson(request).catch(() => ({}));
        const result = await store.mutate((state) => reportSeatFault(state, seatFaultMatch[1], body.reason ?? ""));
        return send(response, 200, result);
      }
      const shiftCancelMatch = path.match(/^\/admin\/shifts\/([^/]+)\/cancel$/);
      if (request.method === "POST" && shiftCancelMatch) {
        const body = await readJson(request).catch(() => ({}));
        const result = await store.mutate((state) => cancelShift(state, shiftCancelMatch[1], body.reason ?? ""));
        return send(response, 200, result);
      }

      // ---------- 通知 ----------
      if (request.method === "POST" && path === "/notifications/deliver") {
        const delivered = await store.mutate(async (state) => {
          const rows = await deliverDue(state, consoleSink);
          return rows.map((n) => ({ id: n.id, requestId: n.requestId, type: n.type, audience: n.audience, summary: n.summary }));
        });
        return send(response, 200, { delivered });
      }
      if (request.method === "GET" && path === "/notifications") {
        const state = store.snapshot();
        const audience = url.searchParams.get("audience");
        let rows = state.notifications ?? [];
        if (audience) rows = rows.filter((n) => n.audience === audience);
        // 通知列表同样按角色裁剪：客服看不到观众隐私，这里仅返回通知本身
        return send(response, 200, {
          notifications: rows.map((n) => ({
            id: n.id,
            requestId: n.requestId,
            type: n.type,
            audience: n.audience,
            summary: n.summary,
            dueAt: n.dueAt,
            status: n.status,
            sentAt: n.sentAt,
          })),
        });
      }

      // ---------- 脱敏履约记录查询（演出结束后） ----------
      if (request.method === "GET" && path === "/fulfillment/records") {
        if (role !== "auditor" && role !== "front_of_house") {
          throw new DomainError("auth:forbidden", "履约记录仅对复盘与现场协调角色开放", { role });
        }
        const state = store.snapshot();
        const performanceId = url.searchParams.get("performanceId");
        let requests = Object.values(state.requests ?? {});
        if (performanceId) requests = requests.filter((r) => r.performanceId === performanceId);
        const onlyEnded = url.searchParams.get("ended") !== "false";
        if (onlyEnded) {
          requests = requests.filter((r) => {
            const perf = getPerformance(state, r.performanceId);
            return perf && Date.parse(perf.endAt) <= Date.now();
          });
        }
        return send(response, 200, {
          records: requests.map((r) => viewForRole(r, "auditor", { salt: state.pseudonymSalt })),
        });
      }

      return send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DomainError) {
        const status = statusFor(error.code);
        return send(response, status, { error: error.code, message: error.message, details: error.details });
      }
      console.error(error);
      return send(response, 500, { error: "internal_error", message: error.message });
    }
  }

  return createServer(handler);
}

function statusFor(code) {
  if (code.startsWith("validation") || code.startsWith("http") || code === "consent:missing") return 400;
  if (code === "auth:bad-role") return 401;
  if (code === "auth:forbidden") return 403;
  if (code.endsWith(":not-found")) return 404;
  if (code === "http:too-soon") return 429;
  if (code === "constraint:violations" || code === "constraint:stale" || code === "request:terminal") return 409;
  return 422;
}

// 默认通知通道：演示环境写入日志。生产可替换为短信/邮件/IM 适配器。
function consoleSink(notification, request) {
  console.log(
    `[notify:${notification.audience}] request=${notification.requestId} type=${notification.type} :: ${notification.summary}`,
  );
}
