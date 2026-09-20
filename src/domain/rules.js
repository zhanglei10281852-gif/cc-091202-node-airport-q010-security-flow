// 规则版本：每次调参都发布新版本并指定生效时刻。
// 重放历史时刻时必须使用当时生效的规则，不能用今天的阈值解释昨天的决策。
import { toMs } from "./time.js";

const BASE = {
  // 数据可信度
  staleMin: 6, // 最新观测超过该年龄即标记 stale
  gapMin: 12, // 超过该年龄视为数据缺口
  lateMin: 8, // 接收时间晚于发生时间的阈值，仅标记不隐藏
  lowConfidence: 0.6, // 置信度低于该值标记 low_confidence
  // 决策
  horizonMin: 40, // 滚动评估时长
  triggerWaitMin: 10, // 预测等待超过该值才考虑增配
  minGain: 6, // 预期净改善（等待-分钟）低于该值则维持现状
  localMusterMin: 2, // 本区备岗到位预计分钟
  walkGraceMin: 5, // 跨区支援确认宽限
  maxCommandMin: 60, // 指令最长时限
  donorMaxWaitMin: 12, // 支援后出借方预测等待上限（硬门槛）
  cooldownMin: 15, // 同一通道两次状态切换的冷却，避免频繁开关
  // 收通道
  closeUtil: 0.55, // 未来时段利用率低于该值才考虑收
  closeGuardMin: 60, // 收通道前必须看清的未来波次窗口
  // 航班波次 → 到港曲线（均匀分布近似）
  waveLeadMin: 90,
  waveTailMin: 20,
};

export const RULES_VERSIONS = [
  {
    version: "rules-2026-09",
    effectiveAt: toMs("2026-01-01T00:00:00+08:00"),
    params: BASE,
  },
  {
    // 节后复盘版本：触发阈值更敏感、对出借方保护更强、可信度要求更高
    version: "rules-2026-10",
    effectiveAt: toMs("2026-09-12T08:30:00+08:00"),
    params: {
      ...BASE,
      triggerWaitMin: 8,
      donorMaxWaitMin: 10,
      staleMin: 5,
      lowConfidence: 0.65,
      minGain: 5,
    },
  },
];

export function rulesAt(at) {
  let chosen = RULES_VERSIONS[0];
  for (const rules of RULES_VERSIONS) {
    if (at >= rules.effectiveAt) chosen = rules;
  }
  return { version: chosen.version, ...chosen.params };
}
