import assert from "node:assert/strict";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import test from "node:test";
import { buildServer } from "../src/server.js";

const stateFile = new URL("../data/test-http-state.json", import.meta.url);

async function startServer() {
  await rm(stateFile, { force: true });
  const server = await buildServer({ stateFile });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  return { server, url, stop: () => Promise.all([server.close(), rm(stateFile, { force: true })]) };
}

const json = (r) => r.json();

test("端到端：点时刻快照不使用迟到更正", async (context) => {
  const { url, stop } = await startServer();
  context.after(stop);

  const before = await json(await fetch(url("/api/snapshot?asOf=2026-09-12T07:25:00%2B08:00")));
  assert.equal(before.zones["T1-EAST"].latestObservation.queue, 86);
  assert.equal(before.zones["T1-EAST"].latestObservation.observationId, "obs-41");

  const after = await json(await fetch(url("/api/snapshot?asOf=2026-09-12T07:32:00%2B08:00")));
  // 07:32 时最新观测是 07:30 的 104；而 07:20 原值 86 已被 07:31 到达的更正 72 取代。
  assert.equal(after.zones["T1-EAST"].latestObservation.queue, 104);
  const obs = await json(await fetch(url("/api/observations?asOf=2026-09-12T07:32:00%2B08:00")));
  const at0720 = obs.observations.filter(
    (o) => o.zone === "T1-EAST" && o.occurredAt === "2026-09-11T23:20:00.000Z"
  );
  assert.equal(at0720.length, 1);
  assert.equal(at0720[0].queue, 72);
  assert.equal(at0720[0].corrects, "obs-41");
});

test("端到端：建议 -> 接受 -> 到岗 -> 撤回，能力随之变化", async (context) => {
  const { url, stop } = await startServer();
  context.after(stop);
  const T = "2026-09-12T07:25:00%2B08:00";

  const rec = await json(await fetch(url(`/api/recommend?asOf=${T}`)));
  const action = rec.decisions.find((d) => d.type === "CROSS_ZONE_SUPPORT");
  assert.ok(action);
  assert.ok(action.sacrificed.zone === "T1-WEST");

  const created = await json(await fetch(url("/api/assignments"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ asOf: "2026-09-12T07:25:00+08:00", zone: "T1-EAST", lane: "E-03", idempotencyKey: "e2e-1" }),
  }));
  assert.equal(created.assignment.status, "dispatched");
  const id = created.assignment.assignmentId;

  // 并发重复提交（不同幂等键也会被自然键挡住）。
  const dupes = await Promise.all([
    fetch(url("/api/assignments"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ asOf: "2026-09-12T07:25:00+08:00", zone: "T1-EAST", lane: "E-03", idempotencyKey: "e2e-1" }),
    }).then(json),
    fetch(url("/api/assignments"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ asOf: "2026-09-12T07:25:00+08:00", zone: "T1-EAST", lane: "E-03", idempotencyKey: "e2e-2" }),
    }).then(json),
  ]);
  assert.equal(dupes[0].assignment.assignmentId, id);
  assert.equal(dupes[1].assignment.assignmentId, id);
  const list = await json(await fetch(url("/api/assignments?asOf=2026-09-12T08:00:00%2B08:00")));
  assert.equal(list.assignments.length, 1, "并发下不得产生第二条指令");

  // 员工拒绝资质/休息不满足的建议时，系统本来就不会给出该建议。
  // 员工到岗确认后能力变化。
  const arrived = await json(await fetch(url(`/api/assignments/${id}/respond`), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "arrive", at: "2026-09-12T07:34:00+08:00" }),
  }));
  assert.equal(arrived.status, "active");

  const snapAt = "2026-09-12T07:40:00%2B08:00";
  const snap = await json(await fetch(url(`/api/snapshot?asOf=${snapAt}`)));
  assert.equal(snap.zones["T1-EAST"].capacityPpm, 9.4);
  assert.equal(snap.zones["T1-WEST"].capacityPpm, 5.8);

  // 经理中途撤回，能力回落。
  await fetch(url(`/api/assignments/${id}/withdraw`), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ at: "2026-09-12T07:50:00+08:00", reason: "西区回升" }),
  });
  const snap2 = await json(await fetch(url("/api/snapshot?asOf=2026-09-12T07:55:00%2B08:00")));
  assert.equal(snap2.zones["T1-EAST"].capacityPpm, 6.2);
  assert.equal(snap2.zones["T1-WEST"].capacityPpm, 8.8);
});

