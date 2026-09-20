// 时间与决策参数。所有时间内部统一为 epoch 毫秒（数值），接口层用 ISO8601 字符串。
export const MINUTE = 60_000;

export const HORIZON_MIN = 40; // 滚动判断窗口（覆盖一个波次的提前量）
export const STALE_MIN = 10; // 观测超过该年龄视为陈旧，需估算
export const STEP_MIN = 1; // 仿真步长

export const OPEN_TRIGGER_WAIT_MIN = 12; // 当前等待超过则该区域进入紧张
export const PEAK_TRIGGER_WAIT_MIN = 15; // 窗口内预测峰值等待超过则紧张
export const CALM_MAX_WAIT_MIN = 8; // 关通道建议的上限

export const SACRIFICE_MAX_WAIT_MIN = 12; // 被支援区抽走一条通道后允许的最大等待
export const TTL_DEFAULT_MIN = 40; // 调配指令默认时限（覆盖整个判断窗口）
export const TTL_MAX_MIN = 60;
export const ACK_DEADLINE_MIN = 4; // 员工确认（接单）时限
export const ARRIVE_SLACK_MIN = 3; // 步行之外的到岗宽限
export const ACTIVATION_SLACK_MIN = 2; // 经理接受建议到员工开始响应的最短前置

export const CONFIDENCE_HIGH = 0.8;
export const CONFIDENCE_MEDIUM = 0.6;

export function parseTs(value, field = "time") {
  if (typeof value !== "string") throw new Error(`${field} 必须是 ISO8601 字符串`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${field} 时间无法解析: ${value}`);
  return ms;
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

export function round1(n) {
  return n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
}

// 按资料声明的时区显示“HH:MM”，避免给 +08:00 的经理显示 UTC 时分。
export function hhmm(ms, timeZone = "UTC") {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}
