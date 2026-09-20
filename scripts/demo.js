// 端到端叙事演示：节假日高峰 → 建议 → 接受 → 确认到岗 → 能力改变 → 事后重放。
// 运行：npm run demo
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { BitemporalStore, bootstrap } from "../src/domain/store.js";
import { VirtualClock } from "../src/domain/clock.js";
import { CommandService } from "../src/domain/commands.js";
import { evaluateView } from "../src/domain/decision.js";
import { rulesAt } from "../src/domain/rules.js";
import { replayDecision, compareOutcomes } from "../src/domain/replay.js";
import { buildWorld } from "../src/domain/snapshot.js";
import { staffedCapacity } from "../src/domain/forecast.js";
import { toMs, isoCn } from "../src/domain/time.js";

const T = (s) => toMs(`2026-09-12T${s}+08:00`);
const line = () => console.log("─".repeat(72));

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flow-demo-"));
  const clock = new VirtualClock(T("07:40:00"));
  const store = new BitemporalStore({ dir, clock });
  await store.load();
  const scenario = JSON.parse(await readFile(new URL("../fixtures/scenario-holiday.json", import.meta.url), "utf8"));
  await bootstrap(store, scenario.records);
  const commands = new CommandService(store, clock);

  console.log("场景：", scenario.scenario);
  line();

  // 1) 07:25 重放：迟到更正尚未到达
  console.log("【1】07:25 值班经理看到的东区队列（更正 07:31 才到）：");
  const r0725 = replayDecision(store, T("07:25:00"));
  const east25 = r0725.evaluation.zones.find((z) => z.zone === "T1-EAST");
  console.log(`  队列=${east25.dataQuality.latest.queue}  可信度=${east25.dataQuality.trustLevel}  规则版本=${r0725.rulesVersion}`);
  console.log("  → 系统不允许把 11 分钟后才收到的更正伪装成当时已知信息。");

  // 2) 07:40 滚动评估
  line();
  const at = T("07:40:00");
  const evaluation = evaluateView(store.viewAt(at), at, rulesAt(at));
  console.log("【2】07:40 滚动评估：");
  for (const z of evaluation.zones) {
    const f = z.dataQuality;
    console.log(
      `  ${z.zone}  队列=${z.forecast.queueNow}  预测峰值等待=${z.forecast.maxWaitMin ?? "∞"} 分  ` +
        `可信度=${f.trustLevel}${f.flags.length ? `(${f.flags.join(",")})` : ""}`,
    );
  }
  const rec = evaluation.recommendation;
  console.log(`  建议：${rec.type} 开启 ${rec.action.zone}/${rec.action.lane}`);
  console.log(`  人力：从 ${rec.action.fromZone} 借调 ${rec.action.assignees.join("、")}`);
  console.log(`  岗位：${rec.action.roles.join(" / ")}（与被派人一一对应，资质与休息均已校验）`);
  console.log(`  步行 ${rec.action.walkMin} 分钟，预计 ${isoCn(rec.earliestEffectiveAt)} 起效`);
  console.log(
    `  预期改善：峰值等待 ${rec.expected.targetMaxWaitBefore} → ${rec.expected.targetMaxWaitAfter} 分，` +
      `减少等待 ${rec.expected.gainPassengerMinutes} 人·分钟`,
  );
  for (const s of rec.sacrificed) {
    console.log(`  被牺牲区域 ${s.zone}：峰值等待 ${s.maxWaitBefore ?? "-"} → ${s.maxWaitAfter ?? "-"} 分（受出借保护阈值约束）`);
  }

  // 3) 接受建议（带 Idempotency-Key）
  line();
  console.log("【3】经理接受建议（Idempotency-Key=demo-accept-1）：");
  const accepted = await commands.accept({ recommendationId: rec.recommendationId, idempotencyKey: "demo-accept-1", asOf: at });
  const cmd = accepted.command;
  console.log(`  指令 ${cmd.commandId}`);
  console.log(`  状态=${cmd.status}；确认截止=${isoCn(cmd.confirmDeadline)}；时限至=${isoCn(cmd.validUntil)}`);
  console.log(`  结果说明：${cmd.consequence}`);

  const again = await commands.accept({ recommendationId: rec.recommendationId, idempotencyKey: "demo-accept-1", asOf: at });
  console.log(`  网络重试同键再提交 → duplicated=${again.duplicated}，仍是同一指令 ${again.command.commandId === cmd.commandId}`);

  // 4) 全员确认到岗
  line();
  console.log("【4】员工在 07:47 步行到岗并逐一确认：");
  for (const staffId of cmd.action.assignees) {
    const res = await commands.acknowledge(cmd.commandId, staffId, "confirm", { at: T("07:47:00") });
    console.log(`  ${staffId} 确认；当前状态=${res.command.status}`);
  }
  const capBefore = lanesAt(store, T("07:45:00"), "T1-EAST");
  const capAfter = lanesAt(store, T("07:50:00"), "T1-EAST");
  console.log(`  东区有效通道：确认前 [${capBefore}] → 确认后 [${capAfter}]（到岗才改变有效能力）`);

  // 5) 事后重放对比
  line();
  console.log("【5】08:00 事后对比 07:25 的决策：");
  const cmp = compareOutcomes(store, T("07:25:00"), T("08:00:00"));
  for (const late of cmp.lateArrivals) {
    console.log(`  决策后才到的信息：${late.key}，迟到 ${late.lagMin} 分钟`);
  }
  const eastReal = cmp.zones.find((z) => z.zone === "T1-EAST").realized;
  console.log(`  东区实际：观测样本 ${eastReal.samples} 条，实测最高队列 ${eastReal.maxObservedQueue}，隐含最高等待 ${eastReal.maxImpliedWaitMin ?? "-"} 分`);
  console.log(`  实际指令轨迹：${(cmp.commandTrace ?? []).map((c) => `${c.commandId}(${c.status})`).join("、") || "07:25 的建议当时未被接受"}`);

  line();
  console.log("【6】隐私护栏：");
  try {
    await store.appendBatch(
      [{ observationId: "leak-1", passenger: { name: "某旅客", passport: "E12345678" } }],
      { receivedAt: T("07:48:00") },
    );
  } catch (error) {
    console.log(`  含旅客身份的记录被入口拒绝：${error.status} ${error.code}`);
  }
  console.log(`  系统中员工/经理均为化名标识（如 ${cmd.action.assignees[0]}、${cmd.managerId}）。`);

  await rm(dir, { recursive: true, force: true });
}

function lanesAt(s, at, zone) {
  const world = buildWorld(s.viewAt(at), at);
  const zoneState = world.zones.get(zone);
  const eff = {
    laneIntervals: [...world.laneIntervals, ...world.overrideLaneIntervals],
    placements: world.placements,
    reservations: world.reservations,
  };
  return staffedCapacity(world, zoneState, eff, at).staffedLanes.sort().join(", ");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
