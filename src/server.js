import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BitemporalStore, bootstrap } from "./domain/store.js";
import { SystemClock } from "./domain/clock.js";
import { CommandService } from "./domain/commands.js";
import { buildApp } from "./http/app.js";

export async function createContext({ dir, clock = new SystemClock() } = {}) {
  const dataDir =
    dir ?? process.env.DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".data");
  const store = new BitemporalStore({ dir: dataDir, clock });
  await store.load();

  // 仅首次启动（日志为空）灌入随附样例；重启以日志为准，不重复导入。
  if (store.entries.length === 0) {
    const fixtures = await readFile(new URL("../fixtures/scenario-holiday.json", import.meta.url), "utf8");
    const scenario = JSON.parse(fixtures);
    await bootstrap(store, scenario.records);
  }

  const commands = new CommandService(store, clock);
  const app = buildApp({ store, clock, commands });
  return { app, store, clock, commands };
}

// 兼容旧探针测试。
export function buildServer() {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const context = await createContext();
  context.app.listen(port, "0.0.0.0", () => {
    console.log(`客流调配决策台已启动: http://0.0.0.0:${port}`);
  });
}
