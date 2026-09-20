// 从只追加日志重建任意时刻 t 的世界状态。
// 关键约定：所有“有效区间”都由时间戳确定性算出，不依赖后台定时器，
// 因此重放历史时刻与实时查询走同一套代码。
import { toMs, MINUTE_MS } from "./time.js";

export function buildWorld(view, t) {
  const zones = new Map(); // zone -> state
  const lanes = [];
  const staff = new Map();
  const walk = new Map(); // from>to -> minutes（对称取最短）

  for (const record of view.byKind("lane")) {
    lanes.push(normalizeLane(record));
  }
  for (const record of view.byKind("staff")) {
    staff.set(record.staffId, normalizeStaff(record));
  }
  for (const record of view.byKind("walkTime")) {
    walk.set(`${record.fromZone}>${record.toZone}`, Number(record.minutes));
  }

  // 观测 + 更正：更正只替换目标观测的值，目标与更正都必须在视图内可见。
  const observations = new Map(); // observationId -> merged
  const corrections = [];
  for (const record of view.byKind("observation")) {
    observations.set(record.observationId, { ...record });
  }
  for (const record of view.byKind("correction")) {
    corrections.push(record);
    const target = observations.get(record.corrects);
    if (target) {
      target.queue = record.queue;
      target.confidence = record.confidence ?? target.confidence;
      target.correctedBy = record.observationId;
      target.correctedAt = toMs(record.receivedAt);
      target.correctionLagMin = Math.round((toMs(record.receivedAt) - toMs(target.occurredAt)) / MINUTE_MS);
    }
  }

  const commands = view.byKind("command").map((record) =>
    hydrateCommand(record, view.byKind("commandEvent").filter((e) => e.commandId === record.commandId)),
  );

  const overrides = view.byKind("override");
  const waves = view.byKind("flightWave").map((record) => ({ ...record }));

  for (const lane of lanes) {
    if (!zones.has(lane.zone)) zones.set(lane.zone, blankZone(lane.zone));
    zones.get(lane.zone).lanes.push(lane);
  }

  const placements = []; // 已生效跨区支援的完整往返区间
  const reservations = []; // 已派出待确认 {staffId, commandId, from, to, deadline}
  const laneIntervals = []; // 通道开关有效区间 {lane, open, start, end}
  for (const command of commands) {
    collectEffects(command, t, { placements, reservations, laneIntervals });
  }

  for (const [, person] of staff) {
    if (!zones.has(person.homeZone)) zones.set(person.homeZone, blankZone(person.homeZone));
  }

  // 只有观测/波次却没有通道资料的区域也要出现，便于暴露配置缺失。
  for (const record of [...observations.values(), ...waves, ...overrides]) {
    const zone = record.zone;
    if (zone && !zones.has(zone)) zones.set(zone, blankZone(zone));
  }

  for (const zone of zones.values()) {
    zone.lanes.sort((a, b) => a.lane.localeCompare(b.lane));
    for (const lane of zone.lanes) {
      lane.effectiveOpen = isLaneOpen(lane, laneIntervals, t);
    }
  }

  // 员工定位与可用性
  const staffState = new Map();
  for (const [id, person] of staff) {
    const reservation = reservations.find((r) => r.staffId === id && t <= r.deadline) ?? null;
    const placement = placements.find((p) => p.arrive <= t && t < p.returnHome) ?? null;
    const atDest = placement ? t < placement.leaveDest : false;
    const onShift = toMs(person.shiftStart) <= t && t < toMs(person.shiftEnd);
    const onBreak = person.breaks.some((b) => b.start <= t && t < b.end);
    let location = person.homeZone;
    if (placement) location = atDest ? placement.to : "IN_TRANSIT";
    staffState.set(id, {
      id,
      person,
      location,
      onShift,
      onBreak,
      placed: Boolean(placement) && atDest,
      inTransit: Boolean(placement) && !atDest,
      reserved: Boolean(reservation),
      reservedBy: reservation?.commandId ?? null,
    });
  }

  // 人工覆盖：强制通道开关、员工暂不可派、暂停某区自动建议。
  // 覆盖也带双时态（at + 可见性），重放时同样生效，且不产生自动指令。
  const overrideLaneIntervals = [];
  const unavailableStaff = new Set();
  const suppressedZones = new Set();
  for (const ov of overrides) {
    const start = toMs(ov.at ?? ov.issuedAt);
    const until = toMs(ov.until);
    if (start > t || until <= t) continue;
    if (ov.type === "force_lane_open" || ov.type === "force_lane_closed") {
      overrideLaneIntervals.push({
        lane: ov.lane,
        commandId: `override:${ov.overrideId}`,
        open: ov.type === "force_lane_open",
        start,
        end: until,
      });
    }
    if (ov.type === "staff_unavailable" && ov.staffId) unavailableStaff.add(ov.staffId);
    if (ov.type === "suppress_recommendation" && ov.zone) suppressedZones.add(ov.zone);
  }

  return {
    at: t,
    zones,
    lanes,
    staff: staffState,
    walk,
    observations,
    corrections,
    commands,
    overrides,
    waves,
    laneIntervals,
    overrideLaneIntervals,
    unavailableStaff,
    suppressedZones,
    placements,
    reservations,
    walkMinutes(from, to) {
      if (from === to) return 0;
      const direct = walk.get(`${from}>${to}`);
      if (direct !== undefined) return direct;
      const reverse = walk.get(`${to}>${from}`);
      return reverse ?? null;
    },
  };
}

