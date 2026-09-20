// 运行态：调配指令生命周期、有效能力推导、人工覆盖、幂等去重、崩溃恢复。
// 所有派生视图都从带时间戳的事件日志计算，因此可以在任意历史时刻重放。
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const toPath = (p) => (p instanceof URL ? fileURLToPath(p) : p);
import {
  MINUTE,
  ACK_DEADLINE_MIN,
  ARRIVE_SLACK_MIN,
  TTL_MAX_MIN,
  iso,
} from "./clock.js";

const STATUS = {
  DISPATCHED: "dispatched", // 经理已接受建议，指令已下达，等待员工到岗
  ACTIVE: "active", // 员工确认到岗，通道有效能力已改变
  REJECTED: "rejected", // 员工拒绝接单
  EXPIRED: "expired", // 员工未在时限内确认到岗
  WITHDRAWN: "withdrawn", // 经理中途撤回
  COMPLETED: "completed", // 到达时限正常结束
};

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class DecisionStore {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file ? toPath(file) : null;
    this._now = now;
    this.observations = []; // normalizeObservation 形状
    this.assignments = [];
    this.overrides = []; // {overrideId, lane, zone, action:'open'|'close', start, end, reason, createdAt, createdBy, revokedAt}
    this.idempotency = new Map(); // key -> assignmentId
    this._chain = Promise.resolve();
  }

  now() {
    return this._now();
  }

  // 串行化所有写操作：并发观测写入 / 接受建议 / 人工覆盖互不踩踏。
  async mutate(fn) {
    const run = this._chain.then(() => fn(this));
    this._chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async load() {
    this.file = this.file ? toPath(this.file) : null;
    if (!this.file || !existsSync(this.file)) return this;
    const raw = JSON.parse(await readFile(this.file, "utf8"));
    this.observations = raw.observations ?? [];
    this.assignments = raw.assignments ?? [];
    this.overrides = raw.overrides ?? [];
    this.idempotency = new Map(Object.entries(raw.idempotency ?? {}));
    return this;
  }

  async persist() {
    const file = this.file ? toPath(this.file) : null;
    if (!file) return;
    await mkdir(dirname(file), { recursive: true });
    const payload = {
      version: 1,
      savedAt: iso(this.now()),
      observations: this.observations,
      assignments: this.assignments,
      overrides: this.overrides,
      idempotency: Object.fromEntries(this.idempotency),
    };
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, file); // 原子替换，重启不会读到半写文件
  }

  // ---------- 观测 ----------
  addObservation(obs) {
    if (this.observations.some((r) => r.observationId === obs.observationId)) {
      return { duplicated: true, observationId: obs.observationId };
    }
    this.observations.push(obs);
    return { duplicated: false, observationId: obs.observationId };
  }

  // ---------- 指令 ----------
  // 幂等接受：同一 idempotencyKey / 同一未终结指令的自然键直接返回既有指令。
  acceptRecommendation(rec, { idempotencyKey, ttlMin, asOf = this.now() } = {}) {
    if (rec.type !== "OPEN_LANE" && rec.type !== "CROSS_ZONE_SUPPORT") {
      throw Object.assign(new Error("该建议类型不可下达为调配指令"), { code: "not_actionable" });
    }
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const existing = this.assignments.find((a) => a.assignmentId === this.idempotency.get(idempotencyKey));
      if (existing) return { assignment: existing, duplicated: true };
    }
    // 自然键去重：同一目标通道已有未终结指令时不重复派人/重复开通道。
    const live = this.assignments.find(
      (a) =>
        a.zone === rec.zone &&
        a.lane === rec.lane &&
        [STATUS.DISPATCHED, STATUS.ACTIVE].includes(this.statusAt(a, asOf))
    );
    if (live) return { assignment: live, duplicated: true, reason: "already_assigned" };

    const ttl = Math.min(Math.max(ttlMin ?? rec.ttlMin ?? 25, 5), TTL_MAX_MIN);
    const acceptedAt = asOf;
    const readyAt = Date.parse(rec.readyAt);
    const arrivalDeadline = readyAt + ARRIVE_SLACK_MIN * MINUTE;
    const assignment = {
      assignmentId: newId("asg"),
      type: rec.type,
      zone: rec.zone,
      lane: rec.lane,
      lanePpm: rec.lanePpm,
      donorLane: rec.fromZone ? rec.donorLane ?? null : null,
      donorPpm: rec.fromZone ? rec.donorPpm ?? null : null,
      staffId: rec.staffId,
      fromZone: rec.fromZone ?? null,
      walkMin: rec.walkMin ?? 0,
      departureAt: Date.parse(rec.acceptBefore),
      proposedAt: Date.parse(rec.asOf ?? iso(asOf)),
      acceptedAt,
      acceptBefore: Date.parse(rec.acceptBefore),
      readyAt,
      arrivalDeadline,
      expiresAt: acceptedAt + ttl * MINUTE,
      status: STATUS.DISPATCHED,
      events: [{ event: "dispatched", at: acceptedAt }],
      recommendation: strip(rec),
    };
    this.assignments.push(assignment);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, assignment.assignmentId);
    return { assignment, duplicated: false };
  }

  // 员工响应：reject 或 confirm-arrival。
  staffRespond(assignmentId, action, { at = this.now(), note } = {}) {
    const a = this.assignments.find((x) => x.assignmentId === assignmentId);
    if (!a) throw Object.assign(new Error("指令不存在"), { code: "not_found" });
    const status = this.statusAt(a, at);
    if (action === "reject") {
      if (status !== STATUS.DISPATCHED) {
        throw Object.assign(new Error(`当前状态 ${status} 不可拒绝`), { code: "illegal_transition" });
      }
      a.status = STATUS.REJECTED;
      a.events.push({ event: "rejected", at, note });
      return a;
    }
    if (action === "arrive") {
      if (status !== STATUS.DISPATCHED) {
        throw Object.assign(new Error(`当前状态 ${status}，无需到岗确认`), { code: "illegal_transition" });
      }
      if (at > a.arrivalDeadline) {
        a.status = STATUS.EXPIRED;
        a.events.push({ event: "expired", at, note: "到岗确认晚于时限" });
        throw Object.assign(new Error("已超过到岗确认时限，指令按超时关闭"), { code: "deadline_passed", assignment: a });
      }
      a.status = STATUS.ACTIVE;
      a.activeFrom = at;
      a.events.push({ event: "arrived", at });
      return a;
    }
    throw Object.assign(new Error(`未知员工动作 ${action}`), { code: "bad_action" });
  }

  // 经理中途撤回；仅已派发或进行中的指令可撤回。
  withdraw(assignmentId, { at = this.now(), reason } = {}) {
    const a = this.assignments.find((x) => x.assignmentId === assignmentId);
    if (!a) throw Object.assign(new Error("指令不存在"), { code: "not_found" });
    const status = this.statusAt(a, at);
    if (status !== STATUS.DISPATCHED && status !== STATUS.ACTIVE) {
      throw Object.assign(new Error(`当前状态 ${status} 不可撤回`), { code: "illegal_transition" });
    }
    a.status = STATUS.WITHDRAWN;
    a.withdrawnAt = at;
    a.events.push({ event: "withdrawn", at, reason });
    return a;
  }

  // 按时间线推导时刻 asOf 的状态（含超时自动失效）。不修改原记录。
  statusAt(a, asOf) {
    // 找到 asOf 之前最后一个终态/阶段事件。
    let phase = STATUS.DISPATCHED;
    for (const e of a.events) {
      if (e.at > asOf) break;
      if (e.event === "rejected") return STATUS.REJECTED;
      if (e.event === "withdrawn") return STATUS.WITHDRAWN;
      if (e.event === "expired") return STATUS.EXPIRED;
      if (e.event === "completed") return STATUS.COMPLETED;
      if (e.event === "arrived") phase = STATUS.ACTIVE;
    }
    // 即使超时事件尚未落账，按时间规则推导：未确认超时、到时限完成。
    if (phase === STATUS.ACTIVE) return a.expiresAt <= asOf ? STATUS.COMPLETED : STATUS.ACTIVE;
    return asOf > a.arrivalDeadline ? STATUS.EXPIRED : STATUS.DISPATCHED;
  }

  // 惰性超时落账：把 statusAt 推导出的超时写成事件（供审计与持久化）。
  sweepDeadlines(at = this.now()) {
    const changed = [];
    for (const a of this.assignments) {
      if (a.status === STATUS.DISPATCHED && at > a.arrivalDeadline) {
        a.status = STATUS.EXPIRED;
        a.events.push({ event: "expired", at: a.arrivalDeadline, note: "未在时限内确认到岗" });
        changed.push(a);
      }
      if (a.status === STATUS.ACTIVE && at >= a.expiresAt) {
        a.status = STATUS.COMPLETED;
        a.events.push({ event: "completed", at: a.expiresAt });
        changed.push(a);
      }
    }
    return changed;
  }

  // ---------- 人工覆盖 ----------
  addOverride({ lane, zone, action, start = this.now(), end, reason, createdBy = "manager" }) {
    if (!["open", "close"].includes(action)) throw new Error("action 必须是 open 或 close");
    if (!end || end <= start) throw new Error("人工覆盖必须给出晚于开始时间的结束时间（有时限）");
    const override = {
      overrideId: newId("ovr"),
      lane,
      zone,
      action,
      start,
      end,
      reason: reason ?? "人工覆盖",
      createdBy,
      createdAt: this.now(),
      revokedAt: null,
    };
    this.overrides.push(override);
    return override;
  }

  revokeOverride(overrideId, { at = this.now() } = {}) {
    const o = this.overrides.find((x) => x.overrideId === overrideId);
    if (!o) throw Object.assign(new Error("覆盖不存在"), { code: "not_found" });
    o.revokedAt = at;
    return o;
  }

  // ---------- 历史视图 ----------
  // 返回 asOf 时刻的“资源视图”：当时已接收观测、当时有效指令与覆盖推导出的能力。
  viewAt(asOf, context) {
    const observations = this.observations.filter((r) => r.receivedAt <= asOf);
    const overrides = this.overrides.filter((o) => o.createdAt <= asOf && !(o.revokedAt && o.revokedAt <= asOf));
    const assignments = this.assignments.filter((a) => a.acceptedAt <= asOf);

    const activeEffects = [];
    const commitments = [];
    for (const a of assignments) {
      const status = this.statusAt(a, asOf);
      if (status === STATUS.DISPATCHED) {
        // 已派人、未到岗：占住该员工，防止重复派人。
        commitments.push({ assignmentId: a.assignmentId, staffId: a.staffId, start: a.acceptedAt, end: a.arrivalDeadline });
        // 跨区支援者离岗步行：原岗位通道即刻关闭（拒绝/超时后状态翻转，自动恢复）。
        if (a.fromZone && a.donorLane) {
          activeEffects.push({
            assignmentId: a.assignmentId,
            kind: "close",
            lane: a.donorLane,
            zone: a.fromZone,
            from: a.acceptedAt,
            end: a.arrivalDeadline,
          });
        }
      }
      if (status === STATUS.ACTIVE) {
        const from = a.activeFrom;
        // 目标区：到岗后开启目标通道。
        activeEffects.push({ assignmentId: a.assignmentId, kind: "open", lane: a.lane, zone: a.zone, from, end: a.expiresAt });
        if (a.fromZone) {
          // 支援区原岗位通道在整个指令期间保持关闭，撤回/到期后恢复。
          activeEffects.push({
            assignmentId: a.assignmentId,
            kind: "close",
            lane: a.donorLane,
            zone: a.fromZone,
            from: a.acceptedAt,
            end: a.expiresAt,
          });
        }
        commitments.push({ assignmentId: a.assignmentId, staffId: a.staffId, start: a.acceptedAt, end: a.expiresAt });
      }
    }

    const laneState = (lane, t) => {
      let open = lane.baselineOpen;
      for (const o of overrides) {
        if (o.lane !== lane.lane || t < o.start || t >= o.end) continue;
        if (o.action === "open") open = true;
        if (o.action === "close") open = false;
      }
      for (const e of activeEffects) {
        if (e.lane !== lane.lane || t < e.from || t >= e.end) continue;
        if (e.kind === "open") open = true;
        if (e.kind === "close") open = false;
      }
      return open;
    };

    return {
      asOf,
      observations,
      commitments,
      laneOpenAt: (laneId, t) => {
        const lane = context.lanes.find((l) => l.lane === laneId);
        return lane ? laneState(lane, t) : false;
      },
      laneSource: (laneId, t) => {
        const lane = context.lanes.find((l) => l.lane === laneId);
        if (!lane) return "unknown";
        const e = activeEffects.find((x) => x.lane === laneId && x.zone === lane.zone && t >= x.from && t < x.end);
        if (e) return e.kind === "open" ? "assignment-open" : "assignment-close";
        const o = overrides.find((x) => x.lane === laneId && t >= x.start && t < x.end);
        if (o) return `manual-${o.action}`;
        return "baseline";
      },
      capacityAt: (zone, t) => {
        let cap = 0;
        for (const lane of context.lanes) {
          if (lane.zone === zone && laneState(lane, t)) cap += lane.ppm;
        }
        return cap;
      },
      describeAssignment: (a) => ({ ...a, statusNow: this.statusAt(a, asOf) }),
    };
  }

  listAssignments({ asOf = this.now() } = {}) {
    return this.assignments
      .filter((a) => a.acceptedAt <= asOf)
      .map((a) => ({
        assignmentId: a.assignmentId,
        type: a.type,
        zone: a.zone,
        lane: a.lane,
        staffId: a.staffId,
        fromZone: a.fromZone,
        acceptedAt: iso(a.acceptedAt),
        readyAt: iso(a.readyAt),
        arrivalDeadline: iso(a.arrivalDeadline),
        expiresAt: iso(a.expiresAt),
        activeFrom: a.activeFrom ? iso(a.activeFrom) : null,
        withdrawnAt: a.withdrawnAt ? iso(a.withdrawnAt) : null,
        status: this.statusAt(a, asOf),
        events: a.events.map((e) => ({ ...e, at: iso(e.at) })),
      }))
      .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
  }
}

function strip(rec) {
  // 建议入库时剥离评分临时字段，保留可审计内容。
  const { screenedOut, ...rest } = rec;
  return { ...rest, screenedOut };
}

export { STATUS, ACK_DEADLINE_MIN };
