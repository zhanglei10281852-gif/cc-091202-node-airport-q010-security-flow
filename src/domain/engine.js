// 滚动调配建议引擎（纯函数）：
// 依据 asOf 当时可见的观测与资料枚举候选动作，仿真“维持现状 vs 执行候选”，
// 选出净等待改善最大的方案。资质不足、法定休息冲突、无法及时到岗者只进入
// screenedOut 说明，绝不成为建议。
import {
  MINUTE,
  HORIZON_MIN,
  OPEN_TRIGGER_WAIT_MIN,
  PEAK_TRIGGER_WAIT_MIN,
  CALM_MAX_WAIT_MIN,
  SACRIFICE_MAX_WAIT_MIN,
  TTL_DEFAULT_MIN,
  ACTIVATION_SLACK_MIN,
  iso,
  round1,
  hhmm,
} from "./clock.js";
import { restConflict } from "./context.js";
import { simulate } from "./simulate.js";
import { buildSnapshot } from "./snapshot.js";

function capacityProvider(resources) {
  return (zone, t) => resources.capacityAt(zone, t);
}

function trajMap(trajectory) {
  // zone -> [{at, waitMin, queue, capacity}]
  const map = new Map();
  for (const row of trajectory) {
    for (const [z, p] of Object.entries(row.zones)) {
      if (!map.has(z)) map.set(z, []);
      map.get(z).push({ at: row.at, ...p });
    }
  }
  return map;
}

function integralWait(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const wa = Number.isFinite(a.waitMin) ? a.waitMin : 0;
    const wb = Number.isFinite(b.waitMin) ? b.waitMin : 0;
    total += ((wa + wb) / 2) * ((b.at - a.at) / MINUTE);
  }
  return total;
}

function peakWait(points) {
  let peak = 0;
  for (const p of points) if (Number.isFinite(p.waitMin) && p.waitMin > peak) peak = p.waitMin;
  return peak;
}

// 在基准能力上叠加候选动作的临时能力曲线。
function candidateCapacity(resources, candidate) {
  return (zone, t) => {
    let cap = resources.capacityAt(zone, t);
    const { readyAt, departAt, expiresAt } = candidate;
    if (zone === candidate.zone && t >= readyAt && t < expiresAt) cap += candidate.lanePpm;
    // 跨区支援：员工原岗位通道随其离岗而关闭（按原通道能力折减）。
    if (candidate.fromZone && zone === candidate.fromZone && t >= departAt && t < expiresAt) {
      cap = Math.max(0, cap - candidate.donorPpm);
    }
    return cap;
  };
}

function staffCommitted(resources, staffId, windowStart, windowEnd) {
  return resources.commitments.some(
    (c) => c.staffId === staffId && c.start < windowEnd && c.end > windowStart
  );
}