test("端到端：拒绝与超时均不改变能力，且不可重复响应", async (context) => {
  const { url, stop } = await startServer();
  context.after(stop);

  const created = await json(await fetch(url("/api/assignments"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ asOf: "2026-09-12T07:25:00+08:00", zone: "T1-EAST", lane: "E-03" }),
  }));
  const id = created.assignment.assignmentId;
  const rejected = await fetch(url(`/api/assignments/${id}/respond`), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "reject", at: "2026-09-12T07:26:00+08:00" }),
  });
  assert.equal(rejected.status, 200);
  const again = await fetch(url(`/api/assignments/${id}/respond`), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "arrive", at: "2026-09-12T07:30:00+08:00" }),
  });
  assert.equal(again.status, 409);

  const list = await json(await fetch(url("/api/assignments?asOf=2026-09-12T07:40:00%2B08:00")));
  assert.equal(list.assignments[0].status, "rejected");
  const snap = await json(await fetch(url("/api/snapshot?asOf=2026-09-12T07:40:00%2B08:00")));
  assert.equal(snap.zones["T1-EAST"].capacityPpm, 6.2);
  assert.equal(snap.zones["T1-WEST"].capacityPpm, 8.8);
});

test("端到端：重启后不重复派人", async (context) => {
  let harness = await startServer();
  context.after(() => harness.stop());
  const created = await json(await fetch(harness.url("/api/assignments"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ asOf: "2026-09-12T07:25:00+08:00", zone: "T1-EAST", lane: "E-03", idempotencyKey: "restart-1" }),
  }));
  assert.equal(created.assignment.status, "dispatched");
  harness.server.close();
  await once(harness.server, "close");

  // 重新启动同一状态文件。
  const server2 = await buildServer({ stateFile });
  server2.listen(0, "127.0.0.1");
  await once(server2, "listening");
  const port2 = server2.address().port;
  const url2 = (path) => `http://127.0.0.1:${port2}${path}`;
  const retry = await json(await fetch(url2("/api/assignments"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ asOf: "2026-09-12T07:25:00+08:00", zone: "T1-EAST", lane: "E-03", idempotencyKey: "restart-1" }),
  }));
  assert.equal(retry.duplicated, true);
  assert.equal(retry.assignment.assignmentId, created.assignment.assignmentId);
  server2.close();
});

test("端到端：历史重放隔离事后信息并给出实际等待对比", async (context) => {
  const { url, stop } = await startServer();
  context.after(stop);
  const report = await json(await fetch(url("/api/replay?asOf=2026-09-12T07:25:00%2B08:00")));
  assert.equal(report.snapshotThen.zones["T1-EAST"].latestObservation.queue, 86);
  assert.ok(report.informationEdge.hiddenObservations.some((h) => h.observationId === "obs-41-r1"));
  const east = report.comparisons.find((c) => c.zone === "T1-EAST");
  assert.ok(east.predicted.holdPeakWaitMin > east.predicted.actionPeakWaitMin);
  assert.equal(typeof report.actualWaits["T1-EAST"].actualPeakWaitMin, "number");
});

test("端到端：迟到观测并发接入后可被查询，且只暴露匿名聚合字段", async (context) => {
  const { url, stop } = await startServer();
  context.after(stop);
  const payload = {
    observationId: "obs-concurrent-1",
    zone: "T1-EAST",
    queue: 130,
    occurredAt: "2026-09-12T07:33:00+08:00",
    receivedAt: "2026-09-12T07:33:30+08:00",
    confidence: 0.8,
    passengerNames: ["张三", "李四"], // 模拟误带的旅客身份字段
  };
  const writes = await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(url("/api/observations"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    )
  );
  for (const r of writes) assert.equal(r.status, 202);
  const rows = await json(await fetch(url("/api/observations?asOf=2026-09-12T08:00:00%2B08:00")));
  const found = rows.observations.filter((r) => r.observationId === "obs-concurrent-1");
  assert.equal(found.length, 1, "重复 observationId 只入库一次");
  assert.ok(!("passengerNames" in found[0]), "响应不得包含旅客身份字段");
  for (const key of Object.keys(found[0])) {
    assert.ok(["observationId", "corrects", "zone", "queue", "occurredAt", "receivedAt", "confidence"].includes(key));
  }
});