function blankZone(zone) {
  return { zone, lanes: [] };
}

function normalizeLane(record) {
  return {
    lane: record.lane,
    zone: record.zone,
    rate: Number(record.passengersPerMinute),
    baselineOpen: record.open !== false,
    crewRoles: record.crewRoles ?? ["XRAY", "SCREEN", "ASSIST"],
  };
}

function normalizeStaff(record) {
  return {
    staffId: record.staffId,
    homeZone: record.homeZone,
    qualifications: new Set(record.qualifications ?? []),
    shiftStart: toMs(record.shiftStart ?? record.availableAt),
    shiftEnd: toMs(record.shiftEnd),
    breaks: (record.breaks ?? []).map((b) => ({ start: toMs(b.start), end: toMs(b.end) })),
  };
}

// 指令状态机：issued -> confirmed（全员到岗）/ rejected / expired / revoked / completed
export function hydrateCommand(record, events) {
  const acks = new Map(); // staffId -> at
  let rejectedAt = null;
  let rejectedBy = null;
  let revokedAt = null;
  for (const event of [...events].sort((a, b) => toMs(a.at) - toMs(b.at))) {
    if (event.event === "confirm") acks.set(event.staffId, toMs(event.at));
    if (event.event === "reject") {
      rejectedAt = toMs(event.at);
      rejectedBy = event.staffId ?? null;
    }
    if (event.event === "revoke") revokedAt = toMs(event.at);
  }
  const issuedAt = toMs(record.issuedAt);
  const confirmDeadline = toMs(record.confirmDeadline);
  const validUntil = toMs(record.validUntil);
  const needsAck = record.action.assignees.length > 0;

  let base = "issued"; // issued | confirmed | rejected
  let effectiveStart = null;
  if (rejectedAt !== null) {
    base = "rejected";
  } else if (needsAck) {
    const all = record.action.assignees.every((id) => acks.has(id));
    const lastAck = all ? Math.max(...record.action.assignees.map((id) => acks.get(id))) : null;
    if (all && lastAck <= confirmDeadline) {
      base = "confirmed";
      effectiveStart = lastAck;
    }
  } else {
    // 无需到岗确认的指令（收通道）签发即生效
    base = "confirmed";
    effectiveStart = issuedAt;
  }

  return {
    ...record,
    issuedAt,
    confirmDeadline,
    validUntil,
    acks,
    rejectedAt,
    rejectedBy,
    revokedAt,
    effectiveStart,
    statusAt(now) {
      if (base === "rejected" && rejectedAt <= now) return "rejected";
      if (base === "confirmed") {
        if (revokedAt !== null && revokedAt <= now) return "revoked";
        if (effectiveStart > now) return "confirmed"; // 已确认但到岗时刻在未来
        if (validUntil <= now) return "completed";
        return "active";
      }
      // 尚未全员确认
      if (revokedAt !== null && revokedAt <= now) return "revoked";
      if (now > confirmDeadline) return "expired";
      return "awaiting_confirmation";
    },
  };
}

function collectEffects(command, t, out) {
  const status = command.statusAt(t);
  const action = command.action;

  if (action.type === "close_lane" || action.type === "open_lane_idle") {
    const open = action.type === "open_lane_idle";
    if (status === "active" || status === "confirmed") {
      out.laneIntervals.push({
        lane: action.lane,
        commandId: command.commandId,
        open,
        start: command.effectiveStart ?? command.issuedAt,
        end: command.revokedAt ?? command.validUntil,
      });
    }
    return;
  }

  if (action.type !== "cross_zone_support" && action.type !== "open_lane") return;

  // 待确认期间锁定被派人员，防止系统对同一人重复派人
  if (status === "awaiting_confirmation") {
    for (const staffId of action.assignees) {
      out.reservations.push({
        staffId,
        commandId: command.commandId,
        from: action.fromZone ?? null,
        to: action.zone,
        deadline: command.confirmDeadline,
      });
    }
    return;
  }

  if (status !== "active") return;

  const leaveDest = command.revokedAt ?? command.validUntil;

  if (action.type === "open_lane") {
    out.laneIntervals.push({
      lane: action.lane,
      commandId: command.commandId,
      open: true,
      start: command.effectiveStart,
      end: leaveDest,
    });
    // 员工已在目的地（由下面的 placement 表达），不再需要预占排除；
    // 否则 staffedCapacity 会把他们当成不可用，通道永远缺岗。
  }

  // cross_zone_support：到岗起在受益区提供能力；撤回/到期后需走回，
  // 走回期间出借区仍拿不回这部分人手。
  for (const staffId of action.assignees) {
    out.placements.push({
      staffId,
      commandId: command.commandId,
      from: action.fromZone,
      to: action.zone,
      // 确认即到岗（步行时间已计入确认窗口），撤回后走回时长由动作携带。
      arrive: command.effectiveStart,
      leaveDest,
      returnHome: leaveDest + (action.walkBackMin ?? 0) * 60_000,
    });
  }
}

function isLaneOpen(lane, intervals, t) {
  const covering = intervals
    .filter((i) => i.lane === lane.lane && i.start <= t && t < i.end)
    .sort((a, b) => b.start - a.start);
  if (covering.length > 0) return covering[0].open;
  return lane.baselineOpen;
}
