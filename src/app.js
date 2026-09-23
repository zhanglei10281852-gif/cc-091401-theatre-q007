// HTTP 适配层：路由、角色识别、JSON 解析与错误映射。
import { createServer } from "node:http";
import { HttpError } from "./domain/errors.js";
import { ROLES } from "./domain/constants.js";
import { nowIso } from "./domain/util.js";
import { validateCreateRequest, validateAmend as validateAmendBody, validatePerformance } from "./domain/validation.js";

export function createApp(container) {
  const { service, store, dispatcher } = container;

  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return send(response, 200, { status: "ok", service: "theatre-accessibility" });
      }
      const url = new URL(request.url, "http://localhost");
      const role = resolveRole(request);
      const body = ["POST", "PUT", "PATCH"].includes(request.method) ? await readJson(request) : {};
      const ctx = { role, body, query: url.searchParams };

      // ---- 申请 ----
      let m;
      if (request.method === "POST" && url.pathname === "/requests") {
        requireRole(role, [ROLES.CUSTOMER_SERVICE, ROLES.ADMIN]);
        const performance = store.getPerformance(body.performanceId);
        const patron = store.getPatron(body.patronId);
        const input = validateCreate(body, performance, Boolean(patron));
        return send(response, 201, normalizeOutcome(service.createRequest(input)));
      }
      if ((m = url.pathname.match(/^\/requests\/([^/]+)$/))) {
        const id = m[1];
        if (request.method === "GET") {
          return send(response, 200, service.getRequestView(id, role));
        }
        if (request.method === "PATCH") {
          requireRole(role, [ROLES.CUSTOMER_SERVICE, ROLES.ADMIN]);
          const current = service.store.getRequest(id);
          if (!current) throw new HttpError("request_not_found", "申请不存在", { status: 404 });
          const patch = validateAmend(body, current);
          return send(response, 200, normalizeOutcome(service.amendRequest(id, patch, body.version)));
        }
      }
      if ((m = url.pathname.match(/^\/requests\/([^/]+)\/cancel$/)) && request.method === "POST") {
        requireRole(role, [ROLES.CUSTOMER_SERVICE, ROLES.ADMIN]);
        return send(response, 200, service.cancelRequest(m[1], { reason: body.reason ?? "customer_cancelled" }));
      }

      // ---- 现场履约 ----
      if ((m = url.pathname.match(/^\/requests\/([^/]+)\/check-in$/)) && request.method === "POST") {
        requireRole(role, [ROLES.FULFILMENT, ROLES.ADMIN]);
        return send(response, 201, service.recordFulfilmentEvent(m[1], "check-in", { role, id: body.actorId }, body.detail ?? {}));
      }
      if ((m = url.pathname.match(/^\/requests\/([^/]+)\/handoff$/)) && request.method === "POST") {
        requireRole(role, [ROLES.FULFILMENT, ROLES.ADMIN]);
        return send(response, 200, service.handoff(m[1], body.allocationId, { role, id: body.actorId }, body.detail ?? {}));
      }
      if ((m = url.pathname.match(/^\/requests\/([^/]+)\/exceptions$/)) && request.method === "POST") {
        requireRole(role, [ROLES.FULFILMENT, ROLES.ADMIN]);
        return send(response, 200, service.reportException(m[1], { role, id: body.actorId }, body.detail ?? {}));
      }

      // ---- 替代方案 ----
      if ((m = url.pathname.match(/^\/alternatives\/([^/]+)\/accept$/)) && request.method === "POST") {
        requireRole(role, [ROLES.CUSTOMER_SERVICE, ROLES.ADMIN]);
        return send(response, 200, service.acceptAlternative(m[1], body.optionIndex, body.version));
      }
      if ((m = url.pathname.match(/^\/alternatives\/([^/]+)\/reject$/)) && request.method === "POST") {
        requireRole(role, [ROLES.CUSTOMER_SERVICE, ROLES.ADMIN]);
        return send(response, 200, service.rejectAlternative(m[1]));
      }

      // ---- 场次转场 / 关闭 ----
      if ((m = url.pathname.match(/^\/performances\/([^/]+)\/transfer$/)) && request.method === "POST") {
        requireRole(role, [ROLES.ADMIN]);
        return send(response, 200, service.transferPerformance(m[1], body.targetPerformanceId, body.reason ?? "rescheduled"));
      }
      if ((m = url.pathname.match(/^\/performances\/([^/]+)\/close$/)) && request.method === "POST") {
        requireRole(role, [ROLES.ADMIN, ROLES.FULFILMENT]);
        return send(response, 200, service.closePerformance(m[1]));
      }
      if ((m = url.pathname.match(/^\/performances\/([^/]+)\/fulfilment-records$/)) && request.method === "GET") {
        return send(response, 200, { records: service.listFulfilmentRecords(m[1]) });
      }
      if (request.method === "GET" && url.pathname === "/fulfilment-records") {
        return send(response, 200, { records: service.listFulfilmentRecords(ctx.query.get("performanceId")) });
      }

      // ---- 临时资源故障 ----
      if (request.method === "POST" && url.pathname === "/resource-failures") {
        requireRole(role, [ROLES.FULFILMENT, ROLES.ADMIN]);
        return send(response, 200, service.reportResourceFailure(body.kind, body.resourceId, body.performanceId, body.detail ?? {}));
      }

      // ---- 基础数据（管理接口/样例录入）----
      if (request.method === "POST" && url.pathname === "/admin/performances") {
        requireRole(role, [ROLES.ADMIN]);
        const p = validatePerformance(body);
        store.upsertPerformance({ ...p, createdAt: nowIso() });
        if (body.companionQuota != null) store.upsertCompanionQuota(p.id, body.companionQuota);
        return send(response, 201, { id: p.id });
      }
      if (request.method === "POST" && url.pathname === "/admin/seats") {
        requireRole(role, [ROLES.ADMIN]);
        const seats = body.seats ?? [body];
        for (const s of seats) store.upsertSeat(seatInput(s));
        return send(response, 201, { imported: seats.length });
      }
      if (request.method === "POST" && url.pathname === "/admin/volunteers") {
        requireRole(role, [ROLES.ADMIN]);
        const list = body.volunteers ?? [body];
        for (const v of list) {
          store.upsertVolunteer({ id: v.id, name: v.name, skills: v.skills ?? ["sign-language"] });
          for (const performanceId of v.shiftPerformanceIds ?? []) store.upsertShift(v.id, performanceId);
        }
        return send(response, 201, { imported: list.length });
      }
      if (request.method === "POST" && url.pathname === "/admin/devices") {
        requireRole(role, [ROLES.ADMIN]);
        const list = body.devices ?? [body];
        for (const d of list) {
          store.upsertDevice({
            id: d.id, type: d.type ?? "hearing-loop", model: d.model,
            compatibleNeeds: d.compatibleNeeds ?? ["t-coil", "bluetooth", "none"],
          });
        }
        return send(response, 201, { imported: list.length });
      }
      if (request.method === "POST" && url.pathname === "/admin/patrons") {
        requireRole(role, [ROLES.ADMIN]);
        const list = body.patrons ?? [body];
        for (const p of list) {
          store.upsertPatron({
            id: p.id, name: p.name, contact: p.contact,
            consentVersion: p.consentVersion, consentScope: p.consentScope,
            consentAt: nowIso(),
          });
        }
        return send(response, 201, { imported: list.length });
      }

      // 手动驱动通知（测试/运维用）
      if (request.method === "POST" && url.pathname === "/admin/notifications/flush") {
        requireRole(role, [ROLES.ADMIN]);
        return send(response, 200, { results: await dispatcher.flushDue() });
      }

      return send(response, 404, { error: "not_found" });
    } catch (error) {
      return sendError(response, error);
    }
  });
}