// 评估某条紧张区域的待开通道，返回所有可行候选（含被筛掉原因）。
function enumerateForLane(context, resources, snapshot, zone, lane, asOf, horizonEnd) {
  const options = [];
  const screenedOut = [];
  const departAt = asOf + ACTIVATION_SLACK_MIN * MINUTE;
  const expiresAt = Math.min(asOf + TTL_DEFAULT_MIN * MINUTE, horizonEnd);

  for (const member of context.staff) {
    const ref = { staffId: member.staffId, homeZone: member.homeZone, role: member.role };
    const walkMin = member.homeZone ? context.walkMinutes(member.homeZone, zone) : null;
    const readyAt = member.homeZone
      ? Math.max(member.availableAt, departAt + (walkMin ?? 0) * MINUTE)
      : Math.max(member.availableAt, departAt);

    const type = member.role === "reserve" || member.homeZone === zone ? "OPEN_LANE" : "CROSS_ZONE_SUPPORT";
    const donorLane = type === "CROSS_ZONE_SUPPORT" ? member.lane : null;
    const donorPpm = donorLane
      ? context.lanes.find((l) => l.lane === donorLane)?.ppm ?? lane.ppm
      : 0;

    let reason = null;
    if (!member.qualifications.includes(lane.qualification)) {
      reason = `资质不足：持 ${member.qualifications.join("/") || "无"}，通道要求 ${lane.qualification}`;
    } else if (member.homeZone && walkMin === null) {
      reason = `缺少从 ${member.homeZone} 到 ${zone} 的换岗步行时间资料`;
    } else if (type === "CROSS_ZONE_SUPPORT" && !member.lane) {
      reason = "缺少该员工的原岗位通道资料，无法评估被牺牲区域的能力损失";
    } else if (staffCommitted(resources, member.staffId, departAt, expiresAt)) {
      reason = "已在其他未结束的调配指令中，不能重复派人";
    } else {
      const conflict = restConflict(member, departAt, expiresAt);
      if (conflict) {
        reason = `法定休息冲突：${hhmm(conflict.start, context.timeZone)}–${hhmm(conflict.end, context.timeZone)}（${conflict.reason}）`;
      } else if (readyAt >= expiresAt) {
        reason = `无法及时到岗：预计 ${iso(readyAt)} 到岗，晚于指令时限 ${iso(expiresAt)}`;
      }
    }
    if (reason) {
      screenedOut.push({ ...ref, reason });
      continue;
    }

    options.push({
      type,
      zone,
      lane: lane.lane,
      lanePpm: lane.ppm,
      donorLane,
      donorPpm,
      qualification: lane.qualification,
      staffId: member.staffId,
      fromZone: type === "CROSS_ZONE_SUPPORT" ? member.homeZone : null,
      walkMin,
      departAt,
      readyAt,
      expiresAt,
      screenedOut,
    });
  }
  return { options, screenedOut };
}

function qualityLevel(zoneSnapshot) {
  switch (zoneSnapshot.quality) {
    case "fresh":
      return "high";
    case "fair":
      return "medium";
    default:
      return "low"; // stale / low-confidence / missing
  }
}

