<script setup lang="ts">
import CardPanel from "@/components/CardPanel.vue";
import { useOverviewInfo } from "@/hooks/useOverviewInfo";
import { t } from "@/lang/i18n";
import type { LayoutCard } from "@/types";
import { init, type ECharts } from "echarts";
import { getRandomId } from "@/tools/randId";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

defineProps<{
  card: LayoutCard;
}>();

const { state } = useOverviewInfo();

const domId = getRandomId();
const cpuRingId = "sysres-cpu-ring-" + domId;
const memRingId = "sysres-mem-ring-" + domId;
const netChartId = "sysres-net-chart-" + domId;

let cpuChart: ECharts | undefined;
let memChart: ECharts | undefined;
let netChart: ECharts | undefined;

/** localStorage key that persists the user-selected network interface. */
const NET_INTERFACE_STORAGE_KEY = "sysres-net-interface";

// Keep a rolling buffer of network samples so the line chart draws a trend.
const netSamples = ref<{ time: string; in: number; out: number }[]>([]);

/** Selected network interface name; "auto" = aggregate all physical interfaces. */
const selectedInterface = ref<string>(getStoredInterface());

/** Previous cumulative bytes + timestamp used to derive per-interface rates on the client. */
let lastNetSample: { time: number; inBytes: number; outBytes: number } | null = null;

function getStoredInterface(): string {
  try {
    const v = window.localStorage.getItem(NET_INTERFACE_STORAGE_KEY);
    return v ?? "auto";
  } catch {
    return "auto";
  }
}

function storeInterface(name: string) {
  try {
    window.localStorage.setItem(NET_INTERFACE_STORAGE_KEY, name);
  } catch {
    // localStorage may be unavailable (private mode / iframe); ignore.
  }
}

const cpuPercent = computed<number>(() => {
  const cpu = state.value?.system?.cpu;
  return Math.min(100, Math.max(0, Math.round(Number(cpu ?? 0) * 100)));
});

const cpus = computed<number[]>(() => {
  const list = state.value?.system?.cpus;
  if (!list || !Array.isArray(list) || list.length === 0) return [];
  return list.map((v) => Math.min(100, Math.max(0, Math.round(Number(v ?? 0)))));
});

const memPercent = computed<number>(() => {
  const total = Number(state.value?.system?.totalmem ?? 0);
  const free = Number(state.value?.system?.freemem ?? 0);
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(((total - free) / total) * 100)));
});

const memUsedGb = computed<number>(() => {
  const total = Number(state.value?.system?.totalmem ?? 0);
  const free = Number(state.value?.system?.freemem ?? 0);
  return Number(((total - free) / 1024 / 1024 / 1024).toFixed(1));
});

const memTotalGb = computed<number>(() => {
  return Number((Number(state.value?.system?.totalmem ?? 0) / 1024 / 1024 / 1024).toFixed(1));
});

interface NetInterfaceInfo {
  name: string;
  rxBytes: number;
  txBytes: number;
}

/** Physical interfaces reported by the backend. */
const netInterfaces = computed<NetInterfaceInfo[]>(() => {
  const list = state.value?.system?.netInterfaces;
  if (!list || !Array.isArray(list)) return [];
  return list.filter((v) => v && typeof v.name === "string");
});

/** Options for the interface selector: "auto" plus every physical interface. */
const netOptions = computed<{ value: string; label: string }[]>(() => [
  { value: "auto", label: t("TXT_CODE_SYS_NET_AUTO") },
  ...netInterfaces.value.map((v) => ({ value: v.name, label: v.name }))
]);

/** Currently effective interface name: stored choice if still available, else "auto". */
const effectiveInterface = computed<string>(() => {
  const sel = selectedInterface.value;
  if (sel !== "auto" && netInterfaces.value.some((v) => v.name === sel)) return sel;
  return "auto";
});

/** Cumulative bytes of the effective interface (or the sum of all physical ones). */
const effectiveBytes = computed<{ inBytes: number; outBytes: number }>(() => {
  const list = netInterfaces.value;
  if (list.length === 0) return { inBytes: 0, outBytes: 0 };
  const sel = effectiveInterface.value;
  if (sel === "auto") {
    return {
      inBytes: list.reduce((sum, v) => sum + v.rxBytes, 0),
      outBytes: list.reduce((sum, v) => sum + v.txBytes, 0)
    };
  }
  const target = list.find((v) => v.name === sel);
  if (!target) return { inBytes: 0, outBytes: 0 };
  return { inBytes: target.rxBytes, outBytes: target.txBytes };
});

