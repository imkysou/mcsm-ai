import { routerApp } from "../service/router";
import * as protocol from "../service/protocol";
import InstanceSubsystem from "../service/system_instance";
import Instance from "../entity/instance/instance";
import fs from "fs-extra";
import iconv from "iconv-lite";
import path from "path";
import { spawn } from "child_process";

/**
 * MSL router - all MSL related socket events.
 *
 * MSL is only available for Minecraft instances (java/bedrock). The runtime
 * lives in the daemon process and is attached to the instance process.
 */
function get(data: any) {
  const i = InstanceSubsystem.getInstance(String(data.instanceUuid));
  if (!i) throw new Error("Instance not found");
  if (![Instance.TYPE_MINECRAFT_JAVA, Instance.TYPE_MINECRAFT_BEDROCK].includes(i.config.type as any)) {
    throw new Error("MSL is only available for Minecraft instances");
  }
  return i;
}

// Current status: enabled, debug, loaded plugins, running
routerApp.on("msl/status", (ctx, data) => {
  const i = get(data);
  protocol.response(ctx, i.msl?.status() || { enabled: false, debug: false, plugins: [], running: false });
});

// Get config (no update)
routerApp.on("msl/config_get", (ctx, data) => {
  const i = get(data);
  protocol.response(ctx, i.config.msl || {});
});

// Update config (dialog form). Only whitelisted editable fields are accepted.
routerApp.on("msl/config", (ctx, data) => {
  const i = get(data);
  if (data.config) {
    const incoming = data.config || {};
    const editable: Record<string, any> = {};
    // enabled / debug
    if (incoming.enabled !== undefined) editable.enabled = Boolean(incoming.enabled);
    if (incoming.debug !== undefined) editable.debug = Boolean(incoming.debug);
    // autoRestart (only enable/delay/maxAttempts)
    if (incoming.autoRestart && typeof incoming.autoRestart === "object") {
      const ar: Record<string, any> = {};
      if (incoming.autoRestart.enable !== undefined) ar.enable = Boolean(incoming.autoRestart.enable);
      if (incoming.autoRestart.delay !== undefined) ar.delay = Math.max(0, Number(incoming.autoRestart.delay) || 3000);
      if (incoming.autoRestart.maxAttempts !== undefined)
        ar.maxAttempts = Math.max(0, Number(incoming.autoRestart.maxAttempts) || 0);
      editable.autoRestart = ar;
    }
    // logRegexs (string sources only)
    if (incoming.logRegexs && typeof incoming.logRegexs === "object") {
      const regexs: Record<string, string> = {};
      for (const [k, v] of Object.entries(incoming.logRegexs)) {
        const key = String(k);
        if (!["playerJoin", "playerQuit", "playerSendMessage", "playerSendCommand"].includes(key)) continue;
        try {
          // validate regex compiles
          new RegExp(String(v));
          regexs[key] = String(v);
        } catch {
          throw new Error(`Invalid logRegex for ${key}`);
        }
      }
      if (Object.keys(regexs).length) editable.logRegexs = regexs;
    }
    i.parameters({ msl: editable });
  }
  protocol.response(ctx, i.config.msl);
});

// Reload all plugins
routerApp.on("msl/reload", (ctx, data) => {
  const i = get(data);
  i.msl?.reload();
  protocol.response(ctx, i.msl?.status());
});

// Toggle debug
routerApp.on("msl/debug", (ctx, data) => {
  const i = get(data);
  i.msl?.setDebug(Boolean(data.enabled));
  protocol.response(ctx, i.msl?.status());
});

// Enable plugin (or "all")
routerApp.on("msl/plugin_enable", (ctx, data) => {
  const i = get(data);
  if (data.name === "all") i.msl?.loadAll();
  else i.msl?.load(String(data.name));
  protocol.response(ctx, i.msl?.status());
});

// Disable plugin (or "all")
routerApp.on("msl/plugin_disable", (ctx, data) => {
  const i = get(data);
  if (data.name === "all") i.msl?.unloadAll();
  else i.msl?.unload(String(data.name));
  protocol.response(ctx, i.msl?.status());
});

// List plugins with load status
routerApp.on("msl/plugin_list", (ctx, data) => {
  const i = get(data);
  protocol.response(ctx, i.msl?.listPlugins() || []);
});

// Read MSL runtime log (.msl_logs/msl.log)
routerApp.on("msl/log", (ctx, data) => {
  const i = get(data);
  protocol.response(ctx, { content: i.msl?.readLog(Number(data.tail) || 200) || "" });
});

// Read the tail of the Minecraft server log (logs/latest.log). Used by the
// MSL config dialog to let the AI generate logRegex entries from real log
// lines. Returns only the last N lines to keep the payload small.
routerApp.on("msl/log_sample", async (ctx, data) => {
  const i = get(data);
  const tail = Math.min(400, Math.max(20, Number(data.tail) || 200));
  const logPath = path.join(i.absoluteCwdPath(), "logs", "latest.log");
  try {
    if (!fs.existsSync(logPath)) {
      protocol.response(ctx, { content: "" });
      return;
    }
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    protocol.response(ctx, { content: lines.slice(-tail).join("\n") });
  } catch (err: any) {
    protocol.responseError(ctx, err);
  }
});