export function recommend({ context, log, asOf, resources, horizonMin = HORIZON_MIN }) {
  const capAt = capacityProvider(resources);
  const horizonEnd = asOf + horizonMin * MINUTE;
  const snapshot = buildSnapshot({ context, log, asOf, capacityAt: capAt, horizonMin });
  const initial = new Map();
  const zoneSnap = {};
  for (const zone of context.zones) {
    const s = snapshot.zones[zone];
    zoneSnap[zone] = s;
    initial.set(zone, s.estimatedQueue ?? 0);
  }

  const base = trajMap(
    simulate(context, { start: asOf, end: horizonEnd, initial, capacityAt: capAt })
  );

  const decisions = [];
  const dataWarnings = [];

  for (const zone of context.zones) {
    const zs = zoneSnap[zone];
    const pts = base.get(zone) ?? [];
    const basePeak = peakWait(pts);
    const currentWait = zs.currentWaitMin ?? 0;
    const stressed = currentWait > OPEN_TRIGGER_WAIT_MIN || basePeak > PEAK_TRIGGER_WAIT_MIN;

    if (zs.quality === "missing") {
      dataWarnings.push(`${zone}：无任何当时已接收观测，不生成调配建议`);
      continue;
    }

    const closedLanes = context.lanes.filter((l) => l.zone === zone && !resources.laneOpenAt(l.lane, asOf));

    if (stressed && closedLanes.length > 0) {
      let best = null;
      const allScreened = [];
      for (const lane of closedLanes) {
        const { options, screenedOut } = enumerateForLane(context, resources, zs, zone, lane, asOf, horizonEnd);
        allScreened.push(...screenedOut);
        for (const candidate of options) {
          const cap2 = candidateCapacity(resources, candidate);
          const cand = trajMap(
            simulate(context, { start: asOf, end: horizonEnd, initial, capacityAt: cap2 })
          );
          const targetPts = cand.get(zone) ?? [];
          const savedWaitMin = integralWait(pts) - integralWait(targetPts);
          const peakAfter = peakWait(targetPts);

          let sacrifice = null;
          let donorPeakAfter = 0;
          if (candidate.fromZone) {
            const donorBefore = peakWait(base.get(candidate.fromZone) ?? []);
            donorPeakAfter = peakWait(cand.get(candidate.fromZone) ?? []);
            sacrifice = {
              zone: candidate.fromZone,
              peakWaitBeforeMin: round1(donorBefore),
              peakWaitAfterMin: round1(donorPeakAfter),
              addedWaitMin: round1(integralWait(cand.get(candidate.fromZone) ?? []) - integralWait(base.get(candidate.fromZone) ?? [])),
            };
          }

          const netBenefit = savedWaitMin - (sacrifice?.addedWaitMin ?? 0);
          const sacrificeOk = !sacrifice || donorPeakAfter <= SACRIFICE_MAX_WAIT_MIN;
          candidate._score = { savedWaitMin, peakAfter, sacrificeOk, sacrifice, netBenefit };
          if (!sacrificeOk) {
            allScreened.push({
              staffId: candidate.staffId,
              homeZone: candidate.fromZone,
              role: "station",
              reason: `抽走一条通道后 ${candidate.fromZone} 峰值等待 ${round1(donorPeakAfter)} 分钟，超过被牺牲区域上限 ${SACRIFICE_MAX_WAIT_MIN} 分钟`,
            });
            continue;
          }
          if (savedWaitMin < 1) {
            allScreened.push({
              staffId: candidate.staffId,
              homeZone: candidate.fromZone,
              role: candidate.role,
              reason: `预计等待改善不足 1 分钟（节省约 ${round1(savedWaitMin)} 等待·分钟）`,
            });
            continue;
          }
          if (!best) {
            best = candidate;
          } else {
            const bestNet = best._score.netBenefit;
            // 净改善相近（≤1 等待·分钟）时优先不动其他区域的备勤方案。
            const preferThis =
              netBenefit > bestNet + 1 ||
              (Math.abs(netBenefit - bestNet) <= 1 &&
                candidate.type === "OPEN_LANE" &&
                best.type !== "OPEN_LANE");
            if (preferThis) best = candidate;
          }
        }
      }

      if (best) {
        decisions.push({
          type: best.type,
          zone,
          lane: best.lane,
          lanePpm: best.lanePpm,
          donorLane: best.donorLane,
          donorPpm: best.donorPpm,
          staffId: best.staffId,
          fromZone: best.fromZone,
          walkMin: best.walkMin,
          acceptBefore: iso(best.departAt),
          readyAt: iso(best.readyAt),
          expiresAt: iso(best.expiresAt),
          ttlMin: Math.round((best.expiresAt - asOf) / MINUTE),
          expected: {
            currentWaitMin: round1(currentWait),
            peakWaitWithoutActionMin: round1(basePeak),
            peakWaitWithActionMin: round1(best._score.peakAfter),
            peakWaitReductionMin: round1(basePeak - best._score.peakAfter),
            savedWaitMinutesOverHorizon: round1(best._score.savedWaitMin),
          },
          sacrificed: best._score.sacrifice,
          confidence: qualityLevel(zs),
          dataNotes: zs.notes,
          rationale: rationaleFor(best, zone, round1(basePeak), round1(best._score.peakAfter)),
          screenedOut: dedupe(allScreened),
        });
        continue;
      }
      // 紧张但没有可行人/通道：明确上报，而不是静默 HOLD。
      decisions.push({
        type: "HOLD",
        zone,
        holdReason: "no-feasible-resource",
        expected: { currentWaitMin: round1(currentWait), peakWaitWithoutActionMin: round1(basePeak) },
        confidence: qualityLevel(zs),
        dataNotes: zs.notes,
        rationale: `${zone} 正在排队（当前约 ${round1(currentWait)} 分钟，窗口峰值约 ${round1(basePeak)} 分钟），但没有满足资质/休息/到岗时限的可用人力`,
        screenedOut: dedupe(allScreened),
      });
      continue;
    }

    // 非紧张区域：若关掉一条仍宽松的通道，建议回收人力（优先关临时增开的通道）。
    if (!stressed && currentWait <= CALM_MAX_WAIT_MIN && basePeak <= CALM_MAX_WAIT_MIN) {
      const closable = closableLanes(context, resources, zone, asOf);
      for (const lane of closable) {
        const cap2 = (z, t) =>
          z === zone && t >= asOf && t < horizonEnd
            ? Math.max(0, capAt(z, t) - lane.ppm)
            : capAt(z, t);
        const cand = trajMap(
          simulate(context, { start: asOf, end: horizonEnd, initial, capacityAt: cap2 })
        );
        if (peakWait(cand.get(zone) ?? []) <= CALM_MAX_WAIT_MIN) {
          decisions.push({
            type: "CLOSE_LANE",
            zone,
            lane: lane.lane,
            temporary: lane.temporary,
            expected: {
              peakWaitWithoutActionMin: round1(basePeak),
              peakWaitWithActionMin: round1(peakWait(cand.get(zone) ?? [])),
            },
            confidence: qualityLevel(zs),
            dataNotes: zs.notes,
            rationale: `${zone} 未来 ${horizonMin} 分钟峰值等待约 ${round1(basePeak)} 分钟，关闭 ${lane.lane} 后仍不超过 ${CALM_MAX_WAIT_MIN} 分钟，可回收人力`,
          });
          break;
        }
      }
    }

    if (!decisions.some((d) => d.zone === zone)) {
      decisions.push({
        type: "HOLD",
        zone,
        expected: { currentWaitMin: round1(currentWait), peakWaitWithoutActionMin: round1(basePeak) },
        confidence: qualityLevel(zs),
        dataNotes: zs.notes,
        rationale: zs.quality === "missing"
          ? "数据缺失，维持现状"
          : `${zone} 当前约 ${round1(currentWait)} 分钟、窗口峰值约 ${round1(basePeak)} 分钟，无需调配`,
      });
    }
  }

  return {
    asOf: iso(asOf),
    horizonMin,
    thresholds: {
      openTriggerWaitMin: OPEN_TRIGGER_WAIT_MIN,
      peakTriggerWaitMin: PEAK_TRIGGER_WAIT_MIN,
      calmMaxWaitMin: CALM_MAX_WAIT_MIN,
      sacrificeMaxWaitMin: SACRIFICE_MAX_WAIT_MIN,
    },
    decisions: decisions.sort((a, b) => decisionRank(b) - decisionRank(a)),
    dataWarnings,
  };
}

