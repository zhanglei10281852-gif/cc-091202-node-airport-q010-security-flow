import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { loadContext } from "../src/domain/context.js";
import { ObservationLog, normalizeObservation } from "../src/domain/observations.js";
import { buildSnapshot } from "../src/domain/snapshot.js";
import { recommend } from "../src/domain/engine.js";
import { DecisionStore, STATUS } from "../src/domain/state.js";
import { replay } from "../src/domain/replay.js";

const FIXTURE = new URL("../fixtures/holiday-peak.json", import.meta.url);

async function setup() {
  const raw = JSON.parse(await readFile(FIXTURE, "utf8"));
  const context = loadContext(raw);
  const store = new DecisionStore();
  for (const r of raw.records) {
    if (r.kind === "observation") store.addObservation(normalizeObservation(r));
  }
  return { raw, context, store };
}

const ts = (s) => Date.parse(s);

test("迟到更正在接收前不可见，接收后取代原值", async () => {
  const { store, context } = await setup();
  const before = store.viewAt(ts("2026-09-12T07:25:00+08:00"), context);
  const logBefore = new ObservationLog(before.observations);
  assert.equal(logBefore.latestPerZone(ts("2026-09-12T07:25:00+08:00")).get("T1-EAST").queue, 86);

  const after = store.viewAt(ts("2026-09-12T07:32:00+08:00"), context);
  const logAfter = new ObservationLog(after.observations);
  // 07:31 到达的更正取代了同刻原值：可见集合中只有 72，不再有 86。
  const visibleAfter = logAfter.visible(ts("2026-09-12T07:32:00+08:00"));
  const at0720 = visibleAfter.filter(
    (r) => r.zone === "T1-EAST" && r.occurredAt === ts("2026-09-12T07:20:00+08:00")
  );
  assert.equal(at0720.length, 1);
  assert.equal(at0720[0].queue, 72);
  assert.equal(at0720[0].observationId, "obs-41-r1");

  // 被更正的原值仍然在审计视图中，且能看出 11 分钟的入库延迟。
  const audit = new ObservationLog(store.observations).audit();
  const original = audit.find((r) => r.observationId === "obs-41");
  const correction = audit.find((r) => r.observationId === "obs-41-r1");
  assert.equal(original.reportLagMs, 5000);
  assert.equal(correction.reportLagMs, 11 * 60000);
});

test("数据可信度：缺失、陈旧、低可信分别标注", async () => {
  const raw = JSON.parse(await readFile(FIXTURE, "utf8"));
  const context = loadContext(raw);
  const store = new DecisionStore();
  store.addObservation(normalizeObservation({
    zone: "T1-EAST", queue: 40, confidence: 0.5,
    occurredAt: "2026-09-12T07:00:00+08:00", receivedAt: "2026-09-12T07:00:30+08:00",
  }));
  const view = store.viewAt(ts("2026-09-12T07:30:00+08:00"), context);
  const snap = buildSnapshot({
    context, log: new ObservationLog(view.observations),
    asOf: ts("2026-09-12T07:30:00+08:00"), capacityAt: view.capacityAt,
  });
  assert.equal(snap.zones["T1-EAST"].quality, "stale"); // 陈旧优先于低可信提示
  assert.match(snap.zones["T1-EAST"].notes.join(), /推算/);
  assert.equal(snap.zones["T1-WEST"].quality, "missing");
});

test("低可信传感器（0.55）触发 fair/low 标记", async () => {
  const { store, context } = await setup();
  const asOf = ts("2026-09-12T07:51:00+08:00");
  const view = store.viewAt(asOf, context);
  const snap = buildSnapshot({ context, log: new ObservationLog(view.observations), asOf, capacityAt: view.capacityAt });
  assert.equal(snap.zones["T1-WEST"].latestObservation.confidence, 0.55);
  assert.equal(snap.zones["T1-WEST"].quality, "low-confidence");
});

test("早高峰建议跨区支援并说明牺牲区域与等待改善", async () => {
  const { store, context } = await setup();
  const asOf = ts("2026-09-12T07:25:00+08:00");
  const view = store.viewAt(asOf, context);
  const rec = recommend({ context, log: new ObservationLog(view.observations), asOf, resources: view });
  const action = rec.decisions.find((d) => d.zone === "T1-EAST" && d.type === "CROSS_ZONE_SUPPORT");
  assert.ok(action, "东区应得到跨区支援建议");
  assert.equal(action.staffId, "staff-anon-22");
  assert.equal(action.fromZone, "T1-WEST");
  assert.equal(action.lane, "E-03");
  assert.ok(action.expected.savedWaitMinutesOverHorizon > 1);
  assert.equal(action.sacrificed.zone, "T1-WEST");
  assert.ok(action.sacrificed.peakWaitAfterMin <= 12);
});

