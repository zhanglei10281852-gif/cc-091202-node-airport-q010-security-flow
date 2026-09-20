// 指令服务：经理“接受建议”后生成有时限的调配指令。
// 防重复派人三道闸：
//  1) 接受时校验候选人当前未被任何未结束指令占用；
//  2) Idempotency-Key 保证重复提交（网络重试/进程重启）只生成一条指令；
//  3) 指令记录只追加，确认/拒绝/撤回都以 commandEvent 追加，状态由日志确定性重建。
import { MINUTE_MS } from "./time.js";
import { buildWorld, hydrateCommand } from "./snapshot.js";
import { evaluateView } from "./decision.js";
import { rulesAt } from "./rules.js";
import { HttpError } from "./store.js";

let idCounter = 0;
function newId(prefix, clock) {
  idCounter = (idCounter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${new Date(clock.now()).toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${idCounter}${rand}`;
}

export class CommandService {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
  }

  // 依据某条建议在“接受时刻”重新评估后再签发，避免接受过期建议。
  async accept({ recommendationId, idempotencyKey, asOf, validMinutes, managerId }) {
    if (!idempotencyKey) throw new HttpError(400, "missing_idempotency_key", "接受建议必须携带 Idempotency-Key");
    const now = asOf ?? this.clock.now();

    return this.store.withLock(async () => {
      const existing = this.store.findIdempotent(idempotencyKey);
      if (existing) {
        const command = this.commandById(existing, now);
        return { duplicated: true, command: serializeCommand(command, now) };
      }

      const rules = rulesAt(now);
      const view = this.store.viewAt(now);
      const evaluation = evaluateView(view, now, rules);
      const all = [evaluation.recommendation, ...evaluation.alternatives].filter(Boolean);
      const chosen = all.find((c) => c.recommendationId === recommendationId);
      if (!chosen) {
        throw new HttpError(
          409,
          "recommendation_not_available",
          `建议 ${recommendationId} 在当前时刻已不可接受（数据或规则已变化），请重新评估`,
        );
      }
      if (!chosen.passes) throw new HttpError(409, "recommendation_blocked", chosen.blockedBy.join("; "));

      const world = buildWorld(view, now);
      const blockers = assignmentConflicts(world, chosen.action);
      if (blockers.length > 0) {
        throw new HttpError(409, "staff_conflict", blockers.join("; "));
      }

      const commandId = newId("cmd", this.clock);
      const confirmDeadline = chosen.confirmDeadline ?? now + (rules.localMusterMin + rules.walkGraceMin) * MINUTE_MS;
      let validUntil = chosen.validUntil ?? now + rules.maxCommandMin * MINUTE_MS;
      if (validMinutes !== undefined) {
        const capped = Math.min(Number(validMinutes), rules.maxCommandMin);
        validUntil = now + capped * MINUTE_MS;
      }
      if (validUntil <= confirmDeadline) {
        throw new HttpError(422, "invalid_window", "指令有效结束时间必须晚于确认截止时间");
      }

      const record = {
        recordType: "command",
        commandId,
        idempotencyKey,
        managerId: managerId ?? "mgr-anon",
        issuedAt: now,
        confirmDeadline,
        validUntil,
        basedOn: {
          recommendationId: chosen.recommendationId,
          rulesVersion: rules.version,
          dataTrust: chosen.dataTrust,
        },
        action: chosen.action,
      };
      await this.store.appendBatchLocked([{ recordType: "command", ...record }], now);
      return { duplicated: false, command: serializeCommand(hydrateOne(this.store, record, now), now) };
    });
  }

  // 员工确认到岗：只有全部被派人确认后，有效能力才改变（由 snapshot 重建体现）。
  async acknowledge(commandId, staffId, event, { at } = {}) {
    if (!["confirm", "reject"].includes(event)) throw new HttpError(400, "bad_event", "event 只能是 confirm 或 reject");
    const now = at ?? this.clock.now();
    return this.store.withLock(async () => {
      const record = this.requireCommandRecord(commandId);
      const command = hydrateOne(this.store, record, now);
      const status = command.statusAt(now);

      if (event === "reject") {
        if (command.rejectedAt !== null) throw new HttpError(409, "already_resolved", "指令已被拒绝");
        if (!record.action.assignees.includes(staffId)) {
          throw new HttpError(404, "not_assignee", `${staffId} 不在该指令的被派名单中`);
        }
        if (status === "active" || status === "completed") {
          throw new HttpError(409, "already_active", "指令已全员到岗生效，拒绝无效，请走撤回流程");
        }
      } else {
        if (!record.action.assignees.includes(staffId)) {
          throw new HttpError(404, "not_assignee", `${staffId} 不在该指令的被派名单中`);
        }
        if (command.acks.has(staffId)) {
          return { duplicated: true, command: serializeCommand(command, now) };
        }
        if (status === "rejected") throw new HttpError(409, "already_resolved", "指令已被拒绝，确认无效");
        if (status === "revoked") throw new HttpError(409, "already_revoked", "指令已被撤回，确认无效");
        if (status === "expired") throw new HttpError(410, "confirm_window_closed", "确认截止已过");
        if (status === "completed") throw new HttpError(409, "already_completed", "指令已结束");
      }

      const eventRecord = {
        recordType: "commandEvent",
        eventId: `evt-${commandId}-${event}-${staffId}-${now}`,
        commandId,
        staffId,
        event,
        at: now,
      };
      await this.store.appendBatchLocked([eventRecord], now);
      return { duplicated: false, command: serializeCommand(this.commandById(commandId, now), now) };
    });
  }

  // 经理中途撤回；进行中的支援撤回后员工需走回，走回期间出借区能力不恢复。
  async revoke(commandId, { at, reason } = {}) {
    const now = at ?? this.clock.now();
    return this.store.withLock(async () => {
      const record = this.requireCommandRecord(commandId);
      const command = hydrateOne(this.store, record, now);
      const status = command.statusAt(now);
      if (status === "rejected" || status === "revoked" || status === "completed") {
        throw new HttpError(409, "not_revocable", `指令当前状态 ${status}，不可撤回`);
      }
      const eventRecord = {
        recordType: "commandEvent",
        eventId: `evt-${commandId}-revoke-${now}`,
        commandId,
        event: "revoke",
        at: now,
        reason: reason ?? null,
      };
      await this.store.appendBatchLocked([eventRecord], now);
      return { command: serializeCommand(this.commandById(commandId, now), now) };
    });
  }

  listCommands(asOf = this.clock.now()) {
    const view = this.store.viewAt(asOf);
    return view
      .byKind("command")
      .map((record) => serializeCommand(hydrateOne(this.store, record, asOf), asOf));
  }

  requireCommandRecord(commandId) {
    const now = this.clock.now();
    const record = this.store
      .viewAt(now)
      .byKind("command")
      .find((c) => c.commandId === commandId);
    if (!record) throw new HttpError(404, "command_not_found", `指令 ${commandId} 不存在`);
    return record;
  }

  commandById(commandId, asOf) {
    const record = this.store
      .viewAt(asOf)
      .byKind("command")
      .find((c) => c.commandId === commandId);
    return hydrateOne(this.store, record, asOf);
  }
}

function assignmentConflicts(world, action) {
  const blockers = [];
  action.assignees.forEach((staffId, index) => {
    const state = world.staff.get(staffId);
    if (!state) {
      blockers.push(`${staffId}: 不在册`);
      return;
    }
    if (state.reserved) blockers.push(`${staffId}: 已被指令 ${state.reservedBy} 预占，不能重复派人`);
    if (state.placed) blockers.push(`${staffId}: 已在跨区支援中`);
    if (state.inTransit) blockers.push(`${staffId}: 正在步行换岗途中`);
    if (state.onBreak) blockers.push(`${staffId}: 法定/排班休息中，不得派岗`);
    if (!state.onShift) blockers.push(`${staffId}: 不在班`);
    // assignees 与 roles 同序一一对应；无 roles 明细时不做角色级校验（候选阶段已保证）。
    const role = Array.isArray(action.roles) ? action.roles[index] : null;
    if (role && !state.person.qualifications.has(role)) {
      blockers.push(`${staffId}: 岗位资质不足（需 ${role}）`);
    }
  });
  return blockers;
}

function hydrateOne(store, record, asOf) {
  if (!record) return null;
  const events = store
    .viewAt(asOf)
    .byKind("commandEvent")
    .filter((e) => e.commandId === record.commandId);
  return hydrateCommand(record, events);
}

export function serializeCommand(command, asOf) {
  if (!command) return null;
  const status = command.statusAt(asOf);
  return {
    commandId: command.commandId,
    managerId: command.managerId,
    issuedAt: command.issuedAt,
    confirmDeadline: command.confirmDeadline,
    validUntil: command.validUntil,
    status,
    action: command.action,
    basedOn: command.basedOn ?? null,
    effectiveStart: status === "active" || status === "completed" || status === "revoked" ? command.effectiveStart : null,
    acknowledged: [...command.acks.keys()],
    rejectedBy: command.rejectedBy,
    revokedAt: command.revokedAt,
    consequence: consequence(status),
  };
}

function consequence(status) {
  switch (status) {
    case "awaiting_confirmation":
      return "被派人已锁定但能力未变；全员按时确认后才改变有效能力";
    case "active":
      return "全员到岗，有效能力已按指令改变";
    case "rejected":
      return "任一被派人拒绝，指令作废，能力不变，建议重新评估";
    case "expired":
      return "确认截止前未全员到岗，指令作废，能力不变";
    case "revoked":
      return "经理中途撤回：通道恢复基线；支援人员走回后出借区恢复能力";
    case "completed":
      return "时限到期，指令结束";
    default:
      return null;
  }
}
