import os from "os";
import osUtils from "os-utils";
import fs from "fs";
import { exec, type ChildProcess } from "child_process";

interface IInfoTable {
  [key: string]: number;
}

/** Cumulative CPU times for a single logical core (matches os.cpus()). */
interface ICpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

interface ISystemInfo {
  cpuUsage: number;
  memUsage: number;
  totalmem: number;
  freemem: number;
  type: string;
  hostname: string;
  platform: string;
  release: string;
  uptime: number;
  cwd: string;
  processCpu: number;
  processMem: number;
  loadavg: number[];
  /** Per logical core usage percentage (0..100). Length matches os.cpus(). */
  cpus: number[];
  /** Network receive rate in bytes/second. */
  netInRate: number;
  /** Network send rate in bytes/second. */
  netOutRate: number;
  /** Per physical interface cumulative byte counters (real traffic only). */
  netInterfaces: { name: string; rxBytes: number; txBytes: number }[];
}

// System details are updated every time
const info: ISystemInfo = {
  type: os.type(),
  hostname: os.hostname(),
  platform: os.platform(),
  release: os.release(),
  uptime: os.uptime(),
  cwd: process.cwd(),
  loadavg: os.loadavg(),
  freemem: 0,
  cpuUsage: 0,
  memUsage: 0,
  totalmem: 0,
  processCpu: 0,
  processMem: 0,
  cpus: [],
  netInRate: 0,
  netOutRate: 0,
  netInterfaces: []
};

// Keep the previous cumulative CPU times so we can derive per-core deltas.
let previousCpus: ICpuTimes[] | null = null;

// Keep the previous cumulative network byte counters so we can derive transfer rates.
// -1 marks "no baseline yet": the first sampled counters only establish a baseline
// (a fresh process must never report the boot-time accumulated bytes as a rate).
let previousNetIn = -1;
let previousNetOut = -1;
let previousNetSampleTime = 0;

/**
 * Read per-core cumulative CPU times via os.cpus(). Keeps a stable core count even
 * when the reported array length changes.
 */
function readCpuTimes(): ICpuTimes[] {
  const raw = os.cpus();
  return raw.map((v) => ({
    user: v.times.user,
    nice: v.times.nice,
    sys: v.times.sys,
    idle: v.times.idle,
    irq: v.times.irq
  }));
}

/** Compute each core's usage percent from the delta between two samples. */
function computePerCoreUsage(current: ICpuTimes[], previous: ICpuTimes[] | null): number[] {
  if (!previous) return current.map(() => 0);
  return current.map((cur, i) => {
    const prev = previous[i];
    if (!prev) return 0;
    const totalDelta =
      cur.user - prev.user +
      (cur.nice - prev.nice) +
      (cur.sys - prev.sys) +
      (cur.idle - prev.idle) +
      (cur.irq - prev.irq);
    if (totalDelta <= 0) return 0;
    const usedDelta =
      cur.user - prev.user + (cur.nice - prev.nice) + (cur.sys - prev.sys) + (cur.irq - prev.irq);
    return Math.min(100, Math.round((usedDelta / totalDelta) * 100));
  });
}

/**
 * Names of virtual interfaces that must not be counted as real network traffic.
 * They are only the internal side of container/hypervisor bridges and would double
 * count the same transfer (traffic enters and exits these endpoints).
 */
const VIRTUAL_IF_PATTERN = /^(lo|veth|docker|br-|virbr|vnet|tun|tap|kube|flannel|cni|tailscale|wg|zt|vmnet|vbox|utun|utun[0-9])/i;

/**
 * Read cumulative byte counters of every network interface on Linux.
 * Loopback and virtual interfaces (container bridges, VPN tunnels, ...) are
 * skipped because they would double count the same transfer.
 * This runs synchronously only because /proc/net/dev is a cheap file read.
 */
