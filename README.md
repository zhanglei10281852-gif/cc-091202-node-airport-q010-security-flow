# 航站楼安检客流调配决策台

节假日高峰，值班经理面对“打电话借人 → 人到位时峰值已转移 → 频繁开关通道再添拥堵”的循环。
本服务把 **匿名队列观测（含迟到更正）、通道处理能力、员工岗位资质、换岗步行时间、未来出港波次**
合并为滚动判断，输出**开闭通道 / 跨区支援 / 维持现状**建议；经理接受后形成**有时限指令**，
员工确认到岗才改变有效能力。系统可在**任意历史时刻重放**当时所见数据与当时规则。

零第三方依赖，Node.js ≥ 20。

## 核心原则

1. **双时态（bitemporal）**：每条观测同时记录 `occurredAt`（现场发生）与 `receivedAt`（系统接收）。
   时刻 `t` 的任何判断只可见 `receivedAt <= t` 的记录——07:31 才收到的更正，不会出现在 07:25 的重放里，
   更不会伪装成当时已知信息。更正用新编号 + `corrects` 指向原观测，原值保留、不就地覆盖。
2. **数据可信度先行**：低置信度、陈旧（stale）、缺口（gap）、无数据、迟到更正、数值跳变都打标，
   数据不足时**宁可维持现状也不自动派人/收通道**。
3. **规则版本化**：阈值打包成带生效时刻的版本（见 `src/domain/rules.js`），重放历史时使用当时生效的规则。
4. **硬护栏不自动建议**：
   - 资质不符的员工不上岗（`assignees` 与 `roles` 同序一一对应）；
   - 法定/排班休息冲突不派；指令时限会被休息起点截断，过短则不派；撤回后步行走回时间也纳入；
   - 出借区预测等待超过保护阈值（`donorMaxWaitMin`）不抽人；
   - 人工强制覆盖（强制开关通道、员工暂不可派、区域暂停自动建议）优先；
   - 同一通道冷却期内不重复切换。
5. **指令确定性状态机**：`awaiting_confirmation → active → completed`，分支 `rejected / expired / revoked`。
   全员确认且不逾期才生效；任一人拒绝整单作废；逾期未齐作废并释放预占；撤回后通道立即恢复、
   支援人员走回期间出借区能力不恢复。
6. **不重复派人**：业务编号幂等 + `Idempotency-Key` + 待确认预占锁，三重保证并发观测、
   人工重复提交、服务重启都不会生成两条派人指令。
7. **隐私最小化**：只接受聚合观测与化名标识；旅客粒度、证件、联系方式等字段在入口拒绝（422），
   出口再脱敏一遍。

## 快速开始

```bash
npm test          # 35 个测试
npm run demo      # 端到端叙事演示（无需起服务）
npm start         # http://localhost:3000，首次启动自动灌入 fixtures/scenario-holiday.json
docker compose up --build   # 容器化，数据持久化到命名卷
```

健康探针：`GET /health`。样例场景时间为 2026-09-12 早高峰；实时接口按当前时钟运行，
重放接口用 `at` 指定历史时刻。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/ingest` | 批量接入记录，整批校验、原子生效；重复业务编号幂等跳过 |
| GET | `/api/decisions?asOf=` | 滚动评估：各区可信度、预测、建议、候选、被牺牲区域、维持原因 |
| POST | `/api/commands` | 接受建议（建议头/体携带 `Idempotency-Key`），接受时重新评估，拒绝过期建议 |
| POST | `/api/commands/:id/ack` | 员工 `confirm` / `reject`（带 `staffId`、`at`） |
| POST | `/api/commands/:id/revoke` | 经理中途撤回（带 `at`、可选 `reason`） |
| GET | `/api/commands?asOf=` | 指令列表与当前状态 |
| POST | `/api/overrides` | 人工覆盖：`force_lane_open/closed`、`staff_unavailable`、`suppress_recommendation` |
| GET | `/api/replay?at=` | 重放任意历史时刻的当时数据、当时规则、当时建议 |
| GET | `/api/replay/compare?decisionAt=&evaluateAt=` | 预测 vs 实际等待对比，列出决策后才到的迟到记录 |

例：

```bash
curl "http://localhost:3000/api/decisions?asOf=2026-09-12T07:40:00%2B08:00"
curl -X POST localhost:3000/api/commands \
  -H 'content-type: application/json' -H 'idempotency-key: accept-001' \
  -d '{"recommendationId":"open:E-03<-T1-WEST"}'
curl -X POST localhost:3000/api/commands/<id>/ack \
  -H 'content-type: application/json' \
  -d '{"staffId":"s-w-xray-3","event":"confirm","at":"2026-09-12T07:47:00+08:00"}'
```

## 建议输出怎么读

```jsonc
{
  "recommendation": {
    "type": "open_lane",                 // open_lane | cross_zone_support | close_lane
    "action": { "zone": "T1-EAST", "lane": "E-03", "fromZone": "T1-WEST",
                "assignees": ["…"], "roles": ["ASSIST","SCREEN","XRAY"], "walkMin": 7 },
    "expected": {
      "targetMaxWaitBefore": 22.4, "targetMaxWaitAfter": 15.48,
      "gainPassengerMinutes": 1908       // 等待工作量下降（Little 定律 ∫队列dt）
    },
    "sacrificed": [{ "zone": "T1-WEST", "maxWaitBefore": 3.25, "maxWaitAfter": 3.25 }],
    "earliestEffectiveAt": "…", "confirmDeadline": "…", "validUntil": "…",
    "dataTrust": "high"
  },
  "alternatives": [ /* 通过护栏但改善量次之 */ ],
  "rejectedCandidates": [ /* 被护栏拦下的候选及原因，如 donor_wait_protection */ ],
  "hold": { "chosen": false, "reason": null }
}
```

## 预测模型（透明、可复算）

- 按分钟离散模拟：`队列ₘ₊₁ = max(0, 队列ₘ + 到港ₘ − 实际服务能力ₘ)`。
- 到港 = 出港波次均匀到港曲线（起飞前 `leadMin` 至 `tailMin`）＋ 由近期观测斜率回归、
  并扣除已计入波次后的背景到港率；无可靠差分时用按队列负荷收缩的均衡先验。
- 实际服务能力 = 物理开放通道 ∩ 每岗有合格、在班、非休息、未被预占的员工（贪心排班）。
- 等待 = `队列 / 服务率`；改善量用队列时间面积，含已在排队的旅客。
- 跨区支援在“确认 + 步行到位”后才贡献能力，撤回后走回期间出借区不恢复。

## 数据记录类型

`observation` / `correction`（`corrects` 指向原观测）/ `lane`（通道能力与岗位构成）/
`staff`（资质、班次、休息）/ `walkTime` / `flightWave` / `override` /
`command` / `commandEvent`。完整字段见 `fixtures/scenario-holiday.json`。

## 持久化与并发

- 所有写入为单行 JSONL（`.data/events.log`，可用 `DATA_DIR` 覆盖），append + fsync；
  启动时整段重放恢复，损坏行拒绝启动以防静默丢数据。
- 写入经进程内互斥链串行化；无外部依赖，单实例部署。多实例需共享卷加文件锁（未包含）。

## 目录

```
src/domain/  time clock rules privacy store snapshot data-quality
             forecast decision commands replay   # 纯领域逻辑，全部可重放
src/http/    app serialize                         # 薄 HTTP 层
scripts/demo.js                                    # 端到端演示
fixtures/                                          # 匿名样例（含一次迟到更正）
test/                                               # node:test，35 例
```

生产传感器地址、真实人员身份与排班凭据不得提交。
