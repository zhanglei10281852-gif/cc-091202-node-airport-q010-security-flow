// 隐私防护：系统只处理聚合客流与化名标识，任何旅客粒度数据在入口即拒绝；
// 出口再做一遍脱敏，作为纵深防御。
const DENY_KEYS = [
  /(^|_)(name|fullname|realname)$/i,
  /passport|idcard|identity|documentno|document_?id|certno/i,
  /(^|_)(phone|mobile|tel|email|mail)$/i,
  /ticketno|ticket_?id|pnr|booking_?ref|booking_?id/i,
  /birth(day|date)?|gender|homeaddress|address/i,
  /姓名|证件|护照|手机|电话|邮箱|地址|生日/,
];

const TRAVELER_TYPE = /^(passenger|traveler|customer|pax|旅客)$/i;

export function findPrivacyViolation(record, path = "") {
  if (record === null || typeof record !== "object") return null;

  if (Array.isArray(record)) {
    for (let i = 0; i < record.length; i += 1) {
      const hit = findPrivacyViolation(record[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }

  for (const [key, value] of Object.entries(record)) {
    const here = path ? `${path}.${key}` : key;
    if (TRAVELER_TYPE.test(key)) {
      return { path: here, reason: "traveler_level_data_prohibited" };
    }
    if (DENY_KEYS.some((pattern) => pattern.test(key))) {
      return { path: here, reason: "pii_key_prohibited" };
    }
    if (value && typeof value === "object") {
      const hit = findPrivacyViolation(value, here);
      if (hit) return hit;
    }
  }
  return null;
}

// 出口脱敏：理论上不应命中，命中说明上游混入了不该出现的字段。
export function scrub(value, redacted = []) {
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, redacted));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (TRAVELER_TYPE.test(key) || DENY_KEYS.some((p) => p.test(key))) {
        out[key] = "[REDACTED]";
        redacted.push(key);
      } else {
        out[key] = scrub(item, redacted);
      }
    }
    return out;
  }
  return value;
}

const PSEUDONYM = /^(staff|mgr|obs|cmd|rec|ovr|flt|lane)?[-a-z0-9]*$/i;

export function assertPseudonym(value, field) {
  if (typeof value !== "string" || !PSEUDONYM.test(value) || value.length > 48) {
    throw new TypeError(`字段 ${field} 只接受化名标识`);
  }
}
