// 历史重放与效果对比：
//  - 在任意历史时刻 t 重建“当时可见数据 + 当时规则”下的评估；
//  - 对比当时建议的预测改善与后来实际发生的等待变化。
// 预测遵守双时态（只看当时已接收）；实际结果用事后完整视图重建物理真值，
// 并单独列出决策后才到达的迟到记录，解释两者差异。
import { toMs, MINUTE_MS } from "./time.js";
import { rulesAt } from "./rules.js";
import { evaluateView } from "./decision.js";
import { buildWorld, hydrateCommand } from "./snapshot.js";
import { assessDataQuality } from "./data-quality.js";
import { staffedCapacity } from "./forecast.js";

export function replayDecision(store, at) {
  const t = typeof at === "number" ? at : requireParseTime(at);
  const rules = rulesAt(t);
  const view = store.viewAt(t);
  const evaluation = evaluateView(view, t, rules);
  return {
    asOf: t,
    rulesVersion: rules.version,
    visibleRecordCount: view.entries.length,
    evaluation,
  };
}

export function compareOutcomes(store, decisionAt, evaluateAtRaw) {
  const t0 = typeof decisionAt === "number" ? decisionAt : requireParseTime(decisionAt);
  const t1 = evaluateAtRaw === undefined ? null : typeof evaluateAtRaw === "number" ? evaluateAtRaw : requireParseTime(evaluateAtRaw);
  const replayed = replayDecision(store, t0);
  const evaluationEnd = t1 ?? t0 + replayed.evaluation.zones.reduce((m, z) => Math.max(m, z.forecast.horizonMin), 40) * MINUTE_MS;

  const rulesNow = rulesAt(evaluationEnd);
  const viewNow = store.viewAt(evaluationEnd);
  const worldNow = buildWorld(viewNow, evaluationEnd);
  const qualityNow = assessDataQuality(worldNow, rulesNow);

  const zones = replayed.evaluation.zones.map((zoneEval) => {
    const zone = zoneEval.zone;
    const predicted = zoneEval.forecast;
    const realized = realizedOutcomes(store, zone, t0, evaluationEnd, worldNow);
    return {
      zone,
      predictedAtDecision: {
        maxWaitMin: predicted.maxWaitMin,
        avgWaitMin: predicted.avgWaitMin,
        peakQueue: predicted.peakQueue,
        waitPassengerMinutes: predicted.waitPassengerMinutes,
        dataTrust: zoneEval.dataQuality.trustLevel,
      },
      realized,
      dataTrustNow: qualityNow.get(zone)?.trustLevel ?? null,
    };
  });

  // 当时建议被采纳后的实际轨迹
  const rec = replayed.evaluation.recommendation;
  let commandTrace = null;
  if (rec) {
    const commands = viewNow.byKind("command").filter((c) => c.basedOn?.recommendationId === rec.recommendationId);
    commandTrace = commands.map((record) => {
      const events = viewNow.byKind("commandEvent").filter((e) => e.commandId === record.commandId);
      const command = hydrateCommand(record, events);
      return {
        commandId: record.commandId,
        issuedAt: record.issuedAt,
        status: command.statusAt(evaluationEnd),
        acknowledged: [...command.acks.keys()],
        effectiveStart: command.effectiveStart,
        revokedAt: command.revokedAt,
        rejectedBy: command.rejectedBy,
      };
    });
  }

  return {
    decisionAt: t0,
    evaluatedAt: evaluationEnd,
    recommendation: rec
      ? {
          recommendationId: rec.recommendationId,
          type: rec.type,
          zone: rec.action.zone,
          predictedGainPassengerMinutes: rec.expected.gainPassengerMinutes,
          dataTrust: rec.dataTrust,
        }
      : null,
    commandTrace,
    zones,
    lateArrivals: lateArrivalsBetween(store, t0, evaluationEnd),
  };
}

function realizedOutcomes(store, zone, t0, t1, worldNow) {
  // 用区间内实际接收到的观测计算已发生等待：wait ≈ queue / 当时实际配置能力。
  // 观测必须在 t0 之前发生（评价对象是“决策之后”），且在 t1 前已接收。
  const obs = [...worldNow.observations.values()]
    .filter((o) => o.zone === zone && toMs(o.occurredAt) >= t0 && toMs(o.occurredAt) <= t1)
    .sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt));

  let maxQueue = 0;
  let maxImpliedWait = 0;
  let impliedSum = 0;
  let n = 0;
  for (const observation of obs) {
    const at = toMs(observation.occurredAt);
    // 事后完整视图重建物理真值：命令/事件即便补录也按真实时间点生效。
    const worldThen = buildWorld(store.viewAt(t1), at);
    const zoneState = worldThen.zones.get(zone);
    if (!zoneState) continue;
    const eff = {
      laneIntervals: [...worldThen.laneIntervals, ...worldThen.overrideLaneIntervals],
      placements: worldThen.placements,
      reservations: worldThen.reservations,
    };
    const cap = staffedCapacity(worldThen, zoneState, eff, at);
    const queue = Number(observation.queue);
    maxQueue = Math.max(maxQueue, queue);
    if (cap.rate > 0) {
      const implied = queue / cap.rate;
      maxImpliedWait = Math.max(maxImpliedWait, implied);
      impliedSum += implied;
      n += 1;
    }
  }
  return {
    samples: obs.length,
    maxObservedQueue: Math.round(maxQueue),
    maxImpliedWaitMin: n > 0 ? Math.round(maxImpliedWait * 10) / 10 : null,
    avgImpliedWaitMin: n > 0 ? Math.round((impliedSum / n) * 10) / 10 : null,
  };
}

// 决策时刻尚不可见、后来才到的记录：用于说明“事后看”与“当时看”的差异。
// 只统计描述现场世界的记录（观测/更正），指令与确认事件是决策之后的行动，不是迟到信息。
function lateArrivalsBetween(store, t0, t1) {
  const sensorKinds = new Set(["observation", "correction"]);
  return store.entries
    .filter(
      (e) =>
        sensorKinds.has(e.kind) &&
        e.receivedAt > t0 &&
        e.receivedAt <= t1 &&
        toMs(e.record.occurredAt ?? NaN) <= t0,
    )
    .map((e) => ({
      kind: e.kind,
      key: e.key,
      occurredAt: toMs(e.record.occurredAt),
      receivedAt: e.receivedAt,
      lagMin: Math.round((e.receivedAt - toMs(e.record.occurredAt)) / MINUTE_MS),
    }));
}

function requireParseTime(value) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) throw new TypeError(`非法时间: ${value}`);
  return ms;
}
