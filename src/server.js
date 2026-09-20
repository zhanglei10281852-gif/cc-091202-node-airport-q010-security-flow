import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createApp, loadContextFromFile } from "./app.js";
import { DecisionStore } from "./domain/state.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

function normalizeFromFixture(r) {
  return {
    observationId: r.observationId ?? `obs-${r.zone}-${Date.parse(r.occurredAt)}`,
    corrects: r.corrects ?? null,
    zone: r.zone,
    queue: Math.max(0, Math.round(r.queue)),
    occurredAt: Date.parse(r.occurredAt),
    receivedAt: Date.parse(r.receivedAt),
    confidence: r.confidence ?? 0.9,
  };
}

// 测试/编程式入口：加载样例资料，状态默认存内存（file=null）。
export async function buildServer({ contextFile = here("../fixtures/holiday-peak.json"), stateFile = null } = {}) {
  const context = await loadContextFromFile(contextFile);
  const store = new DecisionStore({ file: stateFile });
  await store.load();
  if (store.observations.length === 0) {
    const raw = JSON.parse(await readFile(contextFile, "utf8"));
    for (const r of raw.records ?? []) {
      if (r.kind === "observation" || (!r.kind && r.observationId)) {
        store.addObservation(normalizeFromFixture(r));
      }
    }
  }
  return createApp({ context, store });
}

async function main() {
  const contextPath = process.env.CONTEXT_FILE
    ? resolve(process.env.CONTEXT_FILE)
    : here("../fixtures/holiday-peak.json");
  const stateFile = process.env.STATE_FILE
    ? resolve(process.env.STATE_FILE)
    : here("../data/state.json");

  const server = await buildServer({ contextFile: contextPath, stateFile });
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  server.listen(port, "0.0.0.0", () => {
    // 启动日志不含任何旅客或员工身份明细。
    console.log(`[flow-console] listening on :${port}`);
  });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