// Current rates displayed in the stat chips; computed client-side from byte deltas.
const lastNetRate = ref<{ in: number; out: number }>({ in: 0, out: 0 });
const netInRate = computed<number>(() => lastNetRate.value.in);
const netOutRate = computed<number>(() => lastNetRate.value.out);

function formatRate(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + " MB/s";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB/s";
  return bytes.toFixed(0) + " B/s";
}

function computeRate(current: number, previous: number, elapsedSec: number): number {
  if (elapsedSec < 1) return 0;
  const delta = current - previous;
  if (delta < 0) return 0; // counter reset / wrap-around
  return Math.round(delta / elapsedSec);
}

/**
 * Client-side rate derivation so switching interface updates the chart immediately.
 * - Skips sampling while no interface data is available (avoids a fake baseline).
 * - The first sample with data only establishes the byte baseline (no zero point
 *   pushed to the chart, so the line does not start with an artificial 0).
 * - Gas-throttled to ~10s to match the low-frequency backend refresh (the
 *   backend reads interface counters every 10s to keep CPU usage low); sampling
 *   faster than that would only add 0-value points and extra chart renders.
 */
let lastNetSampleTime = 0;
function pushNetSample() {
  if (netInterfaces.value.length === 0) return;

  const bytes = effectiveBytes.value;
  const now = Date.now();

  if (!lastNetSample) {
    lastNetSample = { time: now, inBytes: bytes.inBytes, outBytes: bytes.outBytes };
    lastNetSampleTime = now;
    lastNetRate.value = { in: 0, out: 0 };
    return;
  }

  // Only push a new point (and re-render) every ~8s.
  if (now - lastNetSampleTime < 8000) return;

  const elapsedSec = (now - lastNetSample.time) / 1000;
  const inRate = computeRate(bytes.inBytes, lastNetSample.inBytes, elapsedSec);
  const outRate = computeRate(bytes.outBytes, lastNetSample.outBytes, elapsedSec);
  lastNetSample = { time: now, inBytes: bytes.inBytes, outBytes: bytes.outBytes };
  lastNetSampleTime = now;
  lastNetRate.value = { in: inRate, out: outRate };

  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  netSamples.value.push({ time, in: inRate, out: outRate });
  if (netSamples.value.length > 30) netSamples.value.shift();
}

/** Called when the user picks another interface: persist it and reset the baseline. */
function onInterfaceChange(value: unknown) {
  const name = String(value ?? "auto");
  selectedInterface.value = name;
  storeInterface(name);
  lastNetSample = null; // restart the byte baseline for the new selection
  lastNetSampleTime = 0;
  lastNetRate.value = { in: 0, out: 0 };
  pushNetSample();
  renderNetChart();
}

const cpuBarColor = (p: number) =>
  p > 80 ? "var(--color-danger)" : p > 50 ? "var(--color-warning)" : "var(--color-success)";

function makeRingOption(percent: number, color: string): Record<string, any> {
  return {
    series: [
      {
        type: "pie",
        radius: ["68%", "86%"],
        silent: true,
        label: { show: false },
        labelLine: { show: false },
        startAngle: 90,
        data: [
          { value: percent, name: "used", itemStyle: { color } },
          { value: Math.max(0, 100 - percent), name: "free", itemStyle: { color: "rgba(148,163,184,0.12)" } }
        ]
      }
    ]
  };
}

function renderCpuRing() {
  if (!cpuChart) return;
  cpuChart.setOption(makeRingOption(cpuPercent.value, "#1677ff"));
}

function renderMemRing() {
  if (!memChart) return;
  memChart.setOption(makeRingOption(memPercent.value, "#722ed1"));
}

/** Friendly y-axis upper bound: at least 1 KB/s, with 20% headroom above the peak. */
function netChartYMax(): number {
  const all = netSamples.value.flatMap((v) => [v.in, v.out]);
  if (all.length === 0) return 1024;
  const peak = Math.max(...all, 0);
  return Math.max(1024, Math.ceil((peak * 1.2) / 1024) * 1024);
}

