import { createRequire } from "module";
import fs from "fs-extra";
import http from "http";
import https from "https";
import path from "path";
import Storage from "../common/system_storage";
import { RemoteServiceConfig } from "../entity/entity_interface";
import { logger } from "./log";

/**
 * Embedded daemon bridge.
 *
 * In single-process mode the panel requires the daemon's build output
 * (`daemon/production/embedded.js`) and boots the whole daemon inside its own
 * Node process. The daemon Koa app is mounted under `<prefix>/daemon` and the
 * daemon Socket.IO server is attached to the panel HTTP server at
 * `<prefix>/daemon/socket.io`, so only one port is exposed (NAT friendly).
 *
 * Environment switches:
 *  - MCSM_EMBEDDED_DAEMON=0  -> disable embedded mode
 *  - MCSM_DAEMON_TARGET=...  -> legacy reverse proxy mode (takes precedence)
 *  - MCSM_DAEMON_ENTRY=...   -> explicit path to daemon embedded.js bundle
 */

const LOCAL_SERVICE_REMARK = "Local node";

interface EmbeddedModule {
  initEmbeddedDaemon: () => unknown;
  attachEmbeddedSocketServer: (httpServer: http.Server | https.Server, socketPath: string) => unknown;
  getEmbeddedHttpHandler: () => (req: http.IncomingMessage, res: http.ServerResponse) => void;
  getEmbeddedDaemonKey: () => string;
  getEmbeddedDaemonPort: () => number;
  shutdownEmbeddedDaemon: (force?: boolean) => Promise<void>;
}

let embeddedModule: EmbeddedModule | null = null;
let daemonEntryPath: string | null = null;
let daemonRootDir: string | null = null;
let panelRootDir: string | null = null;
let embeddedServiceUuid: string | null = null;

