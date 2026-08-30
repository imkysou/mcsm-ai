import { overviewInfo } from "@/services/apis";
import { createGlobalState } from "@vueuse/core";
import { ref, type Ref } from "vue";

export interface ComputedOverviewResponse extends IPanelOverviewResponse {
  totalInstance: number;
  runningInstance: number;
  cpu: number;
  mem: number;
  remote: ComputedNodeInfo[];
}

export interface ComputedNodeInfo extends IPanelOverviewRemoteResponse {
  platformText?: string;
  cpuInfo?: string;
  instanceStatus?: string;
  memText?: string;
  cpuChartData?: number[];
  memChartData?: number[];
}

function computeResponseData(v: Ref<IPanelOverviewResponse | undefined>) {
  const currentState = v.value as ComputedOverviewResponse;

  let totalInstance = 0;
  let runningInstance = 0;
  for (const iterator of currentState.remote || []) {
    if (iterator.instance) {
      totalInstance += iterator.instance.total;
      runningInstance += iterator.instance.running;
    }
  }

  currentState.totalInstance = totalInstance;
  currentState.runningInstance = runningInstance;

  let cpu = Number(currentState.system.cpu * 100).toFixed(0);
  let mem = Number((currentState.system.freemem / currentState.system.totalmem) * 100).toFixed(0);

  currentState.cpu = Number(cpu);
  currentState.mem = Number(mem);

  const newNodes = v.value?.remote as ComputedNodeInfo[] | undefined;
  if (newNodes) {
    for (let node of newNodes) {
      if (!node.system || !node.instance || !node.cpuMemChart) continue;
      const free = Number(node.system.freemem / 1024 / 1024 / 1024).toFixed(1);
      const total = Number(node.system.totalmem / 1024 / 1024 / 1024).toFixed(1);
      const used = Number(Number(total) - Number(free)).toFixed(1);
      node.platformText =
        node?.system?.platform == "win32" ? "windows" : node?.system?.platform || "--";
      node.instanceStatus = `${node.instance.running} / ${node.instance.total}`;
      node.cpuInfo = `${Number(node.system.cpuUsage * 100).toFixed(1)}%`;
      node.memText = `${used}G / ${total}G`;
      node.cpuChartData = node?.cpuMemChart.map((v) => v.cpu);
      node.memChartData = node?.cpuMemChart.map((v) => v.mem);
    }
  }
  return currentState;
}

/**
 * Global single-instance overview poller.
 * Multiple cards (SystemResource, PanelOverview, ...) share ONE 3s poll loop
 * instead of each component spawning its own interval + backend request.
 * Lifetime is page-level: polling starts once and keeps running while the
 * app is open, which is cheaper than per-card intervals.
 */
export const useOverviewInfo = createGlobalState(() => {
  const result = overviewInfo();

  const newState = ref<ComputedOverviewResponse>();

  const refresh = async (forceRequest = false) => {
    newState.value = computeResponseData(
      await result.execute({
        forceRequest
      })
    );
    return newState.value;
  };

  refresh();
  setInterval(async () => {
    await refresh();
  }, 3000);

  return {
    ...result,
    state: newState,
    refresh,
    execute: null
  };
});