function renderNetChart() {
  if (!netChart) return;
  netChart.setOption({
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(20, 24, 35, 0.85)",
      borderColor: "rgba(67, 145, 250, 0.3)",
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: "#e0e6f0", fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: "rgba(67,145,250,0.4)", width: 1, type: "dashed" } },
      formatter: (params: any) => {
        const arr = Array.isArray(params) ? params : [params];
        let html = arr[0]?.axisValue ? `<span style="color:#94b8e0;font-size:11px">${arr[0].axisValue}</span><br/>` : "";
        for (const p of arr) {
          const color = p.color || "#fff";
          const name = p.seriesName || p.name || "";
          html += `<span style="color:${color};font-size:11px">${name}: </span><span style="font-weight:600;font-size:13px">${formatRate(Number(p.value))}</span><br/>`;
        }
        return html;
      }
    },
    grid: { show: false, borderWidth: 0, top: 8, bottom: 24, left: 8, right: 8 },
    xAxis: {
      type: "category",
      boundaryGap: false,
      axisLabel: { fontSize: 10, color: "rgba(160,180,210,0.7)", margin: 6 },
      axisLine: { show: true, lineStyle: { color: "rgba(100,130,180,0.2)" } },
      axisTick: { show: false }
    },
    yAxis: {
      type: "value",
      min: 0,
      max: netChartYMax(),
      axisLabel: {
        fontSize: 10,
        color: "rgba(160,180,210,0.7)",
        formatter: (v: number) => formatRate(v).replace("\/s", "")
      },
      splitLine: { show: true, lineStyle: { color: "rgba(100,130,180,0.12)", type: "dashed", width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    series: [
      {
        name: t("TXT_CODE_SYS_NET_DOWN"),
        type: "line",
        smooth: 0.6,
        showSymbol: false,
        lineStyle: { color: "#52c41a", width: 1.8, shadowColor: "rgba(52,196,26,0.25)", shadowBlur: 6 },
        areaStyle: { color: "rgba(52,196,26,0.12)" },
        data: netSamples.value.map((v) => v.in)
      },
      {
        name: t("TXT_CODE_SYS_NET_UP"),
        type: "line",
        smooth: 0.6,
        showSymbol: false,
        lineStyle: { color: "#1677ff", width: 1.8, shadowColor: "rgba(22,119,255,0.25)", shadowBlur: 6 },
        areaStyle: { color: "rgba(22,119,255,0.12)" },
        data: netSamples.value.map((v) => v.out)
      }
    ]
  });
}

onMounted(async () => {
  await nextTick();
  cpuChart = init(document.getElementById(cpuRingId) as HTMLDivElement);
  memChart = init(document.getElementById(memRingId) as HTMLDivElement);
  netChart = init(document.getElementById(netChartId) as HTMLDivElement);
  renderCpuRing();
  renderMemRing();
  renderNetChart();
});

