import assert from "node:assert/strict";
import test from "node:test";
import { freshContext, cleanup } from "./helpers.js";
import { replayDecision, compareOutcomes } from "../src/domain/replay.js";
import { buildWorld } from "../src/domain/snapshot.js";
import { toMs } from "../src/domain/time.js";

const T = (s) => toMs(`2026-09-12T${s}+08:00`);

test("重放任意历史时刻：只可见当时已接收记录，并使用当时规则版本", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));

  const replay = replayDecision(ctx.store, T("07:25:00"));
  assert.equal(replay.rulesVersion, "rules-2026-09");
  const east = replay.evaluation.zones.find((z) => z.zone === "T1-EAST");
  assert.equal(east.dataQuality.latest.queue, 86);
  assert.equal(east.dataQuality.latest.correctedBy, null);

  // 08:40 后规则版本切换
  const later = replayDecision(ctx.store, T("08:45:00"));
  assert.equal(later.rulesVersion, "rules-2026-10");
});

test("对比建议预测与实际等待，并列出决策后才到的迟到记录", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));

  // 在 07:25 做决策；obs-41-r1 在 07:31 才到，应出现在 lateArrivals
  const report = compareOutcomes(ctx.store, T("07:25:00"), T("07:45:00"));
  const late = report.lateArrivals.find((l) => l.key === "obs:obs-41-r1");
  assert.ok(late, "07:31 的迟到更正必须被列为后到信息");
  assert.equal(late.lagMin, 11);

  const east = report.zones.find((z) => z.zone === "T1-EAST");
  assert.ok(east.predictedAtDecision.maxWaitMin !== null);
  assert.ok(east.realized.samples >= 0);
  assert.ok(east.realized.maxImpliedWaitMin === null || east.realized.maxImpliedWaitMin >= 0);
});

test("事后重放同一时刻结果确定性一致", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const a = JSON.stringify(replayDecision(ctx.store, T("07:20:00")).evaluation);
  const b = JSON.stringify(replayDecision(ctx.store, T("07:20:00")).evaluation);
  assert.equal(a, b);
});

test("规则版本切换不改变切换前时刻的重放结论", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  // 追加一条 09:00 的新观测，再重放 07:40：当时结论不应受未来数据影响
  await ctx.store.appendBatch(
    [
      {
        observationId: "obs-east-future",
        zone: "T1-EAST",
        queue: 5,
        occurredAt: "2026-09-12T09:00:00+08:00",
        confidence: 0.99,
      },
    ],
    { receivedAt: T("09:00:30") },
  );
  const replay = replayDecision(ctx.store, T("07:40:00"));
  const ids = replay.evaluation.zones
    .find((z) => z.zone === "T1-EAST")
    .dataQuality.visibleSamples;
  const worldNow = buildWorld(ctx.store.viewAt(T("09:01:00")), T("09:01:00"));
  const totalEast = [...worldNow.observations.values()].filter((o) => o.zone === "T1-EAST").length;
  assert.ok(ids < totalEast, "重放不应看到决策之后才接收的观测");
});
