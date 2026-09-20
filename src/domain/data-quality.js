// 数据可信度：只依据时刻 t 的视图可见记录评估，迟到的更正在此天然不可见。
import { toMs, MINUTE_MS } from "./time.js";

export function assessDataQuality(world, rules) {
  const result = new Map();
  for (const [zone] of world.zones) {
    const visible = [...world.observations.values()]
      .filter((o) => o.zone === zone && toMs(o.occurredAt) <= world.at)
      .sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt));

    if (visible.length === 0) {
      result.set(zone, {
        zone,
        status: "no_data",
        trustLevel: "low",
        flags: ["no_data"],
        latest: null,
        visibleSamples: 0,
      });
      continue;
    }

    const latest = visible[visible.length - 1];
    const ageMin = Math.round((world.at - toMs(latest.occurredAt)) / MINUTE_MS);
    const flags = [];
    if (typeof latest.queue !== "number" || latest.queue < 0 || !Number.isFinite(latest.queue)) {
      flags.push("implausible_value");
    }
    if (ageMin > rules.gapMin) flags.push("gap");
    else if (ageMin > rules.staleMin) flags.push("stale");
    if (latest.confidence !== undefined && latest.confidence < rules.lowConfidence) {
      flags.push("low_confidence");
    }
    if (latest.correctedBy) {
      if ((latest.correctionLagMin ?? 0) > rules.lateMin) flags.push("late_correction");
      else flags.push("corrected");
    }
    // 相邻观测突降/突增超过当前处理能力 10 分钟量，且未被更正解释，标记疑似异常。
    if (visible.length >= 2) {
      const prev = visible[visible.length - 2];
      const dtMin = (toMs(latest.occurredAt) - toMs(prev.occurredAt)) / MINUTE_MS;
      const jump = latest.queue - prev.queue;
      const capacity = zoneCapacity(world, zone, world.at);
      if (dtMin > 0 && Math.abs(jump) > capacity * Math.max(dtMin, 1) * 1.5 && !latest.correctedBy) {
        flags.push("implausible_jump");
      }
    }

    let trustLevel = "high";
    if (flags.includes("gap") || flags.includes("no_data") || flags.includes("implausible_value")) trustLevel = "low";
    else if (flags.length > 0) trustLevel = "medium";

    result.set(zone, {
      zone,
      status: "ok",
      trustLevel,
      flags,
      visibleSamples: visible.length,
      latest: {
        observationId: latest.observationId,
        queue: latest.queue,
        confidence: latest.confidence ?? null,
        occurredAt: toMs(latest.occurredAt),
        receivedAt: toMs(latest.receivedAt),
        ageMin,
        correctedBy: latest.correctedBy ?? null,
        correctionLagMin: latest.correctionLagMin ?? null,
      },
    });
  }
  return result;
}

function zoneCapacity(world, zone, at) {
  const z = world.zones.get(zone);
  if (!z) return 0;
  return z.lanes.filter((l) => l.effectiveOpen).reduce((sum, l) => sum + l.rate, 0);
}