// Once the interface list is known, correct a stale stored choice (e.g. the
// interface no longer exists after a host configuration change).
watch(
  netInterfaces,
  (list) => {
    const sel = selectedInterface.value;
    if (sel !== "auto" && !list.some((v) => v.name === sel)) {
      selectedInterface.value = "auto";
      lastNetSample = null;
      lastNetSampleTime = 0;
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  cpuChart?.dispose();
  memChart?.dispose();
  netChart?.dispose();
  cpuChart = undefined;
  memChart = undefined;
  netChart = undefined;
});

watch([cpuPercent, memPercent], () => {
  renderCpuRing();
  renderMemRing();
});

watch(state, () => {
  pushNetSample();
});

// Re-render the net chart only when a new sample is actually pushed (throttled).
watch(netSamples, () => {
  renderNetChart();
}, { deep: true });
</script>

<template>
  <CardPanel class="SystemResource" style="height: 100%">
    <template #title>{{ card.title }}</template>
    <template #body>
      <div class="sysres">
        <!-- CPU -->
        <div class="sysres-block">
          <div class="sysres-block__title">
            <span class="sysres-block__dot sysres-block__dot--cpu"></span>
            <span>CPU</span>
          </div>
          <div class="sysres-chart-wrap">
            <div :id="cpuRingId" class="sysres-ring"></div>
            <div class="sysres-ring-center">
              <span class="sysres-ring-center__value">{{ cpuPercent }}%</span>
              <span class="sysres-ring-center__label">{{ t("TXT_CODE_SYS_CPU") }}</span>
            </div>
          </div>
          <div class="sysres-cores">
            <div v-for="(core, i) in cpus" :key="i" class="sysres-core" :title="`Core ${i + 1}: ${core}%`">
              <span class="sysres-core__label">{{ i + 1 }}</span>
              <div class="sysres-core__bar">
                <div class="sysres-core__bar-fill" :style="{ width: core + '%', background: cpuBarColor(core) }"></div>
              </div>
              <span class="sysres-core__value" :style="{ color: cpuBarColor(core) }">{{ core }}%</span>
            </div>
          </div>
        </div>

        <!-- Memory -->
        <div class="sysres-block">
          <div class="sysres-block__title">
            <span class="sysres-block__dot sysres-block__dot--mem"></span>
            <span>{{ t("TXT_CODE_593ee330") }}</span>
          </div>
          <div class="sysres-chart-wrap">
            <div :id="memRingId" class="sysres-ring"></div>
            <div class="sysres-ring-center">
              <span class="sysres-ring-center__value">{{ memPercent }}%</span>
              <span class="sysres-ring-center__label">{{ t("TXT_CODE_SYS_MEM_USED") }}</span>
            </div>
          </div>
          <div class="sysres-mem-detail">
            <span>{{ t("TXT_CODE_SYS_MEM_USED_TOTAL") }}</span>
            <span class="sysres-mem-detail__value">{{ memUsedGb }} GB / {{ memTotalGb }} GB</span>
          </div>
        </div>

        <!-- Network -->
        <div class="sysres-block sysres-block--net">
          <div class="sysres-block__title sysres-block__title--net">
            <span class="sysres-block__dot sysres-block__dot--net"></span>
            <span>{{ t("TXT_CODE_SYS_NETWORK") }}</span>
            <a-select
              v-model:value="selectedInterface"
              size="small"
              class="sysres-net-select"
              :options="netOptions"
              :dropdown-match-select-width="false"
              @change="onInterfaceChange"
            ></a-select>
          </div>
          <div class="sysres-net-stats">
            <div class="sysres-net-stat">
              <span class="sysres-net-stat__dot sysres-net-stat__dot--down"></span>
              <span class="sysres-net-stat__label">{{ t("TXT_CODE_SYS_NET_DOWN") }}</span>
              <span class="sysres-net-stat__value">{{ formatRate(netInRate) }}</span>
            </div>
            <div class="sysres-net-stat">
              <span class="sysres-net-stat__dot sysres-net-stat__dot--up"></span>
              <span class="sysres-net-stat__label">{{ t("TXT_CODE_SYS_NET_UP") }}</span>
              <span class="sysres-net-stat__value">{{ formatRate(netOutRate) }}</span>
            </div>
          </div>
          <div :id="netChartId" class="sysres-net-chart"></div>
        </div>
      </div>
    </template>
  </CardPanel>
</template>

<style lang="scss" scoped>
.SystemResource {
  position: relative;
}

.sysres {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  height: 100%;

  @media (max-width: 1100px) {
    grid-template-columns: 1fr;
  }
}

.sysres-block {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.01));
  border: 1px solid rgba(100, 120, 160, 0.12);
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  min-width: 0;

  &__title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--color-gray-9);
    margin-bottom: 10px;
  }

  &__title--net {
    margin-bottom: 6px;
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    box-shadow: 0 0 8px currentColor;

    &--cpu {
      background: var(--color-primary);
      color: var(--color-primary);
    }
    &--mem {
      background: var(--color-purple-6);
      color: var(--color-purple-6);
    }
    &--net {
      background: var(--color-success);
      color: var(--color-success);
    }
  }
}

.sysres-net-select {
  margin-left: auto;
  width: 128px;
  font-size: 12px;
}

.sysres-chart-wrap {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 150px;
}

.sysres-ring {
  width: 150px;
  height: 150px;
}

.sysres-ring-center {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;

  &__value {
    font-size: 26px;
    font-weight: 700;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  &__label {
    margin-top: 6px;
    font-size: 11px;
    color: var(--color-gray-6);
  }
}

.sysres-cores {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 6px 8px;
  margin-top: 6px;
  max-height: 92px;
  overflow: hidden;
}

.sysres-core {
  display: flex;
  align-items: center;
  gap: 5px;

  &__label {
    font-size: 10px;
    color: var(--color-gray-6);
    width: 16px;
    flex-shrink: 0;
  }

  &__bar {
    flex: 1;
    height: 6px;
    background: rgba(148, 163, 184, 0.14);
    border-radius: 4px;
    overflow: hidden;

    /* fixed width for the fill so the bar never collapses */
    &-fill {
      height: 100%;
      border-radius: 4px;
      min-width: 2px;
      transition: width 0.4s ease;
    }
  }

  &__value {
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    width: 26px;
    text-align: right;
    flex-shrink: 0;
  }
}

.sysres-mem-detail {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: auto;
  padding-top: 10px;
  font-size: 12px;
  color: var(--color-gray-6);

  &__value {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--color-gray-8);
  }
}

.sysres-block--net {
  .sysres-net-chart {
    flex: 1;
    min-height: 150px;
    width: 100%;
  }
}

.sysres-net-stats {
  display: flex;
  gap: 12px;
  margin-bottom: 6px;
}

.sysres-net-stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;

    &--down {
      background: var(--color-success);
    }
    &--up {
      background: var(--color-primary);
    }
  }

  &__label {
    color: var(--color-gray-6);
  }

  &__value {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--color-gray-8);
  }
}
</style>
