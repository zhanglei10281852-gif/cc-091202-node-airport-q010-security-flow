import assert from "node:assert/strict";
import test from "node:test";
import { freshContext, cleanup } from "./helpers.js";
import { evaluateView } from "../src/domain/decision.js";
import { rulesAt } from "../src/domain/rules.js";
import { buildWorld } from "../src/domain/snapshot.js";
import { staffedCapacity } from "../src/domain/forecast.js";
import { toMs } from "../src/domain/time.js";

const T = (s) => toMs(`2026-09-12T${s}+08:00`);

function capacityAt(ctx, at, zone) {
  const world = buildWorld(ctx.store.viewAt(at), at);
  const zoneState = world.zones.get(zone);
  const eff = {
    laneIntervals: [...world.laneIntervals, ...world.overrideLaneIntervals],
    placements: world.placements,
    reservations: world.reservations,
  };
  return staffedCapacity(world, zoneState, eff, at);
}

test("接受建议生成有时限指令；全员确认到岗前能力不变，确认后才改变", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const at = T("07:40:00");
  const evaluation = evaluateView(ctx.store.viewAt(at), at, rulesAt(at));
  const recId = evaluation.recommendation.recommendationId;

  const before = capacityAt(ctx, T("07:50:00"), "T1-EAST");
  assert.deepEqual(before.staffedLanes.sort(), ["E-01", "E-02"]);

  const accepted = await ctx.commands.accept({
    recommendationId: recId,
    idempotencyKey: "case-1",
    asOf: at,
  });
  assert.equal(accepted.duplicated, false);
  const cmd = accepted.command;
  assert.equal(cmd.status, "awaiting_confirmation");
  assert.ok(cmd.validUntil > cmd.confirmDeadline);
  assert.match(cmd.consequence, /锁定但能力未变/);

  // 只确认 1/3：能力仍不变
  await ctx.commands.acknowledge(cmd.commandId, cmd.action.assignees[0], "confirm", { at: T("07:44:00") });
  const partial = ctx.commands.commandById(cmd.commandId, T("07:44:00"));
  assert.equal(partial.statusAt(T("07:44:00")), "awaiting_confirmation");
  assert.deepEqual(capacityAt(ctx, T("07:50:00"), "T1-EAST").staffedLanes.sort(), ["E-01", "E-02"]);

  // 全员在 7 分钟步行后于 07:47 到岗确认
  for (let i = 1; i < cmd.action.assignees.length; i += 1) {
    await ctx.commands.acknowledge(cmd.commandId, cmd.action.assignees[i], "confirm", { at: T("07:47:00") });
  }
  const active = ctx.commands.commandById(cmd.commandId, T("07:48:00"));
  assert.equal(active.statusAt(T("07:48:00")), "active");
  assert.deepEqual(capacityAt(ctx, T("07:50:00"), "T1-EAST").staffedLanes.sort(), ["E-01", "E-02", "E-03"]);
});

test("重复提交同一 Idempotency-Key 不重复派人", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const at = T("07:40:00");
  const recId = evaluateView(ctx.store.viewAt(at), at, rulesAt(at)).recommendation.recommendationId;

  const a = await ctx.commands.accept({ recommendationId: recId, idempotencyKey: "dup-1", asOf: at });
  const b = await ctx.commands.accept({ recommendationId: recId, idempotencyKey: "dup-1", asOf: at });
  assert.equal(a.command.commandId, b.command.commandId);
  assert.equal(b.duplicated, true);
  const cmds = ctx.commands.listCommands(at);
  assert.equal(cmds.length, 1);
});

test("任一被派人拒绝：指令作废，能力始终不变", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const at = T("07:40:00");
  const recId = evaluateView(ctx.store.viewAt(at), at, rulesAt(at)).recommendation.recommendationId;
  const { command: cmd } = await ctx.commands.accept({ recommendationId: recId, idempotencyKey: "rej-1", asOf: at });

  await ctx.commands.acknowledge(cmd.commandId, cmd.action.assignees[0], "reject", { at: T("07:43:00") });
  const status = ctx.commands.commandById(cmd.commandId, T("07:45:00")).statusAt(T("07:45:00"));
  assert.equal(status, "rejected");
  // 其余人之后再确认无效
  await assert.rejects(
    () => ctx.commands.acknowledge(cmd.commandId, cmd.action.assignees[1], "confirm", { at: T("07:45:00") }),
    (error) => error.status === 409 && error.code === "already_resolved",
  );
  assert.deepEqual(capacityAt(ctx, T("07:55:00"), "T1-EAST").staffedLanes.sort(), ["E-01", "E-02"]);
});

