// 时间工具：领域内一律使用毫秒时间戳；与外界交换时用 ISO8601 字符串。
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

export function toMs(value) {
  if (value === undefined || value === null || value === "") return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  return Date.parse(value);
}

export function requireTime(value, field) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`字段 ${field} 不是合法时间: ${String(value)}`);
  }
  return ms;
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

// 只用于命令行展示，固定东八区，避免依赖宿主时区。
export function isoCn(ms) {
  const shifted = new Date(ms + 8 * HOUR_MS);
  const text = shifted.toISOString().slice(0, 19);
  return `${text}+08:00`;
}

export function minuteCn(ms) {
  return isoCn(ms).slice(11, 16);
}

export function floorToMinute(ms) {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

export function diffMin(a, b) {
  return Math.round((a - b) / MINUTE_MS);
}
