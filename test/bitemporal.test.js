import assert from "node:assert/strict";
import test from "node:test";
import { freshContext, cleanup, T_0740 } from "./helpers.js";
import { evaluateView } from "../src/domain/decision.js";
import { rulesAt } from "../src/domain/rules.js";
import { assessDataQuality } from "../src/domain/data-quality.js";
import { buildWorld } from "../src/domain/snapshot.js";
import { toMs } from "../src/domain/time.js";

const T = (s) => toMs(`2026-09-12T${s}+08:00`);

test("迟到更正在接收前不可见：07:25 看到的是 86，不是 72", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));

  const at0725 = T("07:25:00");
  const view0725 = ctx.store.viewAt(at0725);
  const world0725 = buildWorld(view0725, at0725);
  const q0725 = assessDataQuality(world0725, rulesAt(at0725)).get("T1-EAST");
  assert.equal(q0725.latest.queue, 86);
  assert.equal(q0725.latest.correctedBy, null);

  // 同一次决策重放，结果必须稳定且不泄漏未来更正
  const replay = evaluateView(view0725, at0725, rulesAt(at0725));
  const east = replay.zones.find((z) => z.zone === "T1-EAST");
  assert.equal(east.dataQuality.latest.queue, 86);

  // 07:31 更正到达后，后续时刻看到 72 并带迟到更正标记
  const at0735 = T("07:35:00");
  const world0735 = buildWorld(ctx.store.viewAt(at0735), at0735);
  const q0735 = assessDataQuality(world0735, rulesAt(at0735)).get("T1-EAST");
  assert.equal(q0735.latest.queue, 72);
  assert.equal(q0735.latest.correctedBy, "obs-41-r1");
  assert.ok(q0735.flags.includes("late_correction"));
});

test("数据可信度：低置信度、陈旧、缺口分别打标", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));

  // 07:10:40 西区只有一条 confidence=0.42 的观测
  const w1 = buildWorld(ctx.store.viewAt(T("07:10:40")), T("07:10:40"));
  const q1 = assessDataQuality(w1, rulesAt(T("07:10:40"))).get("T1-WEST");
  assert.ok(q1.flags.includes("low_confidence"));
  assert.equal(q1.trustLevel, "medium");

  // 07:29 东区最新观测 9 分钟前 → stale
  const w2 = buildWorld(ctx.store.viewAt(T("07:29:00")), T("07:29:00"));
  const q2 = assessDataQuality(w2, rulesAt(T("07:29:00"))).get("T1-EAST");
  assert.ok(q2.flags.includes("stale"));

  // 08:00 东区最新观测 20 分钟前 → gap，可信度低
  const w3 = buildWorld(ctx.store.viewAt(T("08:00:00")), T("08:00:00"));
  const q3 = assessDataQuality(w3, rulesAt(T("08:00:00"))).get("T1-EAST");
  assert.ok(q3.flags.includes("gap"));
  assert.equal(q3.trustLevel, "low");
});

test("从无观测的区域标记 no_data", async (t) => {
  const ctx = await freshContext();
  t.after(() => cleanup(ctx));
  const world = buildWorld(ctx.store.viewAt(T("07:40:00")), T("07:40:00"));
  const q = assessDataQuality(world, rulesAt(T("07:40:00"))).get("T1-NORTH");
  assert.deepEqual(q.flags, ["no_data"]);
  assert.equal(q.trustLevel, "low");
});
