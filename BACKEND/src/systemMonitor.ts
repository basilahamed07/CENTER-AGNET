import os from 'os';

let previousCpu = os.cpus();

export interface SystemResources {
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
  processCount: number;
}

export function sampleSystemResources(processCount: number): SystemResources {
  const current = os.cpus();
  let idleDelta = 0;
  let totalDelta = 0;

  for (let index = 0; index < current.length; index += 1) {
    const now = current[index]?.times;
    const prev = previousCpu[index]?.times;
    if (!now || !prev) continue;
    const nowTotal = now.user + now.nice + now.sys + now.idle + now.irq;
    const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
    idleDelta += now.idle - prev.idle;
    totalDelta += nowTotal - prevTotal;
  }

  previousCpu = current;
  const memoryTotal = os.totalmem();
  const memoryUsed = memoryTotal - os.freemem();
  const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;

  return {
    cpuPercent,
    memoryUsed,
    memoryTotal,
    memoryPercent: memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0,
    processCount,
  };
}