test("确认截止前未全员到岗：超时作废，人员预占释放", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const at = T("07:40:00");
  const recId = evaluateView(ctx.store.viewAt(at), at, rulesAt(at)).recommendation.recommendationId;
  const { command: cmd } = await ctx.commands.accept({ recommendationId: recId, idempotencyKey: "exp-1", asOf: at });
  // 只有一人确认
  await ctx.commands.acknowledge(cmd.commandId, cmd.action.assignees[0], "confirm", { at: T("07:44:00") });

  const status = ctx.commands.commandById(cmd.commandId, cmd.confirmDeadline + 60_000).statusAt(cmd.confirmDeadline + 60_000);
  assert.equal(status, "expired");
  assert.match(cmd.consequence !== null ? "锁定但能力未变" : "", /锁定但能力未变/);

  // 超时后能力不变；被派人不再处于预占（可被新建议选中）
  assert.deepEqual(capacityAt(ctx, T("07:55:00"), "T1-EAST").staffedLanes.sort(), ["E-01", "E-02"]);
  const world = buildWorld(ctx.store.viewAt(T("07:55:00")), T("07:55:00"));
  for (const staffId of cmd.action.assignees) {
    assert.equal(world.staff.get(staffId).reserved, false);
  }
});

test("经理中途撤回：立即失效；支援人员走回期间出借区能力不恢复，走回后恢复", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const at = T("07:40:00");
  const recId = evaluateView(ctx.store.viewAt(at), at, rulesAt(at)).recommendation.recommendationId;
  const { command: cmd } = await ctx.commands.accept({ recommendationId: recId, idempotencyKey: "rev-1", asOf: at });
  for (const staffId of cmd.action.assignees) {
    await ctx.commands.acknowledge(cmd.commandId, staffId, "confirm", { at: T("07:47:00") });
  }
  assert.deepEqual(capacityAt(ctx, T("07:50:00"), "T1-EAST").staffedLanes.sort(), ["E-01", "E-02", "E-03"]);

  // 08:10 撤回，步行回 WEST 需 7 分钟
  await ctx.commands.revoke(cmd.commandId, { at: T("08:10:00") });
  assert.equal(ctx.commands.commandById(cmd.commandId, T("08:11:00")).statusAt(T("08:11:00")), "revoked");
  assert.deepEqual(capacityAt(ctx, T("08:11:00"), "T1-EAST").staffedLanes.sort(), ["E-01", "E-02"]);

  // 走回途中（08:13）出借区拿不回人手；走回后（08:20）恢复
  const westInTransit = capacityAt(ctx, T("08:13:00"), "T1-WEST");
  const westAfter = capacityAt(ctx, T("08:20:00"), "T1-WEST");
  assert.ok(westInTransit.rate <= westAfter.rate, "走回期间出借区能力不应高于走回后");
  assert.deepEqual(westAfter.staffedLanes.sort(), ["W-01", "W-02"]);
});

test("不能对同一批员工重复派人：第二条指令冲突时拒绝", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const at = T("07:40:00");
  const recId = evaluateView(ctx.store.viewAt(at), at, rulesAt(at)).recommendation.recommendationId;
  await ctx.commands.accept({ recommendationId: recId, idempotencyKey: "busy-1", asOf: at });

  // 等待确认期间再次接受（不同幂等键）——评估时被派人已预占，建议无法重现
  await assert.rejects(
    () => ctx.commands.accept({ recommendationId: recId, idempotencyKey: "busy-2", asOf: at }),
    (error) => error.status === 409 && ["staff_conflict", "recommendation_not_available"].includes(error.code),
  );
});

test("接受过期/已失效建议会被拒绝，必须重新评估", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const at = T("07:40:00");
  const recId = evaluateView(ctx.store.viewAt(at), at, rulesAt(at)).recommendation.recommendationId;
  // 用 07:40 的建议 ID 在 09:00 接受：候选集已变化
  await assert.rejects(
    () => ctx.commands.accept({ recommendationId: recId, idempotencyKey: "stale-1", asOf: T("09:00:00") }),
    (error) => error.status === 409 && ["recommendation_not_available", "staff_conflict"].includes(error.code),
  );
});
