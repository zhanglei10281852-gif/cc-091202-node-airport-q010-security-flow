# 航站楼安检客流调配决策台

节假日高峰下，当班经理用它把**各安检区的匿名队列观测、通道处理能力、员工岗位资质、换岗步行时间、未来出港波次**合并成滚动判断；系统在每个决策时刻给出开闭通道 / 跨区支援 / 维持现状的建议，说明预期等待改善与被牺牲区域；经理接受后生成**有时限的调配指令**，员工确认到岗才改变有效能力。

全部数据为匿名聚合：只有队列长度、匿名员工编号（`staff-anon-*`）与设备编号，不采集、不返回任何单个旅客身份。

## 核心规则

- **时间双轨**：每条观测记录 `occurredAt`（现场发生）与 `receivedAt`（系统接收）。任何历史时刻 `asOf` 的判断只能看到 `receivedAt <= asOf` 的信息，07:31 才到达的更正不会出现在 07:25 的重放里。
- **迟到更正**：`corrects` 指向被更正的观测；更正到达后原值从“当时可见”视图中移除，原值仍保留在审计视图（`?view=audit`）中。
- **数据可信度**：每个区域标注 `fresh / fair / stale / low-confidence / missing`；观测陈旧时用波次到达与当前能力滚动推算队列，并明确说明是推算值。
- **建议类型**：
  - `OPEN_LANE`：由本区/备勤人力开启关闭中的通道；
  - `CROSS_ZONE_SUPPORT`：从空闲区抽人，附**被牺牲区域**（原通道关闭后的峰值等待、新增等待）；
  - `CLOSE_LANE`：只回收临时增开（指令或人工开启）的通道，**不因短暂空闲关闭基线通道**，避免频繁开关制造新拥堵；
  - `HOLD`：维持现状；紧张但无可行资源时给出 `holdReason: no-feasible-resource`。
- **硬性禁止（只出现在 `screenedOut`，绝不自动建议）**：
  - 资质不满足通道要求；
  - 与法定休息窗冲突；
  - 步行后无法在指令时限内到岗；
  - 抽人后被牺牲区域峰值等待超过阈值（默认 12 分钟）；
  - 已在未结束指令中的员工（不重复派人）。
- **指令生命周期**：`dispatched → active`（员工确认到岗才生效），分支 `rejected`（拒绝）、`expired`（超过到岗时限未确认）、`withdrawn`（经理中途撤回）、`completed`（到达时限正常结束）。跨区支援者**接受即离岗**，原通道步行期间即关闭；目标通道等到岗才开；拒绝/超时/撤回后能力自动回落。
- **不重复派人**：幂等键 + 目标通道自然键双重去重，所有写入经单进程串行队列执行，状态原子落盘，重启恢复。

## 运行

```bash
npm test          # Node.js 内置测试运行器（19 个用例）
npm start         # 默认加载 fixtures/holiday-peak.json，状态落盘到 ./data/state.json
PORT=3000 npm start
CONTEXT_FILE=/path/to/context.json STATE_FILE=/data/state.json npm start
docker compose up --build   # APP_PORT 可配置宿主端口
```

健康探针：`GET /health`。

## HTTP 接口

所有接口支持 `?asOf=<ISO8601>`：不传则为当前时刻。历史时刻只回放**当时已接收**的数据。