function findDaemonEntry(): string | null {
  if (process.env.MCSM_DAEMON_ENTRY) {
    return path.resolve(process.env.MCSM_DAEMON_ENTRY);
  }
  // Panel is started from the panel directory (`node production/app.js`),
  // so the sibling daemon tree is one level up.
  const candidates = [
    path.resolve(process.cwd(), "../daemon/production/embedded.js"),
    path.resolve(process.cwd(), "../daemon/dist/embedded.js")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** True when the panel should boot the daemon inside its own process. */
export function isEmbeddedMode(): boolean {
  if (process.env.MCSM_DAEMON_TARGET) return false;
  if (process.env.MCSM_EMBEDDED_DAEMON === "0") return false;
  if (embeddedModule) return true;
  return findDaemonEntry() !== null;
}

/** Absolute URL prefix used to expose daemon HTTP routes on the panel server. */
export function embeddedDaemonPrefix(panelPrefix = ""): string {
  const base = panelPrefix ? `/${panelPrefix.replace(/^\/+|\/+$/g, "")}` : "";
  return `${base}/daemon`;
}

/** Socket.IO path of the embedded daemon on the shared HTTP server. */
export function embeddedSocketPath(panelPrefix = ""): string {
  return `${removeTrailSlash(embeddedDaemonPrefix(panelPrefix))}/socket.io`;
}

function removeTrailSlash(v: string) {
  return v.replace(/\/+$/, "") || "/";
}

/**
 * Boot the embedded daemon. Must be called before panel remote services are
 * initialized so the local daemon service can be registered/updated.
 */
export function bootEmbeddedDaemon(panelPrefix = ""): boolean {
  if (embeddedModule) return true;
  if (process.env.MCSM_DAEMON_TARGET || process.env.MCSM_EMBEDDED_DAEMON === "0") return false;

  const entry = findDaemonEntry();
  if (!entry) {
    logger.warn(
      "Embedded daemon bundle not found; falling back to panel-only mode. Run the daemon build or set MCSM_DAEMON_TARGET to proxy an external daemon."
    );
    return false;
  }

  panelRootDir = process.cwd();
  daemonEntryPath = entry;
  daemonRootDir = path.dirname(path.dirname(entry)); // <daemon>/production/embedded.js

  const previousCwd = process.cwd();
  try {
    // The daemon resolves data/log paths relative to its own directory while
    // its bundle is evaluated, so temporarily switch into the daemon tree.
    process.chdir(daemonRootDir);
    const requireDaemon = createRequire(entry);
    embeddedModule = requireDaemon(entry) as EmbeddedModule;
    embeddedModule.initEmbeddedDaemon();
    logger.info(`Embedded daemon booted from ${entry}`);
    return true;
  } catch (err) {
    embeddedModule = null;
    logger.error("Failed to boot embedded daemon, continuing panel-only:", err);
    return false;
  } finally {
    process.chdir(previousCwd);
  }
}

/** Attach the embedded daemon Socket.IO server to the shared panel HTTP server. */
export function attachEmbeddedDaemon(
  httpServer: http.Server | https.Server,
  panelPrefix = ""
): boolean {
  if (!embeddedModule) return false;
  try {
    embeddedModule.attachEmbeddedSocketServer(httpServer, embeddedSocketPath(panelPrefix));
    return true;
  } catch (err) {
    logger.error("Failed to attach embedded daemon Socket.IO server:", err);
    return false;
  }
}

/** Koa request handler serving daemon HTTP routes (paths already stripped). */
export function getEmbeddedHttpHandler() {
  return embeddedModule?.getEmbeddedHttpHandler() ?? null;
}

/** UUID of the RemoteServiceConfig entry that represents the embedded daemon. */
export function getEmbeddedServiceUuid(): string | null {
  return embeddedServiceUuid;
}

/**
 * Create or migrate the local daemon remote service entry so the panel talks
 * to the embedded daemon over the shared port instead of a standalone
 * daemon port. Existing localhost:24444 entries are migrated in place to keep
 * user instance bindings stable.
 */
export async function ensureEmbeddedRemoteService(
  panelPort: number,
  panelPrefix = ""
): Promise<void> {
  if (!embeddedModule) return;
  try {
    const storage = Storage;
    const ids = await storage.list("RemoteServiceConfig");
    const apiKey = embeddedModule.getEmbeddedDaemonKey();
    const targetPrefix = removeTrailSlash(embeddedDaemonPrefix(panelPrefix));
    const localIp = ["127.0.0.1", "localhost", "::1"];

    // Prefer an already-tagged local service; otherwise migrate a loopback
    // service pointing at the old standalone daemon port.
    let targetId: string | null = null;
    for (const id of ids) {
      const cfg = (await storage.load("RemoteServiceConfig", RemoteServiceConfig, id)) as
        | RemoteServiceConfig
        | null;
      if (!cfg) continue;
      const loopback = localIp.includes(String(cfg.ip).toLowerCase());
      if (cfg.remarks === LOCAL_SERVICE_REMARK || (loopback && Number(cfg.port) === 24444)) {
        targetId = id;
        cfg.ip = "127.0.0.1";
        cfg.port = panelPort;
        cfg.prefix = targetPrefix;
        cfg.remarks = LOCAL_SERVICE_REMARK;
        if (apiKey && cfg.apiKey !== apiKey) cfg.apiKey = apiKey;
        await storage.store("RemoteServiceConfig", id, cfg);
        break;
      }
    }

    if (!targetId) {
      const newId = String(Date.now()) + Math.floor(Math.random() * 1e6);
      const cfg = new RemoteServiceConfig();
      cfg.ip = "127.0.0.1";
      cfg.port = panelPort;
      cfg.prefix = targetPrefix;
      cfg.remarks = LOCAL_SERVICE_REMARK;
      cfg.apiKey = apiKey;
      await storage.store("RemoteServiceConfig", newId, cfg);
      targetId = newId;
    }
    embeddedServiceUuid = targetId;
    logger.info(`Embedded daemon service registered as ${targetId}`);
  } catch (err) {
    logger.error("Failed to register embedded daemon remote service:", err);
  }
}

/**
 * Rewrite the advertised address of the embedded daemon so browser clients
 * connect through the panel origin (same host/port, `/daemon` prefix).
 */
export function rewriteDaemonAddressForFrontend(
  uuid: string,
  info: { ip?: string; port?: number; prefix?: string },
  requestHostHeader?: string,
  panelPrefix = ""
) {
  if (uuid !== embeddedServiceUuid) return;
  if (requestHostHeader) {
    const idx = requestHostHeader.lastIndexOf(":");
    if (idx > requestHostHeader.lastIndexOf("]")) {
      // host with port (IPv6 included)
      info.ip = requestHostHeader.slice(0, idx);
      info.port = Number(requestHostHeader.slice(idx + 1));
    } else {
      info.ip = requestHostHeader;
    }
  }
  info.prefix = removeTrailSlash(embeddedDaemonPrefix(panelPrefix));
}

/** Graceful shutdown of the embedded daemon (called from panel exit handlers). */
export async function shutdownEmbeddedDaemon(force = false): Promise<void> {
  if (!embeddedModule) return;
  await embeddedModule.shutdownEmbeddedDaemon(force);
}
