// 滚动预测：把波次到港、最新队列观测、通道有效能力与员工在岗状态
// 按分钟模拟到评估时长。所有输入都来自时刻 t 的双时态视图，
// 重放与实时共用本模块，保证“当时怎么算，现在就怎么重算”。
import { toMs, MINUTE_MS } from "./time.js";

// 在世界效果之上叠加假设指令，返回它们带来的附加效果（含人工覆盖）。
export function hypotheticalEffects(world, extraCommands) {
  const laneIntervals = [...world.laneIntervals, ...world.overrideLaneIntervals];
  const placements = [...world.placements];
  const reservations = [...world.reservations];
  const out = { laneIntervals, placements, reservations };
  for (const command of extraCommands) collectLike(command, world.at, out);
  return out;
}

function collectLike(command, t, out) {
  // 与 snapshot.collectEffects 同构：确认后集结/步行至到位才提供能力，
  // 出借方从员工出发时损失人手，撤回/到期后还要走回。
  const action = command.action;
  const start = command.issuedAt;
  const readyMin = command.readyMin ?? action.walkMin ?? 0;
  const walkBack = action.walkBackMin ?? action.walkMin ?? 0;
  const arrive = start + readyMin * MINUTE_MS;
  const leaveDest = command.validUntil;

  if (action.type === "open_lane" || action.type === "open_lane_idle" || action.type === "close_lane") {
    out.laneIntervals.push({
      lane: action.lane,
      commandId: command.commandId,
      open: action.type !== "close_lane",
      start: action.type === "close_lane" ? start : arrive,
      end: leaveDest,
    });
  }
  if (action.type === "cross_zone_support" || action.type === "open_lane") {
    for (const staffId of action.assignees) {
      out.placements.push({
        staffId,
        commandId: command.commandId,
        from: action.fromZone ?? action.zone,
        to: action.zone,
        depart: start,
        arrive,
        leaveDest,
        returnHome: leaveDest + walkBack * MINUTE_MS,
      });
    }
  }
}

export function forecast(world, rules, effects = null) {
  const eff = effects ?? {
    laneIntervals: [...world.laneIntervals, ...world.overrideLaneIntervals],
    placements: world.placements,
    reservations: world.reservations,
  };
  const horizonEnd = world.at + rules.horizonMin * MINUTE_MS;
  const result = new Map();
  for (const [zone, zoneState] of world.zones) {
    result.set(zone, forecastZone(world, zone, zoneState, eff, rules, horizonEnd));
  }
  return result;
}