| 方法 路径 | 作用 |
|---|---|
| `GET /api/context` | 通道能力、步行矩阵、员工资质/休息窗、出港波次（匿名） |
| `POST /api/observations` | 接入观测（可批量）；重复 `observationId` 幂等忽略；支持迟到 `receivedAt` 与 `corrects` |
| `GET /api/observations[?asOf=&view=audit]` | 截至时刻已应用更正链的可见观测；审计视图含入库延迟 |
| `GET /api/snapshot?asOf=` | 当时数据可信度、推算队列、当前等待、当前有效能力、窗口内波次 |
| `GET /api/recommend?asOf=&horizonMin=40` | 每区一条建议：动作、到岗时间、预期等待改善、被牺牲区域、被筛除人力及原因 |
| `POST /api/assignments` | 经理接受建议生成有时限指令（建议在服务端按当时数据重算，体：`zone/lane/asOf/ttlMin/idempotencyKey`） |
| `GET /api/assignments` | 指令列表与按时刻推导的状态、事件时间线 |
| `POST /api/assignments/:id/respond` | 员工动作 `{action:"arrive"|"reject", at}`；晚于到岗时限返回 409 并按超时关闭 |
| `POST /api/assignments/:id/withdraw` | 经理中途撤回，能力立即回落 |
| `POST /api/overrides` / `POST /api/overrides/:id/revoke` / `GET /api/overrides` | 有时限的人工开关通道覆盖 |
| `GET /api/replay?asOf=` | 历史重放：当时快照与建议 + 当时不可见的迟到信息清单 + 窗口内实际等待与建议对比 |

### 典型流程（样例时间 2026-09-12，时区 +08:00）

```bash
# 07:25：东区排队，更正（obs-41-r1）要 07:31 才到，系统只用原值 86 判断
curl 'localhost:3000/api/recommend?asOf=2026-09-12T07:25:00%2B08:00'
# → CROSS_ZONE_SUPPORT：T1-WEST 的 staff-anon-22 步行 6 分钟开 E-03，
#   西区峰值等待仅 0.2 分钟（被牺牲但安全）；
#   staff-anon-32 资质不足、staff-anon-21 法定休息冲突，仅出现在 screenedOut。

# 经理接受（幂等键防重复下单）
curl -XPOST localhost:3000/api/assignments -H 'content-type: application/json' -d '{
  "asOf":"2026-09-12T07:25:00+08:00","zone":"T1-EAST","lane":"E-03","idempotencyKey":"mgr-1"
}'

# 员工确认到岗后，东区能力 6.2 → 9.4，西区 8.8 → 5.8（其原通道 W-02 关闭）
curl -XPOST localhost:3000/api/assignments/asg-xxx/respond -H 'content-type: application/json' \
  -d '{"action":"arrive","at":"2026-09-12T07:34:00+08:00"}'

# 事后重放 07:25，核对当时建议与实际等待
curl 'localhost:3000/api/replay?asOf=2026-09-12T07:25:00%2B08:00'
```

08:02 备勤 `staff-anon-12`（08:10 可用）变为可行，建议转为不牺牲别区的 `OPEN_LANE`。

## 代码结构

```
src/domain/
  clock.js        决策参数（阈值、窗口、时限）与时间工具
  context.js      静态资料装载、步行最短路径、波次均匀到达摊派、休息冲突
  observations.js 追加式观测日志：点时刻可见性与更正链
  snapshot.js     可信度标注 + 陈旧观测滚动推算
  simulate.js     逐分钟排队仿真（动作前后两套能力曲线对比）
  engine.js       候选枚举 → 硬约束筛除 → 仿真比选 → 建议与牺牲说明
  state.js        指令生命周期、有效能力推导、人工覆盖、幂等、原子持久化
  replay.js       任意历史时刻重放与“建议 vs 实际等待”对比
src/app.js        HTTP 路由（写入串行化、字段白名单）
src/server.js     启动入口 / buildServer
fixtures/         holiday-peak.json 完整样例；context.json 原始小样本保留可解析
```

## 边界与取舍

- 队列按聚合人数滚动建模，不建模旅客个体；波次在到达区间内均匀摊派。
- 阈值（紧张 12/15 分钟、被牺牲区上限 12 分钟、判断窗口 40 分钟、指令时限 40 分钟等）集中在 `src/domain/clock.js`。
- 生产传感器地址、真实人员身份与排班凭据不得提交；持久化文件默认在容器 `/data` 卷。
