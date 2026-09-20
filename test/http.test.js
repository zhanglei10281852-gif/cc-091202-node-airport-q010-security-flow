import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BitemporalStore, bootstrap } from "../src/domain/store.js";
import { VirtualClock } from "../src/domain/clock.js";
import { CommandService } from "../src/domain/commands.js";
import { buildApp } from "../src/http/app.js";
import { toMs } from "../src/domain/time.js";

const T = (s) => toMs(`2026-09-12T${s}+08:00`);

async function startServer(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "flow-http-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const clock = new VirtualClock(T("07:40:00"));
  const store = new BitemporalStore({ dir: dataDir, clock });
  await store.load();
  const scenario = JSON.parse(await readFile(new URL("../fixtures/scenario-holiday.json", import.meta.url), "utf8"));
  await bootstrap(store, scenario.records);
  const commands = new CommandService(store, clock);
  const server = buildApp({ store, clock, commands }).listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, clock, commands, dataDir };
}

test("健康探针", async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "ok");
});

test("GET /api/decisions 返回滚动评估，时间均为 ISO 字符串", async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/api/decisions`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.asOf);
  assert.ok(body.recommendation.action.zone === "T1-EAST");
  for (const zone of body.zones) {
    if (zone.dataQuality.latest) assert.match(zone.dataQuality.latest.occurredAt, /Z$/);
  }
});

test("并发观测写入：同一观测重复提交只生效一次", async (t) => {
  const { base, store } = await startServer(t);
  const record = {
    observationId: "obs-conc-1",
    zone: "T1-EAST",
    queue: 50,
    occurredAt: "2026-09-12T07:38:00+08:00",
    confidence: 0.9,
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ records: [record] }),
      }).then((r) => r.json()),
    ),
  );
  const acceptedTotal = results.reduce((n, r) => n + r.accepted.length, 0);
  const duplicateTotal = results.reduce((n, r) => n + r.duplicates.length, 0);
  assert.equal(acceptedTotal, 1);
  assert.equal(duplicateTotal, 7);
  const count = store.entries.filter((e) => e.key === "obs:obs-conc-1").length;
  assert.equal(count, 1);
});

test("完整 HTTP 指令流：接受→确认→查询状态", async (t) => {
  const { base } = await startServer(t);
  const decision = await (await fetch(`${base}/api/decisions`)).json();
  const recId = decision.recommendation.recommendationId;

  const acceptRes = await fetch(`${base}/api/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "http-flow-1" },
    body: JSON.stringify({ recommendationId: recId }),
  });
  assert.equal(acceptRes.status, 201);
  const cmd = await acceptRes.json();
  assert.equal(cmd.command.status, "awaiting_confirmation");
  const commandId = cmd.command.commandId;

  for (const staffId of cmd.command.action.assignees) {
    const ackRes = await fetch(`${base}/api/commands/${commandId}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId, at: "2026-09-12T07:47:00+08:00" }),
    });
    assert.equal(ackRes.status, 200, await ackRes.text());
  }
  const list = await (
    await fetch(`${base}/api/commands?asOf=2026-09-12T07%3A48%3A00%2B08%3A00`)
  ).json();
  const final = list.commands.find((c) => c.commandId === commandId);
  assert.equal(final.status, "active");
  assert.equal(final.acknowledged.length, cmd.command.action.assignees.length);
});

test("人工覆盖记录接入后，被覆盖区域不再出现自动建议", async (t) => {
  const { base } = await startServer(t);
  const post = await fetch(`${base}/api/overrides`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      overrideId: "ovr-http-1",
      type: "suppress_recommendation",
      zone: "T1-EAST",
      at: "2026-09-12T07:39:00+08:00",
      until: "2026-09-12T09:30:00+08:00",
    }),
  });
  assert.equal(post.status, 202);
  const body = await (await fetch(`${base}/api/decisions?asOf=2026-09-12T07:42:00%2B08:00`)).json();
  const east = body.zones.find((z) => z.zone === "T1-EAST");
  assert.equal(east.recommendationSuppressed, true);
  assert.notEqual(body.recommendation?.action?.zone, "T1-EAST");
});

test("非法记录返回 4xx 且不产生部分写入", async (t) => {
  const { base, store } = await startServer(t);
  const before = store.entries.length;
  const res = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      records: [
        { observationId: "ok-1", zone: "T1-EAST", queue: 10, occurredAt: "2026-09-12T07:38:00+08:00", confidence: 0.9 },
        { observationId: "bad-1", zone: "T1-EAST", queue: 10, occurredAt: "not-a-time", confidence: 0.9 },
      ],
    }),
  });
  assert.equal(res.status, 400);
  assert.equal(store.entries.length, before, "批次应整体回滚");
});