function forecastZone(world, zone, zoneState, eff, rules, horizonEnd) {
  const obs = [...world.observations.values()]
    .filter((o) => o.zone === zone)
    .sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt));
  const waves = world.waves.filter((w) => w.zone === zone);

  // 从最近一次观测的发生时刻起模拟，把观测到现在之间的分钟补齐，
  // 这样重放时即便观测早于 asOf，队列状态仍可向前推算。
  const simStart = obs.length > 0 ? toMs(obs[obs.length - 1].occurredAt) : world.at;
  let queue = obs.length > 0 ? Number(obs[obs.length - 1].queue) : 0;
  const residualRate = estimateResidualRate(obs, world, zone);

  let queueNow = queue;
  let maxWait = 0;
  let queueArea = 0; // ∫队列 dt（人·分钟）：Little 定律下即总等待量，含已在队旅客
  let throughput = 0; // 期间完成安检的旅客，用于折算平均等待
  let arrivalsTotal = 0;
  let openRateTotal = 0;
  let staffedRateTotal = 0;
  let futureArrivals = 0;
  let futureOpenRate = 0;
  let samples = 0;
  let unserved = false;
  let peakQueue = 0;
  let peakAt = null;
  const initialQueue = queue;

  for (let m = simStart; m < horizonEnd; m += MINUTE_MS) {
    const arrivals = waveArrivals(waves, m, rules) + residualRate;
    const cap = staffedCapacity(world, zoneState, eff, m);
    const before = queue;
    queue = Math.max(0, queue + arrivals - cap.rate);
    const served = Math.min(before + arrivals, cap.rate);

    if (m < world.at) continue;
    samples += 1;
    arrivalsTotal += arrivals;
    throughput += served;
    openRateTotal += cap.openRate;
    staffedRateTotal += cap.rate;
    if (queue > peakQueue) {
      peakQueue = queue;
      peakAt = m;
    }
    const wait = cap.rate > 0 ? queue / cap.rate : queue > 0 ? Number.POSITIVE_INFINITY : 0;
    if (!Number.isFinite(wait)) {
      unserved = true;
      maxWait = Number.POSITIVE_INFINITY;
    } else if (Number.isFinite(maxWait)) {
      maxWait = Math.max(maxWait, wait);
    }
    queueArea += queue;
    if (m <= world.at && world.at < m + MINUTE_MS) queueNow = queue;

    if (m < world.at + rules.closeGuardMin * MINUTE_MS) {
      futureArrivals += arrivals;
      futureOpenRate += cap.openRate;
    }
  }

  const servedBase = Math.min(throughput, initialQueue + arrivalsTotal);
  const avgWait = servedBase > 0 && Number.isFinite(queueArea) ? queueArea / servedBase : null;
  return {
    zone,
    latestObservedQueue: obs.length > 0 ? Number(obs[obs.length - 1].queue) : null,
    queueNow: Math.round(queueNow),
    residualRate: round2(residualRate),
    arrivalsNextHorizon: Math.round(arrivalsTotal),
    avgStaffedRate: round2(staffedRateTotal / Math.max(samples, 1)),
    avgOpenRate: round2(openRateTotal / Math.max(samples, 1)),
    // 未来窗口需求 / 开放能力：收通道决策使用，而不是 staffed/open（那只反映缺人）
    demandUtilization: futureOpenRate > 0 ? round2(futureArrivals / futureOpenRate) : null,
    maxWaitMin: unserved ? null : round2(maxWait),
    unserved,
    avgWaitMin: avgWait === null ? null : round2(avgWait),
    waitPassengerMinutes: Number.isFinite(queueArea) ? Math.round(queueArea) : null,
    peakQueue: Math.round(peakQueue),
    peakAt,
    horizonMin: rules.horizonMin,
  };
}

// 用最近一段观测做最小二乘斜率，估计“波次之外”的背景到港率：
// inferred 总到港 = 队列斜率 + 当时服务能力；再扣除观测窗口内已在发生的波次。
function estimateResidualRate(obs, world, zone) {
  const served = baselineOpenRate(world, zone, world.at);
  const recent = obs.filter((o) => world.at - toMs(o.occurredAt) <= 45 * MINUTE_MS);
  if (recent.length >= 2) {
    const t0 = toMs(recent[0].occurredAt);
    const xs = recent.map((o) => (toMs(o.occurredAt) - t0) / MINUTE_MS);
    const ys = recent.map((o) => Number(o.queue));
    const n = xs.length;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let cov = 0;
    let varX = 0;
    for (let i = 0; i < n; i += 1) {
      cov += (xs[i] - meanX) * (ys[i] - meanY);
      varX += (xs[i] - meanX) ** 2;
    }
    if (varX > 0) {
      const slope = cov / varX;
      const spanStart = toMs(recent[0].occurredAt);
      const spanEnd = toMs(recent[recent.length - 1].occurredAt);
      const waveInWindow = averageWaveRate(world.waves.filter((w) => w.zone === zone), spanStart, spanEnd);
      const rate = slope + served - waveInWindow;
      if (Number.isFinite(rate) && rate >= 0 && rate < served * 3 + 5) return rate;
    }
  }
  // 无可靠差分时不能把“开放能力”直接当成到港率：低谷时队列长期低位说明
  // 实际需求远小于能力。用队列水平对均衡先验做收缩（队列≈能力×10 分钟以上才视为满负荷）。
  const latestQueue = obs.length > 0 ? Number(obs[obs.length - 1].queue) : 0;
  const loadRatio = Math.min(1, latestQueue / Math.max(served * 10, 1));
  return Math.round(served * (0.4 + 0.6 * loadRatio) * 100) / 100;
}

function averageWaveRate(waves, start, end) {
  let total = 0;
  for (let m = start; m < end; m += MINUTE_MS) total += waveArrivals(waves, m, null);
  return total / Math.max((end - start) / MINUTE_MS, 1);
}

