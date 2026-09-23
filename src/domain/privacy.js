import { createHash } from "node:crypto";

// 角色 -> 可见字段/授权范围。敏感健康信息（health.note）仅履约角色可见。
export const ROLES = {
  // 客服：只看履约所需的服务安排，看不到健康自由文本与联系方式细节
  box_office: {
    label: "客服",
    canSeeHealth: false,
    canSeeContact: false,
    canSeeNeedCodes: ["need.mobility", "need.sign", "need.hearing"],
  },
  // 现场协调志愿者/值班经理：需要知道具体需求与健康补充说明以完成交接
  front_of_house: {
    label: "现场协调",
    canSeeHealth: true,
    canSeeContact: true,
    canSeeNeedCodes: ["need.mobility", "need.sign", "need.hearing", "health.note"],
  },
  // 设备管理员：只看设备借用与助听兼容特征
  device_steward: {
    label: "设备管理员",
    canSeeHealth: false,
    canSeeContact: false,
    canSeeNeedCodes: ["need.hearing"],
  },
  // 手语译员：只知道自己的服务对象与到场状态，不知道其他需求
  interpreter: {
    label: "手语译员",
    canSeeHealth: false,
    canSeeContact: false,
    canSeeNeedCodes: ["need.sign"],
  },
  // 复盘/审计：只看脱敏后的履约记录
  auditor: {
    label: "履约复盘",
    canSeeHealth: false,
    canSeeContact: false,
    canSeeNeedCodes: [],
  },
};

const NEED_CODE_BY_FIELD = {
  mobility: "need.mobility",
  companionCount: "need.mobility",
  chairWidthMm: "need.mobility",
  signLanguageNeeded: "need.sign",
  hearingAssistanceNeeded: "need.hearing",
  hearingCompatibility: "need.hearing",
  needsVolunteer: "need.mobility",
};

export function pseudonymize(patron, salt) {
  const digest = createHash("sha256").update(`${salt}:${patron.id}`).digest("hex").slice(0, 10);
  return `观众-${digest}`;
}

function maskContact(contact) {
  if (!contact) return null;
  return {
    phone: contact.phone ? contact.phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2") : undefined,
    email: contact.email
      ? contact.email.replace(/^(.).*(@.*)$/, "$1***$2")
      : undefined,
  };
}

// 按授权范围与角色过滤申请内容。access 为申请记录中观众同意的 scope 列表。
export function viewForRole(request, role, { salt = "" } = {}) {
  const policy = ROLES[role];
  if (!policy) throw new Error(`unknown role: ${role}`);

  const granted = new Set(request.consent?.scopes ?? []);
  const base = {
    id: request.id,
    performanceId: request.performanceId,
    status: request.status,
    ticketRef: request.ticketRef,
    followupDueAt: request.followupDueAt ?? null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };

  if (role === "auditor") {
    return {
      ...base,
      patron: pseudonymize({ id: request.patronId }, salt),
      plan: redactPlan(request.plan),
      fulfillment: redactFulfillment(request.fulfillment),
      outcome: request.outcome ?? null,
    };
  }

  const view = { ...base };
  view.patronId = request.patronId;
  const fullName = request.patron?.name ?? null;
  view.patronName = policy.canSeeContact ? fullName : fullName ? `${fullName[0]}**` : null;
  view.contact = policy.canSeeContact ? request.patron?.contact ?? null : maskContact(request.patron?.contact);

  const needs = {};
  for (const [field, code] of Object.entries(NEED_CODE_BY_FIELD)) {
    if (request.input[field] !== undefined && policy.canSeeNeedCodes.includes(code) && granted.has(code)) {
      needs[field] = request.input[field];
    }
  }
  view.needs = needs;

  // health.note 必须同时满足：角色允许 + 观众授权
  if (policy.canSeeHealth && granted.has("health.note")) {
    view.healthNote = request.input.healthNote ?? null;
  }

  view.consentScopes = [...granted];
  view.plan = roleScopedPlan(request.plan, role);
  view.fulfillment = request.fulfillment ?? null;
  view.alternatives = request.alternatives ?? [];
  return view;
}

function roleScopedPlan(plan, role) {
  if (!plan) return null;
  if (role === "device_steward") {
    return {
      performanceId: plan.performanceId,
      deviceIds: plan.deviceIds,
      zoneId: plan.zoneId,
    };
  }
  if (role === "interpreter") {
    return {
      performanceId: plan.performanceId,
      interpreter: plan.interpreter,
      interpreterStaffId: plan.interpreterStaffId,
      zoneId: plan.zoneId,
    };
  }
  return plan;
}

function redactPlan(plan) {
  if (!plan) return null;
  // 审计视图：保留资源使用事实，去除人员姓名
  return {
    zoneId: plan.zoneId,
    seatId: plan.seatId,
    companionCount: plan.companionSeatIds?.length ?? 0,
    interpreter: plan.interpreter,
    deviceModels: plan.deviceIds?.length ? ["(borrowed)"] : [],
    shiftId: plan.shiftId,
  };
}

function redactFulfillment(fulfillment) {
  if (!fulfillment) return null;
  return {
    checkedIn: fulfillment.checkedIn ?? false,
    handoverState: fulfillment.handoverState ?? null,
    closed: fulfillment.closed ?? false,
    incidentCount: fulfillment.incidents?.length ?? 0,
    timeline: (fulfillment.timeline ?? []).map((t) => ({ at: t.at, event: t.event })),
  };
}
