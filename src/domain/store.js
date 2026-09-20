// 双时态只追加存储：
//  - occurredAt：现场发生时间（业务时间）
//  - receivedAt：系统接收时间（知晓时间）
// 重放任意历史时刻 t 时，只可见 receivedAt <= t 的记录，
// 因此迟到的更正不会伪装成当时已知的信息。
// 写入为单行 JSONL 并 fsync，进程重启后整段重放恢复；
// 所有变更经一把互斥链串行化，保证并发观测下状态一致。
import { mkdir, open, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { toMs, requireTime } from "./time.js";
import { findPrivacyViolation } from "./privacy.js";

const LOG_FILE = "events.log";

function kindOf(record) {
  if (typeof record.recordType === "string") return record.recordType;
  if (record.corrects) return "correction";
  if (record.observationId) return "observation";
  if (record.lane) return "lane";
  if (record.staffId) return "staff";
  return "unknown";
}

// 同一实体的多条记录（观测/更正、员工资料、通道能力）用业务编号去重。
function businessKey(record, kind) {
  switch (kind) {
    case "observation":
    case "correction":
      return `obs:${record.observationId}`;
    case "lane":
      return `lane:${record.lane}`;
    case "staff":
      return `staff:${record.staffId}`;
    case "walkTime":
      return `walk:${record.fromZone}>${record.toZone}`;
    case "flightWave":
      return `wave:${record.waveId ?? record.flight ?? `${record.zone}@${record.departsAt}`}`;
    case "override":
      return `override:${record.overrideId}`;
    case "command":
      return `command:${record.commandId}`;
    case "commandEvent":
      return `cmd-event:${record.commandId}:${record.event}:${record.staffId ?? "mgr"}:${record.at}`;
    default:
      return null;
  }
}

let seqCounter = 0;

export class BitemporalStore {
  constructor({ dir, clock }) {
    this.dir = dir;
    this.clock = clock;
    this.logPath = path.join(dir, LOG_FILE);
    this.entries = []; // {seq, receivedAt, record, kind, key}
    this.seenKeys = new Map(); // key -> entry（幂等去重，不能用 seq 当下标：重复跳号会错位）
    this.idempotency = new Map(); // Idempotency-Key -> commandId
    this.mutex = Promise.resolve();
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.logPath)) return;
    const raw = await readFile(this.logPath, "utf8");
    let lineNo = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      lineNo += 1;
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch (error) {
        throw new Error(`日志第 ${lineNo} 行损坏，拒绝启动: ${error.message}`);
      }
      this.index(envelope);
    }
  }

  index(envelope) {
    const kind = envelope.kind ?? kindOf(envelope.record);
    const key = envelope.key ?? businessKey(envelope.record, kind);
    const entry = {
      seq: envelope.seq ?? (seqCounter += 1),
      receivedAt: envelope.receivedAt,
      record: envelope.record,
      kind,
      key,
    };
    seqCounter = Math.max(seqCounter, entry.seq);
    if (key) {
      const priorEntry = this.seenKeys.get(key);
      if (priorEntry !== undefined) {
        // 幂等重放：同一业务编号已存在，保留先到者（迟到数据走更正流程，用新编号）。
        if (jsonSame(priorEntry.record, entry.record)) return entry;
        throw new Error(`业务编号冲突: ${key} 已存在且内容不同`);
      }
    }
    if (kind === "command" && entry.record.idempotencyKey) {
      this.idempotency.set(entry.record.idempotencyKey, entry.record.commandId);
    }
    if (key) this.seenKeys.set(key, entry);
    this.entries.push(entry);
    return entry;
  }

  // 串行化所有写操作；返回值透传给调用方。
  withLock(task) {
    const run = this.mutex.then(() => task());
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // 追加一批记录。整批校验、整批落盘：任何一条不合法则全部不生效。
  async appendBatch(records, { receivedAt } = {}) {
    return this.withLock(() => this.appendBatchLocked(records, receivedAt));
  }

  async appendBatchLocked(records, receivedAtOverride) {
    if (!Array.isArray(records) || records.length === 0) {
      throw new HttpError(400, "empty_batch", "records 必须是非空数组");
    }
    const at = receivedAtOverride ?? this.clock.now();
    const prepared = [];
    const localKeys = new Set();
    for (const record of records) {
      validateShape(record);
      const violation = findPrivacyViolation(record);
      if (violation) {
        throw new HttpError(422, "privacy_violation", `在 ${violation.path} 发现旅客个人数据，系统只接受聚合观测`);
      }
      const kind = kindOf(record);
      if (kind === "unknown") throw new HttpError(400, "unknown_record", "无法识别的记录类型");
      const key = businessKey(record, kind);
      if (key) {
        if (localKeys.has(key)) throw new HttpError(409, "duplicate_in_batch", `批次内编号重复: ${key}`);
        if (this.seenKeys.has(key)) {
          // 确认为完全相同的重发：幂等跳过，不重复落盘。
          const priorEntry = this.seenKeys.get(key);
          if (!jsonSame(priorEntry.record, record)) {
            throw new HttpError(409, "key_conflict", `编号 ${key} 已被不同内容占用，更正请使用新编号并带 corrects`);
          }
          prepared.push({ seq: priorEntry.seq, skipped: true, key, kind });
          continue;
        }
        localKeys.add(key);
      }
      // 传感器观测的发生时间不可能晚于接收时间；覆盖/波次等计划性记录允许提前下发。
      const occurred = record.occurredAt ?? record.at ?? record.issuedAt ?? null;
      if (kind === "observation" || kind === "correction") {
        if (occurred === null || !Number.isFinite(toMs(occurred))) {
          throw new HttpError(400, "bad_occurred_at", `${key ?? kind} 缺少合法的 occurredAt`);
        }
        if (toMs(occurred) > at + 60_000) {
          throw new HttpError(422, "future_timestamp", `${key ?? kind} 的发生时间晚于接收时间，疑似时钟错误`);
        }
      }
      prepared.push({ record, kind, key });
    }

    const envelopes = [];
    for (const item of prepared) {
      if (item.skipped) continue;
      const seq = (seqCounter += 1);
      envelopes.push({ seq, receivedAt: at, kind: item.kind, key: item.key, record: item.record });
    }
    if (envelopes.length > 0) await this.fsyncAppend(envelopes);
    for (const envelope of envelopes) this.index(envelope);
    return {
      receivedAt: at,
      accepted: envelopes.map((e) => ({ id: e.key ?? `seq:${e.seq}`, kind: e.kind })),
      duplicates: prepared.filter((p) => p.skipped).map((p) => p.key),
    };
  }

  async fsyncAppend(envelopes) {
    await mkdir(this.dir, { recursive: true });
    const text = envelopes.map((e) => JSON.stringify(e)).join("\n") + "\n";
    // 整批一次 append + fsync；单行 JSON 写入长度远小于管道原子写上限，
    // 进程崩溃最多丢掉最后半行（启动时会因损坏行拒绝继续，防止静默丢数据）。
    const handle = await open(this.logPath, "a");
    try {
      await handle.appendFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  findIdempotent(key) {
    return this.idempotency.get(key);
  }

  // 返回时刻 t 的只追加视图：外部只能通过它读取，杜绝误用未来数据。
  viewAt(t) {
    const visible = this.entries.filter((e) => e.receivedAt <= t);
    return new LogView(visible, t);
  }

  latest() {
    return this.viewAt(this.clock.now());
  }
}

export class LogView {
  constructor(entries, asOf) {
    this.entries = entries;
    this.asOf = asOf;
  }

  byKind(kind) {
    return this.entries.filter((e) => e.kind === kind).map((e) => e.record);
  }
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonSame(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateShape(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new HttpError(400, "bad_record", "每条记录必须是 JSON 对象");
  }
}

// 供引导装载使用：种子文件里的静态资料若缺 receivedAt，视为始终已知（receivedAt=0）。
export function seedReceivedAt(record) {
  return record.receivedAt ?? record.occurredAt ?? record.at ?? 0;
}

export async function bootstrap(store, seedRecords) {
  const now = store.clock.now();
  // 仅当日志为空时灌入种子，重启不重复导入。
  if (store.entries.length > 0) return { seeded: 0, skipped: true };
  const byTime = new Map();
  for (const record of seedRecords) {
    const at = toMs(seedReceivedAt(record));
    const safeAt = Number.isFinite(at) ? Math.min(at, now) : 0;
    if (!byTime.has(safeAt)) byTime.set(safeAt, []);
    byTime.get(safeAt).push(record);
  }
  let accepted = 0;
  for (const [at, batch] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
    const result = await store.appendBatchLocked(batch, at);
    accepted += result.accepted.length;
  }
  return { seeded: accepted, skipped: false };
}
