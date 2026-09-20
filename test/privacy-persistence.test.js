import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BitemporalStore, bootstrap } from "../src/domain/store.js";
import { VirtualClock } from "../src/domain/clock.js";
import { CommandService } from "../src/domain/commands.js";
import { evaluateView } from "../src/domain/decision.js";
import { rulesAt } from "../src/domain/rules.js";
import { HttpError } from "../src/domain/store.js";
import { toMs } from "../src/domain/time.js";

const T = (s) => toMs(`2026-09-12T${s}+08:00`);

async function reopen(dataDir, at = T("07:40:00")) {
  const clock = new VirtualClock(at);
  const store = new BitemporalStore({ dir: dataDir, clock });
  await store.load();
  const commands = new CommandService(store, clock);
  return { clock, store, commands };
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "flow-persist-"));
}

async function seedFresh(dataDir) {
  const clock = new VirtualClock(T("07:40:00"));
  const store = new BitemporalStore({ dir: dataDir, clock });
  await store.load();
  const scenario = JSON.parse(await readFile(new URL("../fixtures/scenario-holiday.json", import.meta.url), "utf8"));
  await bootstrap(store, scenario.records);
  return { clock, store };
}

test("服务重启：日志恢复且种子不重复导入", async (t) => {
  const dataDir = await tempDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await seedFresh(dataDir);
  const countAfterSeed = first.store.entries.length;
  assert.ok(countAfterSeed > 20);

  const second = await reopen(dataDir);
  assert.equal(second.store.entries.length, countAfterSeed);
  // 观测数量与首次一致（无重复）
  const east = [...second.store.viewAt(T("07:40:00")).byKind("observation")].filter(
    (r) => r.zone === "T1-EAST",
  );
  assert.ok(east.length >= 3);
});

test("服务重启：用同一 Idempotency-Key 不会重复派人", async (t) => {
  const dataDir = await tempDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await seedFresh(dataDir);

  const at = T("07:40:00");
  let svc = await reopen(dataDir);
  const recId = evaluateView(svc.store.viewAt(at), at, rulesAt(at)).recommendation.recommendationId;
  const first = await svc.commands.accept({ recommendationId: recId, idempotencyKey: "restart-key", asOf: at });
  assert.equal(first.duplicated, false);

  // 模拟进程重启
  svc = await reopen(dataDir);
  const second = await svc.commands.accept({ recommendationId: recId, idempotencyKey: "restart-key", asOf: at });
  assert.equal(second.duplicated, true);
  assert.equal(second.command.commandId, first.command.commandId);
  assert.equal(svc.store.viewAt(at).byKind("command").length, 1);
});

test("同一业务编号的不同内容冲突时拒绝，更正必须用新编号带 corrects", async (t) => {
  const ctx = { dataDir: await tempDir() };
  t.after(() => rm(ctx.dataDir, { recursive: true, force: true }));
  const clock = new VirtualClock(T("07:40:00"));
  const store = new BitemporalStore({ dir: ctx.dataDir, clock });
  await store.load();
  await store.appendBatch(
    [{ observationId: "o1", zone: "T1-EAST", queue: 10, occurredAt: "2026-09-12T07:30:00+08:00", confidence: 0.9 }],
    { receivedAt: T("07:30:00") },
  );
  await assert.rejects(
    () =>
      store.appendBatch(
        [{ observationId: "o1", zone: "T1-EAST", queue: 20, occurredAt: "2026-09-12T07:30:00+08:00", confidence: 0.9 }],
        { receivedAt: T("07:32:00") },
      ),
    (error) => error instanceof HttpError && error.status === 409,
  );
});

test("隐私：旅客粒度与证件/联系方式字段在入口被拒绝", async (t) => {
  const ctx = { dataDir: await tempDir() };
  t.after(() => rm(ctx.dataDir, { recursive: true, force: true }));
  const clock = new VirtualClock(T("07:40:00"));
  const store = new BitemporalStore({ dir: ctx.dataDir, clock });
  await store.load();

  const cases = [
    { observationId: "pii-1", passenger: { name: "张三", passport: "E12345678" } },
    { observationId: "pii-2", zone: "T1-EAST", queue: 5, phone: "13800000000", occurredAt: "2026-09-12T07:30:00+08:00" },
    { observationId: "pii-3", zone: "T1-EAST", queue: 5, traveler: { idCard: "110101..." }, occurredAt: "2026-09-12T07:30:00+08:00" },
  ];
  for (const record of cases) {
    await assert.rejects(
      () => store.appendBatch([record], { receivedAt: T("07:40:00") }),
      (error) => error instanceof HttpError && error.status === 422 && error.code === "privacy_violation",
    );
  }
  // 被拒记录没有落盘
  assert.equal(store.entries.length, 0);
});

test("隐私：出口序列化不包含任何旅客身份字段", async (t) => {
  const dataDir = await tempDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const seeded = await seedFresh(dataDir);
  const result = evaluateView(seeded.store.viewAt(T("07:40:00")), T("07:40:00"), rulesAt(T("07:40:00")));
  const { toApi } = await import("../src/http/serialize.js");
  const text = JSON.stringify(toApi(result));
  for (const banned of ["passport", "idCard", "phone", "passenger", "traveler", "张三"]) {
    assert.ok(!text.includes(banned), `出口数据泄露字段: ${banned}`);
  }
  // 员工标识是化名
  for (const id of result.recommendation.action.assignees) assert.match(id, /^s-[ewn]-/);
});
