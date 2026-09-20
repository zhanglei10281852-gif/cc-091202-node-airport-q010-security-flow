// 滚动决策引擎：在时刻 t 依据当时可见数据与当时生效规则给出建议。
// 硬性护栏（任何情况下不得自动建议）：
//  1) 资质不符的员工不上岗；
//  2) 法定/排班休息与有效区间冲突不派，工时不足则截断或不派；
//  3) 出借方在预测窗口内等待超过保护阈值不派；
//  4) 人工强制覆盖的通道、被暂停自动建议的区域不动作；
//  5) 同一通道冷却期内不重复切换。
import { MINUTE_MS } from "./time.js";
import { buildWorld } from "./snapshot.js";
import { assessDataQuality } from "./data-quality.js";
import { forecast, hypotheticalEffects, staffedCapacity } from "./forecast.js";

const MIN_USEFUL_MIN = 15;

export function evaluate(store, t, rules) {
  const view = store.viewAt(t);
  return evaluateView(view, t, rules);
}

export function evaluateView(view, t, rules) {
  const world = buildWorld(view, t);
  const quality = assessDataQuality(world, rules);
  const baseline = forecast(world, rules);

  const forcedOpenLane = new Set();
  const forcedClosedLane = new Set();
  for (const interval of world.overrideLaneIntervals) {
    (interval.open ? forcedOpenLane : forcedClosedLane).add(interval.lane);
  }

  const zones = [...world.zones.keys()];
  const candidates = [];
  for (const zone of zones) {
    if (world.suppressedZones.has(zone)) continue;
    const zoneQuality = quality.get(zone);
    const f = baseline.get(zone);
    const congested = f.unserved || (f.maxWaitMin !== null && f.maxWaitMin > rules.triggerWaitMin);
    // 无现场观测或数据缺口时不得仅凭航班波次自动派人（经理可人工覆盖）。
    const dataSufficient =
      zoneQuality && zoneQuality.status === "ok" && !zoneQuality.flags.includes("gap") && !zoneQuality.flags.includes("no_data");
    if (congested && dataSufficient) {
      candidates.push(...openCandidates(world, zone, rules, forcedClosedLane));
    }
    // 收通道是“减法”：同样需要近期可信观测，不能仅凭排班空档自动收通道。
    if (dataSufficient) {
      candidates.push(...closeCandidates(world, zone, rules, baseline, forcedOpenLane));
    }
  }

  const scored = candidates
    .map((candidate) => scoreCandidate(world, candidate, rules, baseline, quality))
    .filter((candidate) => candidate !== null);
  const passing = scored.filter((c) => c.passes).sort((a, b) => b.gainPassengerMinutes - a.gainPassengerMinutes);

  // 通过护栏的候选才可能成为建议；其中增配优先于收通道，同分时改善量大者胜。
  const recommendation = passing[0] ?? null;
  const rejected = scored.filter((c) => !c.passes).map((c) => ({
    type: c.action.type,
    zone: c.action.zone,
    lane: c.action.lane ?? null,
    fromZone: c.action.fromZone ?? null,
    reason: c.blockedBy,
  }));
  const consideredButNotChosen = passing.slice(1);

  return {
    asOf: t,
    rulesVersion: rules.version,
    zones: zones.map((zone) => ({
      zone,
      dataQuality: quality.get(zone),
      forecast: baseline.get(zone),
      recommendationSuppressed: world.suppressedZones.has(zone),
    })),
    recommendation,
    alternatives: consideredButNotChosen.slice(0, 3),
    rejectedCandidates: rejected,
    hold: {
      type: "hold",
      chosen: recommendation === null,
      reason:
        recommendation === null
          ? scored.length === 0
            ? "no_action_meets_threshold"
            : [...new Set(scored.filter((c) => !c.passes).flatMap((c) => c.blockedBy))].join("; ") ||
              "no_action_meets_threshold"
          : null,
    },
  };
}

// ---------- 候选生成 ----------