function readNetInterfacesLinux(): { name: string; rxBytes: number; txBytes: number }[] {
  if (os.platform() !== "linux") return [];
  try {
    const data = fs.readFileSync("/proc/net/dev", { encoding: "utf-8" });
    const lines = data.split("\n").slice(2);
    const interfaces: { name: string; rxBytes: number; txBytes: number }[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(":");
      if (parts.length !== 2) continue;
      const ifName = parts[0].trim();
      // Skip loopback and virtual interfaces to only account for real traffic.
      if (VIRTUAL_IF_PATTERN.test(ifName)) continue;
      const fields = parts[1].trim().split(/\s+/).map((v) => parseInt(v, 10) || 0);
      // fields[0] = rx bytes, fields[8] = tx bytes
      interfaces.push({
        name: ifName,
        rxBytes: fields[0] ?? 0,
        txBytes: fields[8] ?? 0
      });
    }
    return interfaces;
  } catch {
    return [];
  }
}

/**
 * Read per-adapter cumulative bytes on Windows via Get-NetAdapterStatistics.
 * IMPORTANT: powershell.exe startup costs 1-2s of CPU, so this must run
 * asynchronously (non-blocking) and at a low frequency (10s), never on the
 * hot system-info loop. The returned array may be empty on transient failure.
 */
function readNetInterfacesOnWindowsAsync(callback: (list: { name: string; rxBytes: number; txBytes: number }[]) => void) {
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
    " $ErrorActionPreference='SilentlyContinue';" +
    " $list = Get-NetAdapterStatistics | Where-Object { $_.Name -notmatch 'Loopback' } |" +
    " Select-Object Name, @{N='Rx';E={[long]$_.ReceivedBytes}}, @{N='Tx';E={[long]$_.SentBytes}};" +
    " $list | ConvertTo-Json -Compress";
  try {
    const proc: ChildProcess = exec(
      'powershell.exe -NoProfile -NonInteractive -Command "' + script + '"',
      { encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          callback([]);
          return;
        }
        const output = String(stdout).trim();
        if (!output || output === "null") {
          callback([]);
          return;
        }
        try {
          let parsed: any = JSON.parse(output);
          if (!Array.isArray(parsed)) parsed = [parsed];
          callback(
            (parsed as any[])
              .filter((v: any) => v && typeof v.Name === "string" && v.Name.length > 0)
              .map((v: any) => ({
                name: String(v.Name),
                rxBytes: Math.max(0, Number(v.Rx) || 0),
                txBytes: Math.max(0, Number(v.Tx) || 0)
              }))
          );
        } catch {
          callback([]);
        }
      }
    );
    // Prevent the spawned process from keeping the event loop alive.
    proc.unref();
  } catch {
    callback([]);
  }
}

/** Parse a byte-rate given two cumulative byte totals and the elapsed time. */
function computeByteRate(current: number, previous: number, elapsedSec: number): number {
  if (elapsedSec < 1) return 0;
  const delta = current - previous;
  // Counter reset / wrap-around (interface restarted, statistics cleared, ...).
  if (delta < 0) return 0;
  return Math.round(delta / elapsedSec);
}

/**
 * Apply a freshly read interface list into the shared stats: update the
 * per-interface table and derive aggregate transfer rates from byte deltas.
 * Empty lists (transient read failure) keep the previous counters untouched.
 */
function applyNetworkStats(interfaces: { name: string; rxBytes: number; txBytes: number }[]) {
  if (interfaces.length === 0) return; // keep previous data, avoid bogus rates
  info.netInterfaces = interfaces;

  const netIn = interfaces.reduce((sum, v) => sum + v.rxBytes, 0);
  const netOut = interfaces.reduce((sum, v) => sum + v.txBytes, 0);
  const now = Date.now();

  // First sample: record cumulative counters as a baseline, no rate yet.
  // Without this a fresh process would report the boot-time accumulated bytes
  // (potentially many GB) as an instantaneous transfer-rate spike.
  if (previousNetIn < 0 || previousNetOut < 0) {
    previousNetIn = netIn;
    previousNetOut = netOut;
    previousNetSampleTime = now;
    return;
  }

  const elapsedSec = (now - previousNetSampleTime) / 1000;
  info.netInRate = computeByteRate(netIn, previousNetIn, elapsedSec);
  info.netOutRate = computeByteRate(netOut, previousNetOut, elapsedSec);
  previousNetIn = netIn;
  previousNetOut = netOut;
  previousNetSampleTime = now;
}

