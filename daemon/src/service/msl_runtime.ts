import fs from "fs-extra";
import iconv from "iconv-lite";
import path from "path";
import vm from "vm";
import crypto from "crypto";
import { EventEmitter } from "events";
import { createRequire } from "module";

/**
 * MSL (MinecraftServerListener) runtime embedded in the daemon.
 *
 * Compared with the standalone MSL (`index.js`), this runtime:
 *  - Runs plugins inside a worker sandbox with the full `plugin_*` API
 *    compatible with upstream MSL (plugin_require, push/pull, registerCommand,
 *    registerConsoleCommand, registerApi, generateOfflineUUID, sendQQMessage,
 *    getPluginsList, autoloader hooks).
 *  - Writes its own runtime logs to `<instance root>/.msl_logs/msl.log` with
 *    size-based rotation. MC server output is NOT persisted by MSL - the
 *    daemon already keeps the instance output buffer.
 *  - Parses MC log lines for player join/quit/chat/command events using
 *    configurable regexes and emits native events.
 *  - Supports runtime enable/disable of plugins and debug mode.
 */

export type MslConfig = {
  enabled?: boolean;
  debug?: boolean;
  autoRestart?: { enable?: boolean; delay?: number; maxAttempts?: number };
  logRegexs?: Record<string, string>;
  maxLogBytes?: number;
  maxLogFiles?: number;
};

type Plugin = {
  name: string;
  context: vm.Context;
  timers: Set<NodeJS.Timeout>;
  eventHandlers: Map<string, Set<Function>>;
  commandHandlers: Map<string, { fn: Function; pattern: string }>;
  consoleCommandHandlers: Map<string, { fn: Function; pattern: string }>;
  apis: Array<{ method: string; path: string; fn: Function }>;
  loadedAt: number;
};

interface CommandPattern {
  parts: string[];
}

/**
 * Normalize a plugin name into its identity key (the base name of
 * `<instance>/plugins/<name>.js`).
 *
 * The key must keep every character the user typed - plugin names are commonly
 * Chinese (e.g. "自动备份") and stripping/replacing non-ASCII characters would
 * produce a key that no longer matches the file on disk, so the plugin could
 * never be loaded, listed as loaded, or unloaded again.
 *
 * path.basename() removes any directory part ("/" and "\\" on every platform),
 * so a name can never escape the plugins folder through "../".
 */
function pluginKey(name: string) {
  const base = path.basename(String(name === undefined || name === null ? "" : name)).trim();
  return base.toLowerCase().endsWith(".js") ? base.slice(0, -3) : base;
}

function parsePattern(expression: string): CommandPattern {
  return { parts: String(expression).trim().split(/\s+/) };
}

function commandMatches(pattern: CommandPattern, input: string): { match: boolean; args: string[] } {
  const inputParts = String(input).trim().split(/\s+/);
  const args: string[] = [];
  let pi = 0;
  let ii = 0;
  for (; pi < pattern.parts.length && ii < inputParts.length; pi++) {
    const token = pattern.parts[pi];
    if (token.startsWith("<") && token.endsWith(">")) {
      // capture rest-of-line for the last positional arg
      if (pi === pattern.parts.length - 1) {
        args.push(inputParts.slice(ii).join(" "));
        ii = inputParts.length;
      } else {
        args.push(inputParts[ii]);
        ii++;
      }
    } else if (token === inputParts[ii]) {
      ii++;
    } else {
      return { match: false, args: [] };
    }
  }
  return { match: pi === pattern.parts.length && ii === inputParts.length, args };
}

