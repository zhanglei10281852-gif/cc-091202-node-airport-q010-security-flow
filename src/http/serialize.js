// 出口统一序列化：毫秒时间戳转 ISO，Infinity/NaN 转 null，再做一遍隐私脱敏。
import { scrub } from "../domain/privacy.js";

const TIME_KEY = /(^At$|At$|Until$|Deadline$|Start$|End$|^departsAt$)/;

function convert(value, key = "") {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (TIME_KEY.test(key) && value > 1_000_000_000_000) return new Date(value).toISOString();
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => convert(item, key));
  if (typeof value === "object") {
    if (value instanceof Set) return [...value].map((item) => convert(item));
    const out = {};
    for (const [k, item] of Object.entries(value)) out[k] = convert(item, k);
    return out;
  }
  return value;
}

export function toApi(value) {
  const redacted = [];
  const safe = scrub(convert(value), redacted);
  return safe;
}
