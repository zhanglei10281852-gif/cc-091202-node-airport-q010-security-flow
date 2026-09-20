// 匿名队列观测的追加式存储。
// 关键约束：观测同时有 occurredAt（现场发生）与 receivedAt（系统接收）。
// 任何历史时刻 t 的判断只能看到 receivedAt <= t 的记录；迟到更正不得提前可见。
import { parseTs } from "./clock.js";

export function normalizeObservation(record, { fallbackReceivedAt } = {}) {
  if (!record.zone || typeof record.queue !== "number") {
    throw new Error("观测缺少 zone 或 queue");
  }
  const occurredAt = parseTs(record.occurredAt ?? record.at, "occurredAt");
  let receivedAt;
  if (record.receivedAt !== undefined) {
    receivedAt = parseTs(record.receivedAt, "receivedAt");
  } else if (fallbackReceivedAt !== undefined) {
    receivedAt = fallbackReceivedAt;
  } else {
    throw new Error("观测缺少 receivedAt");
  }
  return {
    observationId: record.observationId ?? `obs-${record.zone}-${occurredAt}`,
    corrects: record.corrects ?? null,
    zone: record.zone,
    queue: Math.max(0, Math.round(record.queue)),
    occurredAt,
    receivedAt,
    confidence: record.confidence === undefined ? 0.9 : Number(record.confidence),
  };
}

export class ObservationLog {
  // 可接收原始 API 记录（ISO 字符串）或已标准化的记录（epoch 数值，如来自 DecisionStore）。
  constructor(records = []) {
    this.records = records.map((r) =>
      typeof r.occurredAt === "number" && typeof r.receivedAt === "number"
        ? { ...r, corrects: r.corrects ?? null }
        : normalizeObservation(r)
    );
  }

  append(record, { receivedAt } = {}) {
    const obs = normalizeObservation(record, { fallbackReceivedAt: receivedAt });
    // 同 observationId 重发视为幂等重放（传感器重试），不重复入库。
    if (this.records.some((r) => r.observationId === obs.observationId)) return obs;
    this.records.push(obs);
    return obs;
  }

  // 返回时刻 asOf 可见的观测（含当时已到达的更正），并应用更正链。
  visible(asOf) {
    const byId = new Map();
    for (const r of this.records) {
      if (r.receivedAt <= asOf) byId.set(r.observationId, r);
    }
    const correctedIds = new Set();
    for (const r of byId.values()) {
      if (r.corrects) {
        // 顺着更正链标记被取代的记录。
        let targetId = r.corrects;
        const guard = new Set();
        while (targetId && byId.has(targetId) && !guard.has(targetId)) {
          guard.add(targetId);
          const target = byId.get(targetId);
          correctedIds.add(targetId);
          targetId = target.corrects;
        }
      }
    }
    return this.records
      .filter((r) => r.receivedAt <= asOf && !correctedIds.has(r.observationId))
      .map((r) => ({
        ...r,
        supersededBy: correctedIds.has(r.observationId),
        hasVisibleCorrection: correctedIds.has(r.observationId),
      }));
  }

  // 审计视角：包含迟到更正与其到达时间（不做时间过滤，仅供事后审计接口）。
  audit() {
    return this.records.map((r) => ({ ...r, reportLagMs: r.receivedAt - r.occurredAt }));
  }

  latestPerZone(asOf) {
    const visible = this.visible(asOf);
    const latest = new Map();
    for (const r of visible) {
      const cur = latest.get(r.zone);
      if (!cur || r.occurredAt > cur.occurredAt ||
        (r.occurredAt === cur.occurredAt && r.receivedAt > cur.receivedAt)) {
        latest.set(r.zone, r);
      }
    }
    return latest;
  }
}
