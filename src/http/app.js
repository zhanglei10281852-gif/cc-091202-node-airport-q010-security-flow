// HTTP 装配：所有写操作串行化到 store 同一把锁；时间参数支持 asOf 以便重放/演练。
import { createServer } from "node:http";
import { toMs } from "../domain/time.js";
import { rulesAt } from "../domain/rules.js";
import { evaluate } from "../domain/decision.js";
import { replayDecision, compareOutcomes } from "../domain/replay.js";
import { HttpError } from "../domain/store.js";
import { toApi } from "./serialize.js";

const MAX_BODY = 2 * 1024 * 1024;

export function buildApp({ store, clock, commands }) {
  return createServer((req, res) => {
    handle(req, res, { store, clock, commands }).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      send(res, status, {
        error: status === 500 ? "internal_error" : error.code,
        message: status === 500 ? "服务内部错误" : error.message,
      });
    });
  });
}

async function handle(req, res, deps) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { status: "ok", time: deps.clock.now() });
  }

  // ---------- 数据接入 ----------
  if (req.method === "POST" && pathname === "/api/ingest") {
    const body = await readJson(req);
    const records = body.records ?? (Array.isArray(body) ? body : null);
    const receivedAt = body.receivedAt ? parseTime(body.receivedAt) : undefined;
    const result = await deps.store.appendBatch(records, { receivedAt });
    return send(res, 202, result);
  }

  // ---------- 滚动评估 ----------
  if (req.method === "GET" && pathname === "/api/decisions") {
    const at = queryTime(url, "asOf") ?? deps.clock.now();
    const result = evaluate(deps.store, at, rulesAt(at));
    return send(res, 200, toApi(result));
  }

  // ---------- 历史重放 ----------
  if (req.method === "GET" && pathname === "/api/replay") {
    const at = requiredTime(url, "at");
    return send(res, 200, toApi(replayDecision(deps.store, at)));
  }

  if (req.method === "GET" && pathname === "/api/replay/compare") {
    const decisionAt = requiredTime(url, "decisionAt");
    const evaluateAt = queryTime(url, "evaluateAt") ?? undefined;
    return send(res, 200, toApi(compareOutcomes(deps.store, decisionAt, evaluateAt)));
  }

  // ---------- 人工覆盖 ----------
  if (req.method === "POST" && pathname === "/api/overrides") {
    const body = await readJson(req);
    const override = normalizeOverride(body, deps.clock.now());
    const result = await deps.store.appendBatch([override], { receivedAt: override.at });
    return send(res, 202, result);
  }

  // ---------- 指令 ----------
  if (req.method === "POST" && pathname === "/api/commands") {
    const body = await readJson(req);
    const idempotencyKey = req.headers["idempotency-key"] || body.idempotencyKey;
    const result = await deps.commands.accept({
      recommendationId: body.recommendationId,
      idempotencyKey,
      asOf: body.asOf ? parseTime(body.asOf) : undefined,
      validMinutes: body.validMinutes,
      managerId: body.managerId,
    });
    return send(res, result.duplicated ? 200 : 201, toApi(result));
  }

  let m = pathname.match(/^\/api\/commands\/([^/]+)\/(ack|revoke)$/);
  if (m && req.method === "POST") {
    const [, commandId, kind] = m;
    const body = await readJson(req);
    const at = body.at ? parseTime(body.at) : undefined;
    if (kind === "ack") {
      const result = await deps.commands.acknowledge(
        commandId,
        body.staffId,
        body.event === "reject" ? "reject" : "confirm",
        { at },
      );
      return send(res, result.duplicated ? 200 : 200, toApi(result));
    }
    const result = await deps.commands.revoke(commandId, { at, reason: body.reason });
    return send(res, 200, toApi(result));
  }

  if (req.method === "GET" && pathname === "/api/commands") {
    const at = queryTime(url, "asOf") ?? deps.clock.now();
    return send(res, 200, toApi({ commands: deps.commands.listCommands(at) }));
  }

  send(res, 404, { error: "not_found", message: `无此路由: ${req.method} ${pathname}` });
}

function normalizeOverride(body, now) {
  const allowed = new Set(["force_lane_open", "force_lane_closed", "staff_unavailable", "suppress_recommendation"]);
  if (!body || !allowed.has(body.type)) {
    throw new HttpError(400, "bad_override", `type 必须是 ${[...allowed].join("/")}`);
  }
  if (!body.overrideId) throw new HttpError(400, "missing_override_id", "overrideId 必填");
  const at = body.at ? parseTime(body.at) : now;
  const until = body.until ? parseTime(body.until) : at + 60 * 60_000;
  return {
    recordType: "override",
    overrideId: body.overrideId,
    type: body.type,
    lane: body.lane ?? null,
    zone: body.zone ?? null,
    staffId: body.staffId ?? null,
    at,
    until,
    reason: body.reason ?? null,
  };
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new HttpError(413, "body_too_large", "请求体超过 2MB");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "bad_json", "请求体不是合法 JSON");
  }
}

function send(res, status, payload) {
  if (!res.headersSent) res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseTime(value) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) throw new HttpError(400, "bad_time", `非法时间: ${value}`);
  return ms;
}
function queryTime(url, name) {
  const value = url.searchParams.get(name);
  return value === null ? null : parseTime(value);
}
function requiredTime(url, name) {
  const value = url.searchParams.get(name);
  if (value === null) throw new HttpError(400, "missing_param", `缺少查询参数 ${name}`);
  return parseTime(value);
}