function stripAnsiCodes(str: string) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export class MslRuntime extends EventEmitter {
  private plugins = new Map<string, Plugin>();
  private process: any;
  private config: MslConfig;
  private logFile: string;
  private attempts = 0;
  private globalData = new Map<string, any>();
  private autoloaderInterfaces = new Map<string, Function>();
  private logQueue: string[] = [];
  private logWriteTimer: NodeJS.Timeout | null = null;
  private outputCode = "utf-8";

  constructor(private readonly cwd: string, config: MslConfig = {}) {
    super();
    this.config = config;
    const dir = path.join(cwd, ".msl_logs");
    fs.ensureDirSync(dir);
    this.logFile = path.join(dir, "msl.log");
  }

  // ------------------------------------------------------------------
  // Logging (persisted to .msl_logs/msl.log with rotation)
  // ------------------------------------------------------------------

  /**
   * Write one MSL log record. Multi-line plugin messages are split into one
   * record per line, and literal "\n" sequences in plugin text are converted to
   * real newlines - so the MCSManager terminal always shows proper line breaks
   * instead of a literal backslash-n or glued-together log lines.
   */
  private log(level: string, text: string) {
    const normalized = String(text)
      .replace(/\\r/g, "")
      .replace(/\\n/g, "\n");
    const parts = normalized.split("\n");
    const now = new Date().toISOString();
    for (const part of parts) {
      try {
        const line = `[${now}] [${level}] ${part}\n`;
        this.logQueue.push(line);
        if (this.logQueue.length >= 20) this.flushLogs();
        else this.scheduleLogFlush();
      } catch {
        /* logging must never crash the runtime */
      }
      this.emit("log", `[${level}] ${part}`);
    }
  }

  private scheduleLogFlush() {
    if (this.logWriteTimer) return;
    this.logWriteTimer = setTimeout(() => this.flushLogs(), 200);
    this.logWriteTimer.unref?.();
  }

  private flushLogs() {
    if (this.logWriteTimer) {
      clearTimeout(this.logWriteTimer);
      this.logWriteTimer = null;
    }
    if (!this.logQueue.length) return;
    const lines = this.logQueue.splice(0);
    try {
      this.rotateIfNeeded(lines.join("").length);
      fs.appendFileSync(this.logFile, lines.join(""));
    } catch {
      /* ignore */
    }
  }

  private rotateIfNeeded(incomingBytes: number) {
    try {
      const max = this.config.maxLogBytes || 5 * 1024 * 1024;
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size + incomingBytes >= max) {
        const maxFiles = this.config.maxLogFiles || 7;
        for (let i = maxFiles - 1; i >= 1; i--) {
          const a = `${this.logFile}.${i}`;
          const b = `${this.logFile}.${i + 1}`;
          if (fs.existsSync(a)) fs.renameSync(a, b);
        }
        if (fs.existsSync(this.logFile)) fs.renameSync(this.logFile, `${this.logFile}.1`);
      }
    } catch {
      /* ignore */
    }
  }

  /** Read MSL runtime log (recent lines). */
  readLog(tail = 200) {
    try {
      if (!fs.existsSync(this.logFile)) return "";
      const data = fs.readFileSync(this.logFile, "utf-8");
      const lines = data.split(/\r?\n/).filter(Boolean);
      return lines.slice(-tail).join("\n");
    } catch {
      return "";
    }
  }

  // ------------------------------------------------------------------
  // Attach to the instance process
  // ------------------------------------------------------------------

  /**
   * Attach to the raw instance process stream. The codec must match the output
   * encoding configured for the instance (config.oe, pty => utf-8), so that
   * GBK/Chinese output is decoded correctly - same as the daemon terminal does.
   */
  attach(process: any, codec = "utf-8") {
    this.process = process;
    this.outputCode = codec || "utf-8";
    if (process?.on) {
      process.on("data", (data: Buffer | string) => {
        const text = Buffer.isBuffer(data) ? iconv.decode(data, this.outputCode) : String(data);
        this.handleOutput(text);
      });
      process.on("exit", () => {
        this.process = undefined;
        this.emit("stop");
        this.log("INFO", "Minecraft server process exited");
      });
    }
    this.log("INFO", "MSL attached to Minecraft instance");
    if (this.config.enabled !== false) this.loadAll();
  }

  // ------------------------------------------------------------------
  // Output parsing & events
  // ------------------------------------------------------------------

  private handleOutput(data: string) {
    // MC uses \r for progress overwrites; only the last part is visible
    const rawLines = data.split(/\r?\n/);
    for (const raw of rawLines) {
      const trimmedCr = raw.replace(/\r+$/, "");
      const subLines = trimmedCr.split("\r");
      const visible = subLines[subLines.length - 1].trim();
      if (!visible) continue;
      this.emit("minecraftLog", visible);
      this.parseLine(visible);
    }
  }

  private parseLine(line: string) {
    this.emit("serverLog", line);
    const clean = stripAnsiCodes(line);

    if (clean.includes(" INFO]: Done (")) this.emit("serverDone");

    const r = this.config.logRegexs || {};
    // playerJoin / playerQuit
    for (const event of ["playerJoin", "playerQuit"]) {
      const source = r[event];
      if (!source) continue;
      try {
        const m = clean.match(new RegExp(source));
        if (m) {
          this.emit(event, m[1], m[2]);
          return;
        }
      } catch {
        /* bad regex */
      }
    }
    // playerSendCommand (more specific than message)
    try {
      const source = r.playerSendCommand;
      if (source) {
        const m = clean.match(new RegExp(source));
        if (m) {
          const fullCommand = m[3] || "";
          const parts = fullCommand.split(" ");
          const commandName = parts[0];
          const args = parts.slice(1);
          this.emit("playerSendCommand", m[1], m[2], commandName, args);
          this.matchCommand("/", m[2], "/" + fullCommand);
          return;
        }
      }
    } catch {
      /* ignore */
    }
    // playerSendMessage
    try {
      const source = r.playerSendMessage;
      if (source) {
        const m = clean.match(new RegExp(source));
        if (m) {
          this.emit("playerSendMessage", m[1], m[2], m[3]);
          this.matchCommand("!", m[2], m[3]);
          return;
        }
      }
    } catch {
      /* ignore */
    }
  }

  private matchCommand(prefix: string, player: string, text: string) {
    if (!text.startsWith(prefix)) return;
    const command = text.slice(prefix.length);
    for (const plugin of this.plugins.values()) {
      for (const handler of plugin.commandHandlers.values()) {
        const { match, args } = commandMatches(parsePattern(handler.pattern), command);
        if (match) {
          try {
            handler.fn(player, ...args);
          } catch (e: any) {
            this.log("ERROR", `Command handler error in ${plugin.name}: ${e.message}`);
          }
          return;
        }
      }
    }
  }

  /** Console command dispatch (from daemon terminal / MSL console). */
  handleConsoleCommand(input: string) {
    const trimmed = String(input || "").trim();
    for (const plugin of this.plugins.values()) {
      for (const handler of plugin.consoleCommandHandlers.values()) {
        const { match, args } = commandMatches(parsePattern(handler.pattern), trimmed);
        if (match) {
          try {
            handler.fn("Server", ...args);
          } catch (e: any) {
            this.log("ERROR", `Console command handler error in ${plugin.name}: ${e.message}`);
          }
          return true;
        }
      }
    }
    return false;
  }

  /** Send a command to the Minecraft console (encoded to the instance output codec). */
  writeMinecraftCommand(command: string) {
    if (this.process?.write) {
      try {
        this.process.write(iconv.encode(String(command) + "\n", this.outputCode || "utf-8"));
      } catch {
        this.process.write(String(command) + "\n");
      }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Plugin sandbox + API
  // ------------------------------------------------------------------

  private api(name: string, fn: (...args: any[]) => any) {
    return (...args: any[]) => {
      try {
        return fn(...args);
      } catch (e: any) {
        this.log("ERROR", `${name}: ${e.message}`);
        return undefined;
      }
    };
  }

  private getPlugin(name: string) {
    return this.plugins.get(pluginKey(name));
  }

  /**
   * Absolute path of a plugin file, or null when the name cannot address one.
   * Confines every lookup to `<instance root>/plugins`.
   */
  private pluginFile(name: string): string | null {
    const key = pluginKey(name);
    // Control characters / empty names cannot address a file on any platform.
    if (!key || /[\x00-\x1f]/.test(key)) return null;
    const dir = path.resolve(this.cwd, "plugins");
    const file = path.join(dir, `${key}.js`);
    const rel = path.relative(dir, file);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return file;
  }

  private generateOfflineUUID(name: string): string {
    // Offline mode UUID v3: md5("OfflinePlayer:" + name)
    const hash = crypto
      .createHash("md5")
      .update(`OfflinePlayer:${name}`, "utf-8")
      .digest("hex");
    return (
      hash.slice(0, 8) +
      "-" +
      hash.slice(8, 12) +
      "-3" +
      hash.slice(13, 16) +
      "-" +
      ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) +
      hash.slice(17, 20) +
      "-" +
      hash.slice(20, 32)
    );
  }

  /**
   * The `process` object handed to one plugin sandbox.
   *
   * Plugins run inside a `vm` context, so the host `process` is not reachable
   * from plugin code - and even if it were, its `cwd()` is the daemon's own
   * working directory, not the managed instance. This view reports the
   * instance root (so `process.cwd()` / `path.join(process.cwd(), "ops")`
   * behave like upstream MSL) and forwards the read-only metadata plugins
   * commonly read. Host-wide members (chdir/exit/abort/kill) are neutered on
   * purpose: running them would take the whole daemon down.
   */
  private buildProcess(pluginName: string): any {
    const self = this;
    const events = new EventEmitter();
    const stream = (level: string) => ({
      write: (chunk: any) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk ?? "");
        if (text.trim()) self.log(level, `[${pluginName}] ${text.replace(/[\r\n]+$/, "")}`);
        return true;
      },
      end: () => undefined,
      isTTY: false,
      writable: true
    });
    const disabled = (member: string) => () => {
      self.log("WARN", `[${pluginName}] process.${member}() is disabled in the MSL sandbox (it would affect the whole daemon)`);
    };
    return {
      // The instance root directory - the single most used member.
      cwd: () => self.cwd,
      chdir: disabled("chdir"),
      exit: disabled("exit"),
      abort: disabled("abort"),
      kill: () => false,

      argv: [process.execPath, ...process.argv.slice(1)],
      execArgv: [...process.execArgv],
      execPath: process.execPath,
      env: { ...process.env },
      platform: process.platform,
      arch: process.arch,
      version: process.version,
      versions: { ...process.versions },
      release: { ...(process as any).release },
      config: { variables: { ...((process as any).config?.variables || {}) } },
      pid: process.pid,
      ppid: process.ppid,
      title: process.title,
      exitCode: process.exitCode,

      stdout: stream("INFO"),
      stderr: stream("WARN"),
      stdin: { write: () => true, isTTY: false, setEncoding: () => undefined, resume: () => undefined, pause: () => undefined },

      nextTick: (fn: any, ...args: any[]) => process.nextTick(fn, ...args),
      hrtime: Object.assign((prev?: any) => process.hrtime(prev), { bigint: () => process.hrtime.bigint() }),
      uptime: () => process.uptime(),
      memoryUsage: () => process.memoryUsage(),
      resourceUsage: () => {
        try {
          return process.resourceUsage();
        } catch {
          return undefined;
        }
      },

      // Per-plugin event emitter: process.on("exit"/"warning"/...) stays inert.
      on: events.on.bind(events),
      once: events.once.bind(events),
      off: events.off.bind(events),
      emit: events.emit.bind(events),
      addListener: events.addListener.bind(events),
      removeListener: events.removeListener.bind(events),
      removeAllListeners: events.removeAllListeners.bind(events),
      prependListener: events.prependListener.bind(events),
      prependOnceListener: events.prependOnceListener.bind(events),
      listeners: (name: string) => events.listeners(name),
      listenerCount: (name: string) => events.listenerCount(name),
      eventNames: () => events.eventNames(),
      setMaxListeners: (n: number) => {
        events.setMaxListeners(n);
        return events;
      },
      getMaxListeners: () => events.getMaxListeners()
    };
  }

  private buildSandbox(pluginName: string, timers: Set<NodeJS.Timeout>, file: string): any {
    const self = this;
    const proc = this.buildProcess(pluginName);
    const moduleRecord = { exports: {} as any };
    const sandbox: any = {
      // ---- Node-like globals (upstream MSL loads plugins through require()) ----
      process: proc,
      require: (moduleName: string) => sandbox.plugin_require(moduleName),
      module: moduleRecord,
      exports: moduleRecord.exports,
      __filename: file,
      __dirname: path.dirname(file),
      // A vm context has no Node globals of its own; plugins use these freely.
      Buffer,
      URL,
      URLSearchParams,
      console: {
        log: this.api("plugin", (...a: any[]) => self.log("INFO", `[${pluginName}] ${a.join(" ")}`)),
        warn: this.api("plugin", (...a: any[]) => self.log("WARN", `[${pluginName}] ${a.join(" ")}`)),
        error: this.api("plugin", (...a: any[]) => self.log("ERROR", `[${pluginName}] ${a.join(" ")}`)),
        info: this.api("plugin", (...a: any[]) => self.log("INFO", `[${pluginName}] ${a.join(" ")}`)),
        debug: this.api("plugin", (...a: any[]) => self.log("INFO", `[${pluginName}] ${a.join(" ")}`)),
        trace: this.api("plugin", (...a: any[]) => self.log("INFO", `[${pluginName}] ${a.join(" ")}`))
      },
      setTimeout: (fn: any, ms: number, ...args: any[]) => {
        const t = setTimeout(fn, ms, ...args);
        timers.add(t);
        return t;
      },
      setInterval: (fn: any, ms: number, ...args: any[]) => {
        const t = setInterval(fn, ms, ...args);
        timers.add(t);
        return t;
      },
      clearTimeout: (t: any) => {
        timers.delete(t);
        clearTimeout(t);
      },
      clearInterval: (t: any) => {
        timers.delete(t);
        clearInterval(t);
      },
      // ---- plugin API (upstream MSL compatible) ----
      plugin_log: this.api("plugin_log", (level: string, msg: string) => {
        const lvl = String(level || "INFO").toUpperCase();
        if (["INFO", "WARN", "ERROR"].includes(lvl)) self.log(lvl, `[${pluginName}] ${msg}`);
      }),
      plugin_require: this.api("plugin_require", (moduleName: string) => {
        const name = String(moduleName);
        // Never hand out the host process module: its cwd() is the daemon
        // directory. Plugins must see the sandbox view instead.
        if (name === "process" || name === "node:process") return proc;
        // Resolve from the instance (plugins/node_modules then instance
        // node_modules) FIRST so `npm install` in the workspace works;
        // fall back to the daemon's own node_modules.
        try {
          return createRequire(path.join(this.cwd, "noop.js"))(name);
        } catch {
          return require(name);
        }
      }),
      plugin_executeCommand: this.api("plugin_executeCommand", (command: string, fn?: Function) => {
        self.writeMinecraftCommand(String(command));
        if (typeof fn === "function") {
          // capture short response window (500ms)
          const captured: string[] = [];
          const listener = (line: string) => captured.push(line);
          self.on("minecraftLog", listener);
          setTimeout(() => {
            self.removeListener("minecraftLog", listener);
            try {
              fn(captured);
            } catch (e: any) {
              self.log("ERROR", `Command callback error in ${pluginName}: ${e.message}`);
            }
          }, 500);
        }
      }),
      plugin_startServer: this.api("plugin_startServer", () => self.emit("startRequested")),
      plugin_forceStopServer: this.api("plugin_forceStopServer", () => self.emit("stopRequested")),
      plugin_registerCommand: this.api("plugin_registerCommand", (expression: string, fn: Function) => {
        if (typeof fn !== "function") throw new Error("Handler must be a function");
        const plugin = self.getPlugin(pluginName);
        if (plugin) plugin.commandHandlers.set(String(expression), { fn, pattern: String(expression) });
      }),
      plugin_registerConsoleCommand: this.api("plugin_registerConsoleCommand", (expression: string, fn: Function) => {
        if (typeof fn !== "function") throw new Error("Handler must be a function");
        const plugin = self.getPlugin(pluginName);
        if (plugin) plugin.consoleCommandHandlers.set(String(expression), { fn, pattern: String(expression) });
      }),
      plugin_onEvent: this.api("plugin_onEvent", (event: string, fn: (...args: any[]) => void) => {
        if (typeof fn !== "function") throw new Error("Listener must be a function");
        self.on(event, fn);
        const p = self.getPlugin(pluginName);
        if (p) {
          if (!p.eventHandlers.has(String(event))) p.eventHandlers.set(String(event), new Set());
          p.eventHandlers.get(String(event))!.add(fn);
        }
      }),
      plugin_triggerEvent: this.api("plugin_triggerEvent", (event: string, ...args: any[]) => self.emit(event, ...args)),
      plugin_sendQQMessage: this.api("plugin_sendQQMessage", (text: string) =>
        self.log("WARN", `[${pluginName}] plugin_sendQQMessage is deprecated (v1.1.0+) and no longer functional`)
      ),
      plugin_generateOfflineUUID: this.api("plugin_generateOfflineUUID", (name: string) => self.generateOfflineUUID(String(name))),
      plugin_registerApi: this.api("plugin_registerApi", (method: string, p: string, fn: Function) => {
        const plugin = self.getPlugin(pluginName);
        if (plugin && typeof fn === "function") plugin.apis.push({ method: String(method).toUpperCase(), path: String(p), fn });
      }),
      plugin_push: this.api("plugin_push", (key: string, value: any) => self.globalData.set(String(key), value)),
      plugin_pull: this.api("plugin_pull", (key: string) => self.globalData.get(String(key))),
      plugin_getPluginsList: this.api("plugin_getPluginsList", () => {
        const dir = path.join(self.cwd, "plugins");
        const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => pluginKey(f)) : [];
        const loaded = [...self.plugins.keys()];
        return { loaded, unloaded: all.filter((n) => !loaded.includes(n)), all };
      })
    };

    // autoloader interfaces: <lib>_<name>
    for (const [iface, fn] of this.autoloaderInterfaces) {
      sandbox[iface] = this.api(iface, (...args: any[]) => fn(pluginName, ...args));
    }

    return sandbox;
  }

  load(name: string) {
    const plugin = pluginKey(name);
    const file = this.pluginFile(plugin);
    if (!file) {
      this.log("ERROR", `Cannot load plugin "${name}": invalid plugin name`);
      return false;
    }
    if (this.plugins.has(plugin)) return false;
    if (!fs.existsSync(file)) {
      // Forward slashes: the log writer turns literal "\n" into a newline, which
      // would otherwise chop Windows paths such as ...\plugins\node-xxx.js.
      const shown = file.split(path.sep).join("/");
      this.log("ERROR", `Cannot load plugin "${plugin}": file not found (${shown})`);
      return false;
    }

    const timers = new Set<NodeJS.Timeout>();
    const record: Plugin = {
      name: plugin,
      context: {} as vm.Context,
      timers,
      eventHandlers: new Map(),
      commandHandlers: new Map(),
      consoleCommandHandlers: new Map(),
      apis: [],
      loadedAt: Date.now()
    };
    this.plugins.set(plugin, record);

    const sandbox = this.buildSandbox(plugin, timers, file);
    record.context = vm.createContext(sandbox);

    try {
      new vm.Script(fs.readFileSync(file, "utf-8"), { filename: file }).runInContext(record.context, {
        timeout: 5000
      });
      this.log("INFO", `Plugin ${plugin} loaded`);
      this.emit("pluginLoaded", plugin);
      return true;
    } catch (e: any) {
      this.plugins.delete(plugin);
      this.log("ERROR", `Plugin ${plugin} failed to load: ${e.message}`);
      return false;
    }
  }

  unload(name: string) {
    const p = this.plugins.get(pluginKey(name));
    if (!p) return false;
    for (const t of p.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    for (const [event, handlers] of p.eventHandlers) {
      for (const fn of handlers) {
        try {
          this.removeListener(event, fn as (...args: any[]) => void);
        } catch {
          /* ignore */
        }
      }
    }
    this.plugins.delete(p.name);
    this.log("INFO", `Plugin ${p.name} unloaded`);
    return true;
  }

  loadAll() {
    const dir = path.join(this.cwd, "plugins");
    fs.ensureDirSync(dir);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      this.load(pluginKey(f));
    }
  }

  unloadAll() {
    for (const name of [...this.plugins.keys()]) this.unload(name);
  }

  reload() {
    this.unloadAll();
    this.loadAll();
  }

  listPlugins() {
    const dir = path.join(this.cwd, "plugins");
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => pluginKey(f)) : [];
    const loaded = [...this.plugins.keys()];
    return all.map((n) => ({ name: n, loaded: loaded.includes(n) }));
  }

  // ------------------------------------------------------------------
  // Autoloader interface (msl- npm packages expose app.createInterface)
  // ------------------------------------------------------------------

  registerInterface(name: string, fn: Function) {
    this.autoloaderInterfaces.set(String(name), fn);
  }

  status() {
    return {
      enabled: this.config.enabled !== false,
      debug: Boolean(this.config.debug),
      plugins: [...this.plugins.keys()],
      running: Boolean(this.process),
      logRegexs: this.config.logRegexs || {}
    };
  }

  update(config: MslConfig) {
    this.config = { ...this.config, ...config, logRegexs: { ...this.config.logRegexs, ...(config.logRegexs || {}) } };
    if (config.debug !== undefined) {
      this.log("INFO", `Debug ${config.debug ? "enabled" : "disabled"}`);
    }
  }

  setDebug(enabled: boolean) {
    this.config.debug = Boolean(enabled);
    this.log("INFO", `Debug mode ${this.config.debug ? "ON" : "OFF"}`);
  }

  dispose() {
    this.unloadAll();
    this.flushLogs();
    this.removeAllListeners();
    this.process = undefined;
    this.globalData.clear();
  }
}