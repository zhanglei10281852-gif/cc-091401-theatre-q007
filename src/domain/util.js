// 时间一律使用带偏移量的 ISO 8601 字符串持久化。
export function nowIso(now = new Date()) {
  return now.toISOString();
}

export function parseTime(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

export function isValidIso(value) {
  return typeof value === "string" && parseTime(value) !== null;
}

export function id(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export function parseJsonArray(value, fallback = []) {
  try {
    const parsed = JSON.parse(value ?? "null");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