/**
 * Low-frequency (10s) asynchronous network stats refresh, decoupled from the
 * 3s CPU/mem loop. On Windows this spawns powershell.exe (1-2s cost), so it
 * must never block the event loop nor run more often than necessary.
 */
let networkStatsTask: NodeJS.Timeout | undefined;
function startNetworkStatsTask() {
  if (networkStatsTask) return;
  const tick = () => {
    if (os.platform() === "win32") {
      readNetInterfacesOnWindowsAsync(applyNetworkStats);
    } else {
      applyNetworkStats(readNetInterfacesLinux());
    }
  };
  tick(); // immediate first sample (establishes baseline)
  networkStatsTask = setInterval(tick, 10000);
}

/** Refresh per-core CPU usage (fast, non-blocking; runs on the 3s loop). */
function refreshDerivedMetrics() {
  const currentCpus = readCpuTimes();
  info.cpus = computePerCoreUsage(currentCpus, previousCpus);
  previousCpus = currentCpus;
}

// periodically refresh the cache
setInterval(() => {
  if (os.platform() === "linux") {
    setLinuxSystemInfo();
  } else if (os.platform() === "win32") {
    setWindowsSystemInfo();
  } else {
    otherSystemInfo();
  }
}, 3000);

// Decoupled low-frequency network stats (see startNetworkStatsTask).
startNetworkStatsTask();

function otherSystemInfo() {
  info.freemem = os.freemem();
  info.totalmem = os.totalmem();
  info.memUsage = (os.totalmem() - os.freemem()) / os.totalmem();
  osUtils.cpuUsage((p) => (info.cpuUsage = p));
  refreshDerivedMetrics();
}

function setWindowsSystemInfo() {
  info.freemem = os.freemem();
  info.totalmem = os.totalmem();
  info.memUsage = (os.totalmem() - os.freemem()) / os.totalmem();
  osUtils.cpuUsage((p) => (info.cpuUsage = p));
  refreshDerivedMetrics();
}

function setLinuxSystemInfo() {
  try {
    // read memory data based on /proc/meminfo
    const data = fs.readFileSync("/proc/meminfo", { encoding: "utf-8" });
    const list = data.split("\n");
    const infoTable: IInfoTable = {};
    list.forEach((line) => {
      const kv = line.split(":");
      if (kv.length === 2) {
        const k = kv[0].replace(/ /gim, "").replace(/\t/gim, "").trim().toLowerCase();
        let v = kv[1].replace(/ /gim, "").replace(/\t/gim, "").trim().toLowerCase();
        v = v.replace(/kb/gim, "").replace(/mb/gim, "").replace(/gb/gim, "");
        let vNumber = parseInt(v);
        if (isNaN(vNumber)) vNumber = 0;
        infoTable[k] = vNumber;
      }
    });
    const memAvailable = infoTable["memavailable"] ?? infoTable["memfree"];
    const memTotal = infoTable["memtotal"];
    info.freemem = memAvailable * 1024;
    info.totalmem = memTotal * 1024;
    info.memUsage = (info.totalmem - info.freemem) / info.totalmem;
    osUtils.cpuUsage((p) => (info.cpuUsage = p));
    refreshDerivedMetrics();
  } catch (error: any) {
    // If the reading is wrong, the default general reading method is automatically used
    otherSystemInfo();
  }
}

export function systemInfo() {
  return info;
}
