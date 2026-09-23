// 领域常量：服务类型、资源类型、状态机取值。

export const SERVICES = Object.freeze({
  WHEELCHAIR_SEAT: "wheelchair-seat",
  SIGN_LANGUAGE: "sign-language",
  HEARING_DEVICE: "hearing-device",
});

export const SERVICE_TYPES = Object.freeze(Object.values(SERVICES));

// 每种服务履约时需要锁定的资源类型。
export const SERVICE_RESOURCE_KIND = Object.freeze({
  "wheelchair-seat": "seat",
  "sign-language": "volunteer",
  "hearing-device": "device",
});

export const RESOURCE_KINDS = Object.freeze(["seat", "companion-ticket", "volunteer", "device"]);

// 申请状态机
// draft -> submitted -> confirmed（已锁定资源）-> fulfilled（现场已闭环）
// 任意阶段 -> cancelled；confirmed 之后可因故障/转场 -> replanning
export const REQUEST_STATUS = Object.freeze({
  DRAFT: "draft",
  SUBMITTED: "submitted",
  CONFIRMED: "confirmed",
  FULFILLED: "fulfilled",
  CANCELLED: "cancelled",
  REPLANNING: "replanning",
});

// 设备借用状态
export const DEVICE_STATUS = Object.freeze({
  AVAILABLE: "available",
  RESERVED: "reserved",
  ISSUED: "issued",
  RETURNED: "returned",
  FAULTY: "faulty",
});

// 席位占用状态
export const SEAT_STATUS = Object.freeze({
  FREE: "free",
  HELD: "held",
  OCCUPIED: "occupied",
});

// 履约现场事件
export const FULFILMENT_EVENTS = Object.freeze({
  CHECK_IN: "check-in",
  HANDOFF: "handoff",
  EXCEPTION: "exception",
});

export const ROLES = Object.freeze({
  CUSTOMER_SERVICE: "customer-service", // 客服：只看脱敏信息
  FULFILMENT: "fulfilment", // 现场履约：可看健康备注
  ADMIN: "admin",
});