function openCandidates(world, zone, rules, forcedClosedLane) {
  const out = [];
  const zoneState = world.zones.get(zone);

  // 1) 有闲置通道：尝试本区凑岗，缺额再找单个出借区补齐
  for (const lane of zoneState.lanes) {
    if (lane.effectiveOpen) continue;
    if (forcedClosedLane.has(lane.lane)) continue;
    if (inLaneCooldown(world, lane.lane, rules)) continue;
    const roles = lane.crewRoles;

    const locals = pickLocalStaff(world, zone, roles, rules);
    if (locals.complete) {
      out.push(makeOpen(world, zone, lane.lane, roles, locals.assignees, null, rules, 0));
      continue;
    }
    const remaining = locals.remaining;
    for (const donor of donorZones(world, zone)) {
      const walk = world.walkMinutes(donor, zone);
      const picked = pickDonorStaff(world, donor, remaining, rules, walk);
      if (!picked) continue;
      const assignees = [...locals.assignees, ...picked.assignees];
      out.push(makeOpen(world, zone, lane.lane, roles, assignees, donor, rules, walk));
    }
  }

  // 2) 无闲置通道但有“开着却缺岗”的通道：跨区补人
  const missing = missingRolesAtOpenLanes(world, zone);
  if (missing.length > 0) {
    for (const donor of donorZones(world, zone)) {
      const walk = world.walkMinutes(donor, zone);
      const picked = pickDonorStaff(world, donor, missing, rules, walk);
      if (!picked) continue;
      out.push(makeSupport(world, zone, missing, picked.assignees, donor, rules, walk));
    }
  }
  return out;
}

function closeCandidates(world, zone, rules, baseline, forcedOpenLane) {
  const out = [];
  const f = baseline.get(zone);
  if (f.demandUtilization === null || f.demandUtilization >= rules.closeUtil) return out;
  for (const lane of world.zones.get(zone).lanes) {
    if (!lane.effectiveOpen) continue;
    if (forcedOpenLane.has(lane.lane)) continue;
    if (inLaneCooldown(world, lane.lane, rules)) continue;
    out.push({
      candidateId: `close:${lane.lane}`,
      action: {
        type: "close_lane",
        zone,
        lane: lane.lane,
        assignees: [],
      },
      validUntil: world.at + rules.maxCommandMin * MINUTE_MS,
    });
  }
  return out;
}

function makeOpen(world, zone, lane, roles, assignees, donor, rules, walk) {
  const readyMin = walk > 0 ? walk : rules.localMusterMin;
  const validUntil = sharedValidUntil(world, assignees, rules);
  return {
    candidateId: `open:${lane}${donor ? `<-${donor}` : ""}`,
    readyMin,
    action: {
      type: "open_lane",
      zone,
      lane,
      roles: assignees.map((a) => a.role),
      assignees: assignees.map((a) => a.staffId),
      fromZone: donor ?? zone,
      walkMin: walk,
      walkBackMin: walk,
    },
    assigneeWindows: assignees,
    validUntil,
  };
}

function makeSupport(world, zone, roles, assignees, donor, rules, walk) {
  const readyMin = walk > 0 ? walk : rules.localMusterMin;
  const validUntil = sharedValidUntil(world, assignees, rules);
  return {
    candidateId: `support:${zone}<-${donor}:${roles.join("+")}`,
    readyMin,
    action: {
      type: "cross_zone_support",
      zone,
      roles: assignees.map((a) => a.role),
      assignees: assignees.map((a) => a.staffId),
      fromZone: donor,
      walkMin: walk,
      walkBackMin: walk,
    },
    assigneeWindows: assignees,
    validUntil,
  };
}

// ---------- 人员选择 ----------

function pickLocalStaff(world, zone, roles, rules) {
  const assignees = [];
  const remaining = [...roles];
  // 只能动用“冗余”：扣除维持当前已开放通道所需人员后仍在区的人，
  // 否则把 E-01 的X光机员调去 E-03 只是拆东墙补西墙。
  const slack = zoneSlack(world, zone).filter(
    (s) => s.location === zone && !s.reserved && !s.placed,
  );
  greedyFill(world, slack, remaining, assignees, rules, rules.localMusterMin);
  return { assignees, remaining, complete: remaining.length === 0 };
}

function pickDonorStaff(world, donor, roles, rules, walk) {
  // 出借人也必须是出借区的冗余，出借方保护阈值在评分阶段再次校验。
  const slack = zoneSlack(world, donor).filter(
    (s) => s.location === donor && !s.reserved && !s.placed,
  );
  const assignees = [];
  const remaining = [...roles];
  greedyFill(world, slack, remaining, assignees, rules, walk);
  if (remaining.length > 0) return null;
  return { assignees };
}