function decisionRank(d) {
  const order = { CROSS_ZONE_SUPPORT: 4, OPEN_LANE: 3, CLOSE_LANE: 2, HOLD: 1 };
  return order[d.type] ?? 0;
}

function rationaleFor(candidate, zone, peakBefore, peakAfter) {
  const who = candidate.type === "OPEN_LANE"
    ? `由备勤 ${candidate.staffId} 开启 ${candidate.lane}`
    : `由 ${candidate.fromZone} 的 ${candidate.staffId} 步行约 ${candidate.walkMin} 分钟跨区支援，开启 ${candidate.lane}`;
  const sacrifice = candidate._score.sacrifice
    ? `；被牺牲区域 ${candidate._score.sacrifice.zone} 峰值等待升至约 ${candidate._score.sacrifice.peakWaitAfterMin} 分钟`
    : "；使用备勤人力，不牺牲其他区域";
  return `${zone} 窗口峰值等待约 ${peakBefore} 分钟，${who}，预计峰值降至约 ${peakAfter} 分钟${sacrifice}`;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => {
    const k = `${x.staffId}|${x.homeZone ?? ""}|${x.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function closableLanes(context, resources, zone, asOf) {
  // 只回收临时增开（调配指令/人工开启）的通道；基线通道不因短暂空闲自动关闭，
  // 以免频繁开关通道本身制造新拥堵。
  return context.lanes
    .filter((l) => l.zone === zone && resources.laneOpenAt(l.lane, asOf))
    .map((l) => ({ ...l, temporary: resources.laneSource?.(l.lane, asOf) ?? "baseline" }))
    .filter((l) => l.temporary !== "baseline");
}