/**
 * Decode a buffer with the UTF-8 first, then GBK (gb18030) fallback when the
 * UTF-8 decode contains replacement characters (GBK-encoded server logs on
 * Chinese Windows). This mirrors how MCSM decodes instance output via iconv.
 */
function smartDecode(buf: Buffer): string {
  const utf8 = iconv.decode(buf, "utf-8");
  if (!utf8.includes("\ufffd")) return utf8;
  try {
    return iconv.decode(buf, "gb18030");
  } catch {
    return utf8;
  }
}

/**
 * Read only the tail of a (potentially large) log file: at most ~1MB from the
 * end, stripped of ANSI codes, trimmed, newest lines last. Encoding-aware.
 */
async function readTailLines(file: string, maxLines = 4000): Promise<string[]> {
  const st = fs.statSync(file);
  const chunk = Math.min(st.size, 1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(chunk);
    const bytesRead = fs.readSync(fd, buf, 0, chunk, Math.max(0, st.size - chunk));
    return smartDecode(buf.slice(0, bytesRead))
      .split(/\r?\n/)
      .map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""))
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Evidence targets: heuristic line categories the AI regex must be built from.
 * The scanner never guesses - it only reports lines the server actually wrote,
 * so regex generation can fail with "insufficient info" when an event never
 * happened on this server.
 */
const EVIDENCE_TARGETS: Array<{ event: string; label: string; test: RegExp }> = [
  { event: "playerJoin", label: "playerJoin", test: /(?:has\s+)?joined\s+the\s+game/i },
  { event: "playerQuit", label: "playerQuit", test: /(?:has\s+)?left\s+the\s+game/i },
  { event: "playerSendMessage", label: "playerSendMessage", test: /<[\p{L}\p{N}_]{1,32}>\s+\S/iu },
  { event: "playerSendCommand", label: "playerSendCommand", test: /issued\s+server\s+command/i }
];

// Scan Minecraft logs (logs/latest.log + sibling .log files) for REAL lines of
// each player event. Used by the AI regex generator to ground itself.
routerApp.on("msl/log_evidence", async (ctx, data) => {
  const i = get(data);
  const maxPerEvent = Math.min(60, Math.max(5, Number(data.maxPerEvent) || 25));
  const contextTail = Math.min(150, Math.max(20, Number(data.contextTail) || 80));
  // Read the CURRENT terminal output (data/InstanceLog/<uuid>.log, written by the
  // daemon from the decoded instance stream) instead of logs/latest.log: the
  // terminal view is exactly what the server outputs right now (Folia includes
  // thread prefixes there), while latest.log may lag or use another format.
  // Lines are taken from the bottom upward, like scrolling the terminal.
  const terminalLog = path.join(InstanceSubsystem.LOG_DIR, `${i.instanceUuid}.log`);
  let rawLines: string[] = [];
  try {
    if (fs.existsSync(terminalLog)) {
      rawLines = await readTailLines(terminalLog, 3000);
    }
  } catch {
    /* unreadable terminal log */
  }
  const evidence: Record<string, string[]> = {
    playerJoin: [],
    playerQuit: [],
    playerSendMessage: [],
    playerSendCommand: []
  };
  const seen: Record<string, Set<string>> = {
    playerJoin: new Set(),
    playerQuit: new Set(),
    playerSendMessage: new Set(),
    playerSendCommand: new Set()
  };
  const context: string[] = [];
  // One pass over the terminal tail: bottom-up (newest last), ANSI already stripped.
  for (const line of rawLines) {
    for (const target of EVIDENCE_TARGETS) {
      if (evidence[target.event].length >= maxPerEvent) continue;
      if (target.test.test(line) && !seen[target.event].has(line)) {
        seen[target.event].add(line);
        evidence[target.event].push(line);
      }
    }
  }
  context.push(...rawLines.slice(-contextTail));
  protocol.response(ctx, {
    evidence,
    context: context.slice(-contextTail)
  });
});

/**
 * Run a shell command in the Minecraft instance workspace (MSL directory).
 * This is the workspace terminal used by the MSL dialog: npm install here
 * installs packages that MSL plugins can require (plugin_require resolves
 * from the instance first). Admin-only, cwd confined to the instance,
 * output and runtime bounded.
 */
routerApp.on("msl/shell", async (ctx, data) => {
  const i = get(data);
  const command = String(data.command || "").trim();
  if (!command || command.length > 4096) throw new Error("Invalid command");
  const timeoutMs = Math.min(300000, Math.max(1000, Number(data.timeoutMs) || 120000));
  const cwd = i.absoluteCwdPath();
  const result = await new Promise<any>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: process.platform === "win32",
      windowsHide: true,
      env: { ...process.env }
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: any) => {
      if (done) return;
      done = true;
      resolve({
        code: code === "timeout" ? "timeout" : code,
        stdout: stdout.slice(-200000),
        stderr: stderr.slice(-200000)
      });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish("timeout");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      finish("spawn error: " + err.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
  protocol.response(ctx, result);
});
// Send a console command to the Minecraft process through MSL
routerApp.on("msl/command", (ctx, data) => {
  const i = get(data);
  const command = String(data.command || "");
  if (!command || command.length > 2000) throw new Error("Invalid command");
  const ok = i.msl?.writeMinecraftCommand(command);
  protocol.response(ctx, { success: Boolean(ok) });
});