// 返回某区在“两分钟后”维持已开放通道之外的冗余员工（含其资质）。
function zoneSlack(world, zone) {
  const zoneState = world.zones.get(zone);
  const eff = {
    laneIntervals: [...world.laneIntervals, ...world.overrideLaneIntervals],
    placements: world.placements,
    reservations: world.reservations,
  };
  const m = world.at + 2 * MINUTE_MS;
  const openLanes = openLanesStaffing(zoneState, eff.laneIntervals, m);
  const present = [...world.staff.values()]
    .filter((s) => {
      if (world.unavailableStaff?.has(s.id)) return false;
      let loc = s.person.homeZone;
      for (const p of eff.placements) {
        if (p.staffId === s.id && m >= p.arrive && m < p.leaveDest) loc = p.to;
      }
      return loc === zone;
    });
  const used = new Set();
  // 与 forecast.staffedCapacity 相同的贪心方式占用现有通道岗位
  for (const lane of openLanes) {
    for (const role of lane.crewRoles ?? ["XRAY"]) {
      const candidate = present.find(
        (s) => !used.has(s.id) && s.person.qualifications.has(role),
      );
      if (candidate) used.add(candidate.id);
    }
  }
  return present.filter((s) => !used.has(s.id));
}

function openLanesStaffing(zoneState, intervals, m) {
  const stateById = new Map(zoneState.lanes.map((l) => [l.lane, l]));
  const openById = new Map(zoneState.lanes.map((l) => [l.lane, l.baselineOpen]));
  for (const interval of intervals
    .filter((i) => stateById.has(i.lane) && i.start <= m && m < i.end)
    .sort((a, b) => b.start - a.start)) {
    openById.set(interval.lane, interval.open);
  }
  return [...openById.entries()].filter(([, open]) => open).map(([id]) => stateById.get(id));
}

function greedyFill(world, poolIn, remaining, assignees, rules, readyMin) {
  // 先派资质面窄的专家，把多面手留给未知缺额；编号兜底保证结果确定。
  const pool = [...poolIn].sort(byFlexibility);
  for (let i = remaining.length - 1; i >= 0; i -= 1) {
    const role = remaining[i];
    const candidate = pool.find(
      (s) =>
        !assignees.some((a) => a.staffId === s.id) &&
        s.person.qualifications.has(role) &&
        workWindow(world, s, readyMin, rules).compatible,
    );
    if (candidate) {
      const window = workWindow(world, candidate, readyMin, rules);
      assignees.push({ staffId: candidate.id, role, readyMin, availableUntil: window.availableUntil });
      remaining.splice(i, 1);
    }
  }
}

function byFlexibility(a, b) {
  const qa = a.person.qualifications.size;
  const qb = b.person.qualifications.size;
  if (qa !== qb) return qa - qb;
  return a.id.localeCompare(b.id);
}

// 工作区间为 [到位, 指令结束]；出发后步行也算离岗，撤回后走回必须在休息开始前到家。
function workWindow(world, state, readyMin, rules) {
  const now = world.at;
  const workStart = now + readyMin * MINUTE_MS;
  const person = state.person;
  let limit = person.shiftEnd;
  if (!Number.isFinite(limit)) limit = now + rules.maxCommandMin * MINUTE_MS;
  for (const breakRange of person.breaks) {
    if (breakRange.start > now) limit = Math.min(limit, breakRange.start - readyMin * MINUTE_MS);
    if (breakRange.start <= workStart && breakRange.end > workStart) {
      return { compatible: false, reason: "legal_break_conflict" };
    }
  }
  const availableUntil = Math.min(now + rules.maxCommandMin * MINUTE_MS, limit);
  if (!person.shiftStart || workStart < person.shiftStart) return { compatible: false, reason: "not_on_shift" };
  if (availableUntil - workStart < MIN_USEFUL_MIN * MINUTE_MS) {
    return { compatible: false, reason: "window_too_short" };
  }
  return { compatible: true, availableUntil };
}

function sharedValidUntil(world, assignees, rules) {
  const windows = assignees.map((a) => workWindow(world, world.staff.get(a.staffId), a.readyMin, rules));
  if (windows.some((w) => !w.compatible)) return null;
  return Math.min(...windows.map((w) => w.availableUntil));
}

function missingRolesAtOpenLanes(world, zone) {
  const zoneState = world.zones.get(zone);
  const eff = {
    laneIntervals: [...world.laneIntervals, ...world.overrideLaneIntervals],
    placements: world.placements,
    reservations: world.reservations,
  };
  // 看两分钟后哪些已开放通道仍缺岗，汇总缺岗角色（去重）。
  const cap = staffedCapacity(world, zoneState, eff, world.at + 2 * MINUTE_MS);
  const missing = [];
  for (const laneId of cap.unstaffedLanes) {
    const lane = zoneState.lanes.find((l) => l.lane === laneId);
    for (const role of lane?.crewRoles ?? ["XRAY"]) {
      if (!missing.includes(role)) missing.push(role);
    }
  }
  return missing;
}