test("资质不足与法定休息冲突只出现在 screenedOut，绝不被建议", async () => {
  const { store, context } = await setup();
  const asOf = ts("2026-09-12T07:25:00+08:00");
  const view = store.viewAt(asOf, context);
  const rec = recommend({ context, log: new ObservationLog(view.observations), asOf, resources: view });
  const action = rec.decisions.find((d) => d.zone === "T1-EAST");
  const reasons = action.screenedOut.map((s) => `${s.staffId}:${s.reason}`).join("\n");
  assert.match(reasons, /staff-anon-32.*资质不足/);
  assert.match(reasons, /staff-anon-21.*法定休息/);
  assert.notEqual(action.staffId, "staff-anon-32");
  assert.notEqual(action.staffId, "staff-anon-21");
});

test("备勤 08:10 前不可及时到岗，之后建议转为直接开通道", async () => {
  const { store, context } = await setup();
  const early = ts("2026-09-12T07:42:00+08:00");
  const viewEarly = store.viewAt(early, context);
  const recEarly = recommend({ context, log: new ObservationLog(viewEarly.observations), asOf: early, resources: viewEarly });
  assert.equal(recEarly.decisions.find((d) => d.zone === "T1-EAST").type, "CROSS_ZONE_SUPPORT");

  const later = ts("2026-09-12T08:02:00+08:00");
  const viewLater = store.viewAt(later, context);
  const recLater = recommend({ context, log: new ObservationLog(viewLater.observations), asOf: later, resources: viewLater });
  const east = recLater.decisions.find((d) => d.zone === "T1-EAST");
  assert.equal(east.type, "OPEN_LANE");
  assert.equal(east.staffId, "staff-anon-12");
  assert.equal(east.sacrificed, null);
});

test("不会为短暂空闲自动关闭基线通道", async () => {
  const { store, context } = await setup();
  const asOf = ts("2026-09-12T07:42:00+08:00");
  const view = store.viewAt(asOf, context);
  const rec = recommend({ context, log: new ObservationLog(view.observations), asOf, resources: view });
  assert.ok(!rec.decisions.some((d) => d.type === "CLOSE_LANE"));
});

test("员工到岗前有效能力不变，到岗后改变，拒绝/超时/撤回各有结果", async () => {
  const { store, context } = await setup();
  const asOf = ts("2026-09-12T07:25:00+08:00");
  const view = store.viewAt(asOf, context);
  const rec = recommend({ context, log: new ObservationLog(view.observations), asOf, resources: view });
  const action = rec.decisions.find((d) => d.type === "CROSS_ZONE_SUPPORT");

  const { assignment } = store.acceptRecommendation(action, { asOf });
  const dispatchedAt = asOf + 2 * 60000;
  // 已派未到：东区能力不变。
  assert.equal(store.viewAt(dispatchedAt, context).capacityAt("T1-EAST", dispatchedAt), 6.2);
  // 但该员工已被占用，不能再被派一次。
  const view2 = store.viewAt(dispatchedAt, context);
  const rec2 = recommend({ context, log: new ObservationLog(view2.observations), asOf: dispatchedAt, resources: view2 });
  assert.match(
    rec2.decisions.find((d) => d.zone === "T1-EAST").screenedOut.map((s) => s.reason).join(),
    /不能重复派人/
  );

  // 到岗确认：东区 +3.2；西区因该员工离岗 -3.2。
  const arrivedAt = ts("2026-09-12T07:34:00+08:00");
  store.staffRespond(assignment.assignmentId, "arrive", { at: arrivedAt });
  assert.equal(store.viewAt(arrivedAt, context).capacityAt("T1-EAST", arrivedAt + 60000), 9.4);
  assert.equal(store.viewAt(arrivedAt, context).capacityAt("T1-WEST", arrivedAt + 60000), 5.8);

  // 拒绝路径。
  const store2 = new DecisionStore();
  const a2 = store2.acceptRecommendation(action, { asOf }).assignment;
  store2.staffRespond(a2.assignmentId, "reject", { at: asOf + 60000 });
  assert.equal(store2.statusAt(a2, asOf + 60000), STATUS.REJECTED);

  // 超时路径：不确认，超过到岗时限即 expired，能力从未改变。
  const store3 = new DecisionStore();
  const a3 = store3.acceptRecommendation(action, { asOf }).assignment;
  assert.equal(store3.statusAt(a3, a3.arrivalDeadline + 1), STATUS.EXPIRED);
  assert.equal(store3.viewAt(a3.arrivalDeadline + 1, context).capacityAt("T1-EAST", a3.arrivalDeadline + 1), 6.2);

  // 中途撤回：进行中指令撤回后能力回落。
  store.withdraw(assignment.assignmentId, { at: arrivedAt + 10 * 60000, reason: "西区排队回升" });
  assert.equal(store.viewAt(arrivedAt + 11 * 60000, context).capacityAt("T1-EAST", arrivedAt + 11 * 60000), 6.2);
  assert.equal(store.viewAt(arrivedAt + 11 * 60000, context).capacityAt("T1-WEST", arrivedAt + 11 * 60000), 8.8);
});

