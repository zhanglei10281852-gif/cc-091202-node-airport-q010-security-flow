// 历史重放：在任意历史时刻 asOf 重建当时可见数据与当时规则下的建议，
// 再与事后才知道的实际等待比较。实际序列使用“发生时刻”的观测真值
// （含当时尚未到达的迟到更正），但明确标注哪些信息在 asOf 不可见。
import { MINUTE, HORIZON_MIN, iso, round1 } from "./clock.js";
import { ObservationLog } from "./observations.js";
import { buildSnapshot } from "./snapshot.js";
import { recommend } from "./engine.js";

export function replay({ context, store, asOf, horizonMin = HORIZON_MIN }) {
  const view = store.viewAt(asOf, context);
  const logThen = new ObservationLog(view.observations);
  const recommendation = recommend({ context, log: logThen, asOf, resources: view, horizonMin });
  const snapshotThen = buildSnapshot({ context, log: logThen, asOf, capacityAt: view.capacityAt, horizonMin });

  const horizonEnd = asOf + horizonMin * MINUTE;

  // 事后真值日志：不按 receivedAt 过滤，取每条观测最新的更正版本（按 occurredAt）。
  const truth = new ObservationLog(store.observations);
  const allVisible = truth.visible(Infinity);
  const hiddenAtAsOf = allVisible.filter(
    (r) => r.occurredAt <= asOf && r.receivedAt > asOf
  );
  const correctedLater = allVisible.filter(
    (r) => r.corrects && r.occurredAt <= asOf && r.receivedAt > asOf
  );

  const actual = {};
  for (const zone of context.zones) {
    const points = allVisible
      .filter((r) => r.zone === zone && r.occurredAt >= asOf && r.occurredAt <= horizonEnd)
      .map((r) => {
        const cap = store.viewAt(r.occurredAt, context).capacityAt(zone, r.occurredAt);
        return {
          at: iso(r.occurredAt),
          queue: r.queue,
          capacityPpm: round1(cap),
          waitMin: cap > 0 ? round1(r.queue / cap) : null,
          wasVisibleAtAsOf: r.receivedAt <= asOf,
        };
      })
      .sort((a, b) => a.at.localeCompare(b.at));
    const peak = points.reduce((m, p) => Math.max(m, p.waitMin ?? 0), 0);
    actual[zone] = { observed: points, actualPeakWaitMin: round1(peak) };
  }

  const comparisons = recommendation.decisions
    .filter((d) => d.type === "OPEN_LANE" || d.type === "CROSS_ZONE_SUPPORT")
    .map((d) => {
      const real = actual[d.zone];
      const predictedPeak = d.expected.peakWaitWithActionMin;
      const noActionPeak = d.expected.peakWaitWithoutActionMin;
      const accepted = store.assignments.some(
        (a) => a.lane === d.lane && a.staffId === d.staffId &&
          a.acceptedAt >= asOf - 2 * MINUTE && a.acceptedAt <= asOf + 5 * MINUTE
      );
      return {
        zone: d.zone,
        lane: d.lane,
        type: d.type,
        acceptedAtAsOf: accepted,
        predicted: {
          holdPeakWaitMin: noActionPeak,
          actionPeakWaitMin: predictedPeak,
          expectedPeakReductionMin: d.expected.peakWaitReductionMin,
        },
        actualPeakWaitMin: real.actualPeakWaitMin,
        actualVsHoldMin: round1((real.actualPeakWaitMin ?? 0) - noActionPeak),
        note: real.observed.length === 0
          ? "窗口内没有事后观测，无法核对实际等待"
          : accepted
            ? "建议被接受：实际峰值应与执行后预期对比"
            : "建议未被接受：实际峰值反映的是维持现状路径",
      };
    });

  return {
    asOf: iso(asOf),
    horizonMin,
    snapshotThen,
    recommendation,
    informationEdge: {
      hiddenObservations: hiddenAtAsOf.map((r) => ({
        observationId: r.observationId,
        zone: r.zone,
        occurredAt: iso(r.occurredAt),
        receivedAt: iso(r.receivedAt),
        queue: r.queue,
        correction: r.corrects ?? null,
      })),
      correctionsArrivingLater: correctedLater.map((r) => ({
        observationId: r.observationId,
        corrects: r.corrects,
        receivedAt: iso(r.receivedAt),
      })),
      note: "以上信息在 asOf 时刻均不可见，未参与当时的快照与建议；仅用于事后核对。",
    },
    actualWaits: actual,
    comparisons,
  };
}