function donorZones(world, zone) {
  return [...world.zones.keys()]
    // 被人工接管/暂停自动建议的区域同样不作为出借区，其人力状态由人工负责。
    .filter((z) => z !== zone && !world.suppressedZones.has(z) && world.walkMinutes(z, zone) !== null)
    .sort((a, b) => world.walkMinutes(a, zone) - world.walkMinutes(b, zone));
}

function inLaneCooldown(world, lane, rules) {
  const cutoff = world.at - rules.cooldownMin * MINUTE_MS;
  return world.commands.some((c) => c.action.lane === lane && c.issuedAt >= cutoff);
}

// ---------- 评分 ----------

function scoreCandidate(world, candidate, rules, baseline, quality) {
  if (candidate.validUntil === null) return null;
  const action = candidate.action;
  const readyMin = candidate.readyMin ?? rules.localMusterMin;
  const confirmGrace = rules.localMusterMin + rules.walkGraceMin;
  const hypo = {
    commandId: `hypo-${candidate.candidateId}`,
    issuedAt: world.at,
    readyMin,
    confirmDeadline: world.at + confirmGrace * MINUTE_MS,
    validUntil: candidate.validUntil,
    action,
  };
  const effects = hypotheticalEffects(world, [hypo]);
  const after = forecast(world, rules, effects);

  const target = action.zone;
  const before = baseline.get(target);
  const afterTarget = after.get(target);
  const beforeWait = before.waitPassengerMinutes ?? 0;
  const afterWait = afterTarget.waitPassengerMinutes ?? 0;
  const gain = beforeWait - afterWait;

  const blockedBy = [];
  const tradeoffs = [];

  if (action.type === "close_lane") {
    // 收通道不追求等待下降；约束是收完后仍不触发拥堵阈值
    if (afterTarget.unserved || (afterTarget.maxWaitMin ?? Infinity) > rules.triggerWaitMin) {
      blockedBy.push("close_would_cause_congestion");
    }
    if (gain < 0) tradeoffs.push({ zone: target, waitPassengerMinutesBefore: beforeWait, waitPassengerMinutesAfter: afterWait });
  } else {
    if (gain < rules.minGain) blockedBy.push(`gain_below_threshold(${Math.round(gain)}<${rules.minGain})`);
    if (afterTarget.unserved) blockedBy.push("target_still_unserved");
  }

  // 出借方保护：任何非本区人力流出都要验证出借区预测等待
  const donor = action.fromZone && action.fromZone !== target ? action.fromZone : null;
  if (donor) {
    const donorBefore = baseline.get(donor);
    const donorAfter = after.get(donor);
    tradeoffs.push({
      zone: donor,
      maxWaitBefore: donorBefore.maxWaitMin,
      maxWaitAfter: donorAfter.maxWaitMin,
      waitPassengerMinutesBefore: donorBefore.waitPassengerMinutes,
      waitPassengerMinutesAfter: donorAfter.waitPassengerMinutes,
    });
    if (donorAfter.unserved || (donorAfter.maxWaitMin ?? Infinity) > rules.donorMaxWaitMin) {
      blockedBy.push("donor_wait_protection");
    }
  }

  const dataTrust = quality.get(target)?.trustLevel ?? "low";
  const earliest = world.at + readyMin * MINUTE_MS;

  return {
    recommendationId: candidate.candidateId,
    type: action.type,
    action: {
      type: action.type,
      zone: target,
      lane: action.lane ?? null,
      fromZone: donor,
      assignees: action.assignees,
      roles: action.roles ?? null,
      walkMin: action.walkMin ?? 0,
    },
    expected: {
      targetMaxWaitBefore: before.maxWaitMin,
      targetMaxWaitAfter: afterTarget.maxWaitMin,
      targetQueuePeakBefore: before.peakQueue,
      targetQueuePeakAfter: afterTarget.peakQueue,
      gainPassengerMinutes: Math.round(gain),
    },
    sacrificed: tradeoffs,
    earliestEffectiveAt: earliest,
    confirmDeadline: hypo.confirmDeadline,
    validUntil: candidate.validUntil,
    dataTrust,
    confidence: dataTrust === "high" ? "high" : dataTrust === "medium" ? "medium" : "low",
    blockedBy,
    passes: blockedBy.length === 0,
    gainPassengerMinutes: action.type === "close_lane" ? 0 : Math.round(gain),
  };
}
