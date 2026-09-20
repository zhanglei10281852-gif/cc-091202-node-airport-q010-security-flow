// 时刻快照：只使用 asOf 当时已接收的数据，标注数据可信度，并滚动估算当前队列。
import {
  MINUTE,
  STALE_MIN,
  HORIZON_MIN,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  iso,
} from "./clock.js";
import { waveArrivals } from "./context.js";

// 逐区滚动：从最后一次可见观测起，按波次到达与当时有效能力推算到 asOf。
function estimateZoneQueue(context, zone, obs, asOf, capacityAt) {
  let q = obs.queue;
  for (let t = obs.occurredAt; t < asOf; t += MINUTE) {
    const next = Math.min(t + MINUTE, asOf);
    const arrivals = waveArrivals(context, t, next)[zone] ?? 0;
    const dtMin = (next - t) / MINUTE;
    const cap = Math.max(0, capacityAt(zone, t) ?? 0);
    q = Math.max(0, q + arrivals - cap * dtMin);
  }
  return q;
}

export function buildSnapshot({ context, log, asOf, capacityAt, horizonMin = HORIZON_MIN }) {
  const latest = log.latestPerZone(asOf);
  const zones = {};

  for (const zone of context.zones) {
    const obs = latest.get(zone) ?? null;
    const notes = [];
    let quality = "missing";
    let estimatedQueue = null;
    let ageMs = null;
    let lagMs = null;

    if (obs) {
      ageMs = asOf - obs.occurredAt;
      lagMs = obs.receivedAt - obs.occurredAt;
      const cap = capacityAt(zone, asOf) ?? 0;
      estimatedQueue = estimateZoneQueue(context, zone, obs, asOf, capacityAt);

      if (ageMs > STALE_MIN * MINUTE) {
        quality = "stale";
        notes.push(`最新观测距今 ${Math.round(ageMs / MINUTE)} 分钟（>${STALE_MIN} 分钟），队列由波次与当前能力推算`);
      } else if (obs.confidence < CONFIDENCE_MEDIUM) {
        quality = "low-confidence";
        notes.push(`传感器可信度仅 ${obs.confidence.toFixed(2)}`);
      } else if (obs.confidence < CONFIDENCE_HIGH || ageMs > (STALE_MIN * MINUTE) / 2) {
        quality = "fair";
        if (obs.confidence < CONFIDENCE_HIGH) notes.push(`传感器可信度 ${obs.confidence.toFixed(2)}，低于高可信阈值`);
        if (ageMs > (STALE_MIN * MINUTE) / 2) notes.push("观测已偏旧，建议尽快复核");
      } else {
        quality = "fresh";
      }
      if (lagMs > 2 * MINUTE) notes.push(`该观测迟到 ${Math.round(lagMs / MINUTE)} 分钟入库`);
    } else {
      notes.push("该时刻之前没有任何已接收观测，队列规模未知");
    }

    const capacity = capacityAt(zone, asOf) ?? 0;
    zones[zone] = {
      quality,
      estimatedQueue: estimatedQueue === null ? null : Math.round(estimatedQueue),
      currentWaitMin: estimatedQueue === null ? null : (capacity > 0 ? Math.round((estimatedQueue / capacity) * 10) / 10 : null),
      capacityPpm: Math.round(capacity * 100) / 100,
      latestObservation: obs
        ? {
            observationId: obs.observationId,
            queue: obs.queue,
            occurredAt: iso(obs.occurredAt),
            receivedAt: iso(obs.receivedAt),
            ageMin: Math.round(ageMs / MINUTE),
            reportLagMin: Math.round(lagMs / MINUTE),
            confidence: obs.confidence,
            isCorrection: Boolean(obs.corrects),
            corrects: obs.corrects ?? undefined,
          }
        : null,
      notes,
    };
  }

  const incomingWaves = context.waves
    .filter((w) => w.arriveEnd > asOf && w.arriveStart < asOf + horizonMin * MINUTE)
    .map((w) => ({
      waveId: w.waveId,
      departAt: iso(w.departAt),
      arriveStart: iso(w.arriveStart),
      arriveEnd: iso(w.arriveEnd),
      startsInMin: Math.round((w.arriveStart - asOf) / MINUTE),
      passengers: w.passengers,
    }));

  return { asOf: iso(asOf), horizonMin, zones, incomingWaves };
}
