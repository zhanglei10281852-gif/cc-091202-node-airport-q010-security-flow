// 测试公共夹具：临时目录 + 种子装载。
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { BitemporalStore, bootstrap } from "../src/domain/store.js";
import { VirtualClock } from "../src/domain/clock.js";
import { CommandService } from "../src/domain/commands.js";
import { toMs } from "../src/domain/time.js";

export const T_0740 = "2026-09-12T07:40:00+08:00";

export async function loadScenario() {
  const raw = await readFile(new URL("../fixtures/scenario-holiday.json", import.meta.url), "utf8");
  return JSON.parse(raw);
}

export async function freshContext({ at = T_0740, dir } = {}) {
  const dataDir = dir ?? await mkdtemp(path.join(os.tmpdir(), "flow-test-"));
  const clock = new VirtualClock(toMs(at));
  const store = new BitemporalStore({ dir: dataDir, clock });
  await store.load();
  const scenario = await loadScenario();
  await bootstrap(store, scenario.records);
  const commands = new CommandService(store, clock);
  return { dataDir, clock, store, commands, records: scenario.records };
}

export async function cleanup(ctx) {
  await rm(ctx.dataDir, { recursive: true, force: true });
}
