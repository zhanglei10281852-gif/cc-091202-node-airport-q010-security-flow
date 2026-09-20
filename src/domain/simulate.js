// 单步排队仿真：队列按波次均匀到达，按当时有效通道能力消化，不做旅客个体建模。
import { MINUTE, STEP_MIN } from "./clock.js";
import { waveArrivals } from "./context.js";

// capacityAt(zone, timeMs) 返回该时刻开放通道的总 passengersPerMinute。
// initial: Map<zone, number>。返回每分钟一步的轨迹。
export function simulate(context, { start, end, initial, capacityAt, stepMin = STEP_MIN }) {
  const step = stepMin * MINUTE;
  const zones = context.zones;
  let queues = new Map(zones.map((z) => [z, initial.get(z) ?? 0]));
  const trajectory = [];
  for (let t = start; t <= end; t += step) {
    const row = { at: t, zones: {} };
    for (const z of zones) {
      const cap = Math.max(0, capacityAt(z, t) ?? 0);
      const q = queues.get(z) ?? 0;
      row.zones[z] = {
        queue: q,
        capacity: cap,
        waitMin: cap > 0 ? q / cap : q > 0 ? Infinity : 0,
      };
    }
    trajectory.push(row);
    if (t === end) break;
    const next = Math.min(t + step, end);
    const arrivals = waveArrivals(context, t, next);
    const dtMin = (next - t) / MINUTE;
    for (const z of zones) {
      const cap = Math.max(0, capacityAt(z, next) ?? 0);
      const q = queues.get(z) ?? 0;
      const nextQ = Math.max(0, q + (arrivals[z] ?? 0) - cap * dtMin);
      queues.set(z, nextQ);
    }
  }
  return trajectory;
}

export function summarizeTrajectory(trajectory) {
  const byZone = {};
  for (const row of trajectory) {
    for (const [z, point] of Object.entries(row.zones)) {
      const s = (byZone[z] ??= {
        peakQueue: 0,
        peakWaitMin: 0,
        endQueue: 0,
        endWaitMin: 0,
        clearAt: null,
      });
      if (point.queue > s.peakQueue) s.peakQueue = point.queue;
      if (Number.isFinite(point.waitMin) && point.waitMin > s.peakWaitMin) s.peakWaitMin = point.waitMin;
      s.endQueue = point.queue;
      s.endWaitMin = point.waitMin;
      if (point.queue <= 0.5 && s.clearAt === null && row.at !== trajectory[0].at) s.clearAt = row.at;
    }
  }
  return byZone;
}
