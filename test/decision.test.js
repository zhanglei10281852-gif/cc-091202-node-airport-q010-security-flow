import assert from "node:assert/strict";
import test from "node:test";
import { freshContext, cleanup } from "./helpers.js";
import { evaluateView } from "../src/domain/decision.js";
import { rulesAt } from "../src/domain/rules.js";
import { buildWorld } from "../src/domain/snapshot.js";
import { toMs, isoCn } from "../src/domain/time.js";

const T = (s) => toMs(`2026-09-12T${s}+08:00`);

function evaluate(ctx, at = T("07:40:00")) {
  return evaluateView(ctx.store.viewAt(at), at, rulesAt(at));
}

test("高峰区产生跨区支援开通道建议，并量化改善与出借区代价", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));

  const result = evaluate(ctx);
  const rec = result.recommendation;
  assert.ok(rec, "应给出建议而不是维持现状");
  assert.equal(rec.action.type, "open_lane");
  assert.equal(rec.action.zone, "T1-EAST");
  assert.equal(rec.action.lane, "E-03");
  assert.equal(rec.action.fromZone, "T1-WEST");
  assert.ok(rec.action.walkMin >= 5, "应包含跨区步行时间");
  for (const staffId of rec.action.assignees) assert.match(staffId, /^s-w-/);

  // 预期等待改善必须显著且方向正确
  assert.ok(rec.expected.gainPassengerMinutes > 50, `改善量过小: ${rec.expected.gainPassengerMinutes}`);
  assert.ok(rec.expected.targetMaxWaitAfter < rec.expected.targetMaxWaitBefore);

  // 被牺牲区域必须显式列出
  const donor = rec.sacrificed.find((s) => s.zone === "T1-WEST");
  assert.ok(donor, "必须说明被牺牲区域");
  assert.ok(donor.maxWaitAfter <= 12, `出借区等待超保护阈值: ${donor.maxWaitAfter}`);

  // 建议自带时限与确认截止
  assert.ok(rec.validUntil > T("07:40:00"));
  assert.ok(rec.confirmDeadline >= T("07:40:00"));
});

test("建议所派员工岗位资质齐全", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const rec = evaluate(ctx).recommendation;
  const world = buildWorld(ctx.store.viewAt(T("07:40:00")), T("07:40:00"));
  for (const staffId of rec.action.assignees) {
    const person = world.staff.get(staffId).person;
    const idx = rec.action.assignees.indexOf(staffId);
    assert.ok(person.qualifications.has(rec.action.roles[idx]), `${staffId} 不具备 ${rec.action.roles[idx]}`);
  }
});

test("法定休息冲突的员工不会被自动建议派出", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));

  // s-w-screen-2 的休息是 08:00-08:15；把决策时刻挪到 07:55，
  // 此时派出会让其无法在休息开始前走回（7 分钟），必须被排除。
  await ctx.store.appendBatch(
    [
      {
        observationId: "obs-east-0754",
        zone: "T1-EAST",
        queue: 104,
        occurredAt: isoCn(T("07:54:00")),
        confidence: 0.9,
      },
    ],
    { receivedAt: T("07:54:00") },
  );
  const rec = evaluate(ctx, T("07:55:00")).recommendation;
  assert.ok(rec, "07:55 仍应有可行建议");
  assert.ok(!rec.action.assignees.includes("s-w-screen-2"), "休息冲突员工被派出");
});

test("被人工暂停自动建议的区域既不收建议也不作为出借区", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const result = evaluate(ctx);
  const north = result.zones.find((z) => z.zone === "T1-NORTH");
  assert.equal(north.recommendationSuppressed, true);
  const rec = result.recommendation;
  assert.notEqual(rec.action.fromZone, "T1-NORTH");
});

test("低峰且利用率低时建议收通道，且收后不造成拥堵", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  // 给西区补一条大幅下降后的观测：队列清空、无后续大波次
  await ctx.store.appendBatch(
    [
      {
        observationId: "obs-west-lull",
        zone: "T1-WEST",
        queue: 2,
        occurredAt: isoCn(T("09:50:00")),
        confidence: 0.95,
      },
    ],
    { receivedAt: T("09:50:00") },
  );
  const result = evaluate(ctx, T("09:50:00"));
  const closes = [result.recommendation, ...result.alternatives].filter(
    (c) => c && c.type === "close_lane",
  );
  assert.ok(closes.length > 0, "低谷应产生收通道候选且通过护栏");
  for (const c of closes) assert.deepEqual(c.blockedBy, []);
});

test("数据不足以支撑动作时维持现状并给出原因", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  // 在没有任何东区观测的极早时刻重放（波次尚未临近）
  const result = evaluate(ctx, T("06:30:00"));
  assert.equal(result.hold.chosen, true);
  assert.ok(result.hold.reason);
});

test("同一通道冷却期内不重复建议切换", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  // 预置一条 5 分钟前对 E-03 的开通道指令（已被撤回），冷却内应不再推荐 E-03
  await ctx.store.appendBatch(
    [
      {
        recordType: "command",
        commandId: "cmd-cooldown-case",
        managerId: "mgr-anon",
        issuedAt: T("07:35:00"),
        confirmDeadline: T("07:42:00"),
        validUntil: T("08:30:00"),
        basedOn: { recommendationId: "x", rulesVersion: "rules-2026-09" },
        action: {
          type: "open_lane",
          zone: "T1-EAST",
          lane: "E-03",
          roles: ["XRAY"],
          assignees: ["s-w-xray-1"],
          fromZone: "T1-WEST",
          walkMin: 7,
        },
      },
    ],
    { receivedAt: T("07:35:00") },
  );
  const result = evaluate(ctx);
  const opensE03 = [result.recommendation, ...result.alternatives, ...result.rejectedCandidates].filter(
    (c) => c?.action?.lane === "E-03" || c?.lane === "E-03",
  );
  assert.equal(opensE03.length, 0, "冷却期内不应再出现 E-03 建议");
});