function resolveRole(request) {
  const role = request.headers["x-role"];
  return [ROLES.CUSTOMER_SERVICE, ROLES.FULFILMENT, ROLES.ADMIN].includes(role)
    ? role
    : ROLES.CUSTOMER_SERVICE; // 默认最小权限视角
}

function requireRole(role, allowed) {
  if (!allowed.includes(role)) {
    throw new HttpError("forbidden", `角色 ${role} 无权执行该操作`, { status: 403 });
  }
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HttpError("invalid_json", "请求体不是合法 JSON", { status: 400 });
  }
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  if (error instanceof HttpError) {
    return send(response, error.status, { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
  }
  if (error?.race) {
    return send(response, 409, { error: "resource_busy", message: "资源竞争，请重试" });
  }
  console.error(error);
  return send(response, 500, { error: "internal_error", message: "服务内部错误" });
}

// 校验逻辑放在路由侧组装，避免服务层依赖 HTTP。
function validateCreate(body, performance, patronExists) {
  return validateCreateRequest(body, { performance, patronExists });
}
function validateAmend(body, current) {
  return validateAmendBody(body, current);
}

// HTTP 出参统一 camelCase；服务/台账内部保留 snake_case。
function normalizeOutcome(outcome) {
  if (!outcome || !Array.isArray(outcome.allocations)) return outcome;
  return {
    ...outcome,
    allocations: outcome.allocations.map((a) => ({
      id: a.id,
      resourceKind: a.resource_kind ?? a.resourceKind,
      resourceId: a.resource_id ?? a.resourceId,
      detail: a.detail ?? {},
      status: a.status,
    })),
  };
}

function seatInput(s) {
  return {
    id: s.id,
    performanceId: s.performanceId,
    zone: s.zone ?? "A-access",
    label: s.label,
    kind: s.kind,
    accessibleRoute: s.accessibleRoute ?? (s.kind === "wheelchair" ? 1 : 0),
    aisleWidthCm: s.aisleWidthCm ?? 0,
    adjacentTo: s.adjacentTo ?? null,
  };
}