test("幂等键与自然键防止重复派人", async () => {
  const { store, context } = await setup();
  const asOf = ts("2026-09-12T07:25:00+08:00");
  const view = store.viewAt(asOf, context);
  const action = recommend({ context, log: new ObservationLog(view.observations), asOf, resources: view })
    .decisions.find((d) => d.type === "CROSS_ZONE_SUPPORT");
  const first = store.acceptRecommendation(action, { asOf, idempotencyKey: "key-1" });
  const second = store.acceptRecommendation(action, { asOf, idempotencyKey: "key-1" });
  assert.equal(first.assignment.assignmentId, second.assignment.assignmentId);
  assert.equal(second.duplicated, true);
  const third = store.acceptRecommendation(action, { asOf, idempotencyKey: "key-2" });
  assert.equal(third.duplicated, true);
  assert.equal(third.reason, "already_assigned");
});

test("持久化后重启：指令状态与观测全部恢复", async () => {
  const { store, context } = await setup();
  const stateFile = new URL("../data/test-state.json", import.meta.url);
  await rm(stateFile, { force: true });
  const asOf = ts("2026-09-12T07:25:00+08:00");
  const view = store.viewAt(asOf, context);
  const action = recommend({ context, log: new ObservationLog(view.observations), asOf, resources: view })
    .decisions.find((d) => d.type === "CROSS_ZONE_SUPPORT");
  store.file = stateFile;
  store.acceptRecommendation(action, { asOf, idempotencyKey: "boot-key" });
  await store.persist();

  // 模拟重启：新建 store 并从磁盘恢复。
  const rebooted = new DecisionStore({ file: stateFile });
  await rebooted.load();
  assert.ok(rebooted.observations.some((r) => r.observationId === "obs-41-r1"));
  assert.equal(rebooted.assignments.length, 1);
  assert.equal(rebooted.idempotency.get("boot-key"), rebooted.assignments[0].assignmentId);

  // 重启后用同一幂等键再派一次，必须返回原指令而不是重新派人。
  const again = rebooted.acceptRecommendation(action, { asOf, idempotencyKey: "boot-key" });
  assert.equal(again.duplicated, true);
  assert.equal(rebooted.assignments.length, 1);

  // 重启不改变有效能力推导：到岗后 +3.2、支援区 -3.0。
  const arrivedAt = ts("2026-09-12T07:34:00+08:00");
  rebooted.staffRespond(rebooted.assignments[0].assignmentId, "arrive", { at: arrivedAt });
  assert.equal(rebooted.viewAt(arrivedAt + 60000, context).capacityAt("T1-EAST", arrivedAt + 60000), 9.4);
  assert.equal(rebooted.viewAt(arrivedAt + 60000, context).capacityAt("T1-WEST", arrivedAt + 60000), 5.8);
  await rm(stateFile, { force: true });
});

test("历史重放：07:25 的判断看不到 07:31 才到达的更正，也看不到迟到观测", async () => {
  const { store, context } = await setup();
  const asOf = ts("2026-09-12T07:25:00+08:00");
  const report = replay({ context, store, asOf });
  assert.equal(report.snapshotThen.zones["T1-EAST"].latestObservation.queue, 86);
  const hiddenIds = report.informationEdge.hiddenObservations.map((h) => h.observationId);
  assert.ok(hiddenIds.includes("obs-41-r1"), "更正必须被列为当时不可见");
  // 只有“发生在过去、迟到入库”的信息才属隐藏；未来观测不在其列。
  assert.ok(report.informationEdge.hiddenObservations.every((h) => Date.parse(h.occurredAt) <= asOf));
});
