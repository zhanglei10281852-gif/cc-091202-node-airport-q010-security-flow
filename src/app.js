// 决策台 HTTP 接口。所有写操作经 DecisionStore.mutate 串行化并原子落盘，
// 重启后从事件日志恢复；接口只返回匿名聚合数据与匿名员工标识。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { loadContext } from "./domain/context.js";
import { ObservationLog, normalizeObservation } from "./domain/observations.js";
import { buildSnapshot } from "./domain/snapshot.js";
import { recommend } from "./domain/engine.js";
import { replay } from "./domain/replay.js";
import { DecisionStore, STATUS } from "./domain/state.js";
import { parseTs, iso, HORIZON_MIN } from "./domain/clock.js";

const MAX_BODY = 1_000_000;

export async function createApp({ context, store, clock = () => Date.now() } = {}) {
  if (!context) throw new Error("createApp 需要 context");
  if (!store) throw new Error("createApp 需要 store");

  const readBody = async (request) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      request.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error("请求体过大"), { status: 413, code: "body_too_large" }));
          request.destroy();
          return;
        }
        chunks.push(c);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });

  const parseJson = async (request) => {
    const text = await readBody(request);
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error("JSON 无法解析"), { status: 400, code: "bad_json" });
    }
  };

  const asOfFrom = (url) => {
    const v = url.searchParams.get("asOf");
    return v ? parseTs(v, "asOf") : clock();
  };

  const send = (response, status, payload) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  };

  const fail = (response, error) => {
    const status = error.status ?? {
      bad_json: 400,
      not_found: 404,
      not_actionable: 409,
      illegal_transition: 409,
      deadline_passed: 409,
      already_applied: 409,
      body_too_large: 413,
    }[error.code] ?? 400;
    send(response, status, { error: error.code ?? "invalid_request", message: error.message });
  };

  // 隐私出口：只放行聚合与匿名字段，任何旅客个体字段（若误传入）都不会出现在响应里。
  const publicObservation = (r) => ({
    observationId: r.observationId,
    corrects: r.corrects ?? undefined,
    zone: r.zone,
    queue: r.queue,
    occurredAt: iso(r.occurredAt),
    receivedAt: iso(r.receivedAt),
    confidence: r.confidence,
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { status: "ok", asOf: iso(clock()) });
        return;
      }

      // ---------- 静态资料（匿名） ----------
      if (request.method === "GET" && url.pathname === "/api/context") {
        send(response, 200, {
          scenario: context.scenario,
          date: context.date,
          timeZone: context.timeZone,
          zones: context.zones,
          lanes: context.lanes,
          walkTimes: Object.fromEntries(
            context.zones.flatMap((a) =>
              context.zones
                .filter((b) => a < b && context.walkMinutes(a, b) !== null)
                .map((b) => [`${a}->${b}`, context.walkMinutes(a, b)])
            )
          ),
          staff: context.staff.map((s) => ({
            staffId: s.staffId,
            homeZone: s.homeZone,
            role: s.role,
            qualifications: s.qualifications,
            availableAt: Number.isFinite(s.availableAt) ? iso(s.availableAt) : null,
            restWindows: s.restWindows.map((w) => ({
              start: iso(w.start),
              end: iso(w.end),
              reason: w.reason,
            })),
          })),
          waves: context.waves.map((w) => ({
            waveId: w.waveId,
            departAt: iso(w.departAt),
            arriveStart: iso(w.arriveStart),
            arriveEnd: iso(w.arriveEnd),
            passengers: w.passengers,
          })),
        });
        return;
      }

      // ---------- 观测接入 ----------
      if (request.method === "POST" && url.pathname === "/api/observations") {
        const body = await parseJson(request);
        const list = Array.isArray(body) ? body : body.observations ?? [body];
        const result = await store.mutate(async () => {
          const out = [];
          for (const item of list) {
            const obs = normalizeObservation(item, { fallbackReceivedAt: clock() });
            const r = store.addObservation(obs);
            out.push(r);
          }
          await store.persist();
          return out;
        });
        send(response, 202, { accepted: result });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/observations") {
        const asOf = asOfFrom(url);
        const audit = url.searchParams.get("view") === "audit";
        const rows = await store.mutate(async () => {
          if (audit) {
            return new ObservationLog(store.observations)
              .audit()
              .map((r) => ({
                ...publicObservation(r),
                reportLagMin: Math.round((r.receivedAt - r.occurredAt) / 60000),
              }));
          }
          // 默认视图：截至 asOf 已接收且已应用更正链，不含被取代的原值。
          return new ObservationLog(store.observations)
            .visible(asOf)
            .map(publicObservation);
        });
        send(response, 200, { asOf: iso(asOf), observations: rows });
        return;
      }

      // ---------- 快照 / 建议 ----------
      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        const asOf = asOfFrom(url);
        const horizonMin = Number(url.searchParams.get("horizonMin") ?? HORIZON_MIN);
        const payload = await store.mutate(async () => {
          const view = store.viewAt(asOf, context);
          const log = new ObservationLog(view.observations);
          return buildSnapshot({ context, log, asOf, capacityAt: view.capacityAt, horizonMin });
        });
        send(response, 200, payload);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/recommend") {
        const asOf = asOfFrom(url);
        const horizonMin = Number(url.searchParams.get("horizonMin") ?? HORIZON_MIN);
        const payload = await store.mutate(async () => {
          const view = store.viewAt(asOf, context);
          const log = new ObservationLog(view.observations);
          return recommend({ context, log, asOf, resources: view, horizonMin });
        });
        send(response, 200, payload);
        return;
      }

      // ---------- 经理接受建议 -> 有时限指令 ----------
      if (request.method === "POST" && url.pathname === "/api/assignments") {
        const body = await parseJson(request);
        const asOf = body.asOf ? parseTs(body.asOf, "asOf") : clock();
        const idempotencyKey = body.idempotencyKey
          ?? (request.headers["idempotency-key"] ? String(request.headers["idempotency-key"]) : null);
        const result = await store.mutate(async () => {
          const view = store.viewAt(asOf, context);
          const log = new ObservationLog(view.observations);
          const recs = recommend({ context, log, asOf, resources: view }).decisions;
          const match = recs.find(
            (d) =>
              (d.type === "OPEN_LANE" || d.type === "CROSS_ZONE_SUPPORT") &&
              d.zone === body.zone &&
              d.lane === body.lane &&
              (body.staffId === undefined || d.staffId === body.staffId)
          );
          if (!match) {
            throw Object.assign(
              new Error("当前时刻没有匹配的可执行建议（可能被资质、休息、到岗时限或牺牲区约束筛除）"),
              { status: 409, code: "no_matching_recommendation" }
            );
          }
          const r = store.acceptRecommendation(match, { idempotencyKey, ttlMin: body.ttlMin, asOf });
          await store.persist();
          return { assignment: store.listAssignments({ asOf }).find((a) => a.assignmentId === r.assignment.assignmentId), duplicated: r.duplicated, recommendation: match };
        });
        send(response, result.duplicated ? 200 : 201, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/assignments") {
        const asOf = asOfFrom(url);
        const rows = await store.mutate(async () => store.listAssignments({ asOf }));
        send(response, 200, { asOf: iso(asOf), assignments: rows });
        return;
      }

      const assignmentAction = url.pathname.match(/^\/api\/assignments\/([^/]+)\/(respond|withdraw)$/);
      if (request.method === "POST" && assignmentAction) {
        const [, assignmentId, kind] = assignmentAction;
        const body = await parseJson(request);
        const at = body.at ? parseTs(body.at, "at") : clock();
        const rows = await store.mutate(async () => {
          if (kind === "respond") {
            if (!["arrive", "reject"].includes(body.action)) {
              throw Object.assign(new Error("action 必须是 arrive 或 reject"), { status: 400 });
            }
            store.staffRespond(assignmentId, body.action, { at, note: body.note });
          } else {
            store.withdraw(assignmentId, { at, reason: body.reason });
          }
          await store.persist();
          // 以动作时刻解释状态（支持按历史时刻操作），避免用当前时钟把历史指令误判为到期。
          const row = store.listAssignments({ asOf: at }).find((a) => a.assignmentId === assignmentId);
          return row;
        });
        send(response, 200, rows);
        return;
      }

      // ---------- 人工覆盖（有时限） ----------
      if (request.method === "POST" && url.pathname === "/api/overrides") {
        const body = await parseJson(request);
        const override = await store.mutate(async () => {
          const o = store.addOverride({
            lane: body.lane,
            zone: body.zone,
            action: body.action,
            start: body.start ? parseTs(body.start, "start") : clock(),
            end: parseTs(body.end, "end"),
            reason: body.reason,
            createdBy: body.createdBy,
          });
          await store.persist();
          return { ...o, start: iso(o.start), end: iso(o.end), createdAt: iso(o.createdAt) };
        });
        send(response, 201, override);
        return;
      }

      const revokeMatch = url.pathname.match(/^\/api\/overrides\/([^/]+)\/revoke$/);
      if (request.method === "POST" && revokeMatch) {
        const override = await store.mutate(async () => {
          const o = store.revokeOverride(revokeMatch[1], { at: clock() });
          await store.persist();
          return o;
        });
        send(response, 200, { overrideId: override.overrideId, revokedAt: iso(override.revokedAt) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/overrides") {
        const asOf = asOfFrom(url);
        const rows = await store.mutate(async () =>
          store.overrides
            .filter((o) => o.createdAt <= asOf)
            .map((o) => ({
              overrideId: o.overrideId,
              lane: o.lane,
              zone: o.zone,
              action: o.action,
              start: iso(o.start),
              end: iso(o.end),
              reason: o.reason,
              createdBy: o.createdBy,
              revokedAt: o.revokedAt ? iso(o.revokedAt) : null,
              activeAtAsOf: o.start <= asOf && asOf < o.end && !o.revokedAt,
            }))
        );
        send(response, 200, { asOf: iso(asOf), overrides: rows });
        return;
      }

      // ---------- 历史重放 ----------
      if (request.method === "GET" && url.pathname === "/api/replay") {
        const asOf = asOfFrom(url);
        const horizonMin = Number(url.searchParams.get("horizonMin") ?? HORIZON_MIN);
        const payload = await store.mutate(async () => replay({ context, store, asOf, horizonMin }));
        send(response, 200, payload);
        return;
      }

      send(response, 404, { error: "not_found" });
    } catch (error) {
      fail(response, error);
    }
  });

  return server;
}

export async function loadContextFromFile(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return loadContext(raw);
}

export { STATUS };