function baselineOpenRate(world, zone, at) {
  const z = world.zones.get(zone);
  if (!z) return 0;
  const intervals = [...world.laneIntervals, ...world.overrideLaneIntervals]
    .filter((i) => i.start <= at && at < i.end)
    .sort((a, b) => b.start - a.start);
  let rate = 0;
  for (const lane of z.lanes) {
    const override = intervals.find((i) => i.lane === lane.lane);
    const open = override ? override.open : lane.baselineOpen;
    if (open) rate += lane.rate;
  }
  return rate;
}

function waveArrivals(waves, minuteStart, rules) {
  let total = 0;
  for (const wave of waves) {
    const dep = toMs(wave.departsAt);
    const lead = Number(wave.leadMin ?? rules?.waveLeadMin ?? 90) * MINUTE_MS;
    const tail = Number(wave.tailMin ?? rules?.waveTailMin ?? 20) * MINUTE_MS;
    const windowStart = dep - lead;
    const windowEnd = dep - tail;
    if (minuteStart >= windowStart && minuteStart < windowEnd) {
      const seats = Number(wave.seats ?? 0);
      const showRate = Number(wave.showRate ?? 1);
      const windowMin = (windowEnd - windowStart) / MINUTE_MS;
      total += (seats * showRate) / windowMin;
    }
  }
  return total;
}

// 某分钟、某区实际可提供服务的能力：通道物理开放且每岗都有合格且可派的员工。
export function staffedCapacity(world, zoneState, eff, m) {
  const openLanes = openLanesAt(zoneState, eff.laneIntervals, m);
  const present = staffPresentInZone(world, eff, zoneState.zone, m);
  const used = new Set();
  let rate = 0;
  const staffedLanes = [];
  for (const lane of openLanes) {
    const need = lane.crewRoles ?? ["XRAY"];
    let ok = true;
    for (const role of need) {
      const candidate = present.find(
        (s) => !used.has(s.id) && s.person.qualifications.has(role) && !onBreak(s.person, m) && withinShift(s.person, m),
      );
      if (!candidate) {
        ok = false;
        break;
      }
      used.add(candidate.id);
    }
    if (ok) {
      rate += lane.rate;
      staffedLanes.push(lane.lane);
    }
  }
  return {
    rate,
    openRate: openLanes.reduce((s, l) => s + l.rate, 0),
    openLanes: openLanes.map((l) => l.lane),
    staffedLanes,
    unstaffedLanes: openLanes.map((l) => l.lane).filter((l) => !staffedLanes.includes(l)),
    presentStaff: present.map((s) => s.id),
  };
}

function openLanesAt(zoneState, intervals, m) {
  const stateById = new Map(zoneState.lanes.map((l) => [l.lane, l]));
  const openById = new Map(zoneState.lanes.map((l) => [l.lane, l.baselineOpen]));
  const covering = intervals
    .filter((i) => stateById.has(i.lane) && i.start <= m && m < i.end)
    .sort((a, b) => b.start - a.start);
  for (const interval of covering) openById.set(interval.lane, interval.open);
  return [...openById.entries()].filter(([, open]) => open).map(([id]) => stateById.get(id));
}

function staffPresentInZone(world, eff, zone, m) {
  const present = [];
  for (const state of world.staff.values()) {
    if (world.unavailableStaff?.has(state.id)) continue;
    let loc = state.person.homeZone;
    let away = false;
    for (const p of eff.placements) {
      if (p.staffId !== state.id) continue;
      const depart = p.depart ?? p.arrive;
      if (m >= p.arrive && m < p.leaveDest) loc = p.to;
      else if ((m >= depart && m < p.arrive) || (m >= p.leaveDest && m < p.returnHome)) away = true;
    }
    if (away) continue;
    // 已被待确认（或进行中开通道）指令预占的员工不能再算作冗余人力
    const reserved = eff.reservations.find(
      (r) => r.staffId === state.id && m >= world.at && m <= r.deadline,
    );
    if (reserved) continue;
    if (loc === zone) present.push(state);
  }
  return present;
}

function onBreak(person, m) {
  return person.breaks.some((b) => b.start <= m && m < b.end);
}

function withinShift(person, m) {
  const end = Number.isFinite(person.shiftEnd) ? person.shiftEnd : Number.POSITIVE_INFINITY;
  return person.shiftStart <= m && m < end;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
