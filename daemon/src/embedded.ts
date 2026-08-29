import fs from "fs-extra";
import http from "http";
import https from "https";
import { Server } from "socket.io";
import { GOLANG_ZIP_PATH, LOCAL_PRESET_LANG_PATH, PTY_PATH } from "./const";
import { globalConfiguration } from "./entity/config";
import { $t, i18next } from "./i18n";
import "./service/async_task_service";
import "./service/async_task_service/quick_install";
import { checkDependencies } from "./service/dependencies";
import * as koa from "./service/http";
import logger from "./service/log";
import * as protocol from "./service/protocol";
import * as router from "./service/router";
import InstanceSubsystem from "./service/system_instance";
import "./service/system_visual_data";
import uploadManager from "./service/upload_manager";
import versionAdapter from "./service/version_adapter";

/**
 * Embeddable daemon bootstrap.
 *
 * The daemon can run in two modes:
 *  1. Standalone: `app.ts` creates its own HTTP/Socket.IO servers and process
 *     signal handlers.
 *  2. Embedded: the panel process requires this module, boots the daemon
 *     services in-process and mounts the daemon Koa application + Socket.IO
 *     server onto the panel HTTP server, so both services share one port and
 *     one process (`node production/app.js`).
 */

interface EmbeddedState {
  koaApp: ReturnType<typeof koa.initKoa>;
  io?: Server;
  socketPath?: string;
}

let state: EmbeddedState | null = null;

/** Root directory of the daemon installation (captured at boot). */
let daemonRoot: string | null = null;

export function getDaemonRoot() {
  return daemonRoot ?? process.cwd();
}

export function isEmbeddedDaemon() {
  return state !== null;
}

/** Common boot steps shared by standalone and embedded modes. */
export function bootDaemonServices(degraded = false) {
  daemonRoot = process.cwd();
  globalConfiguration.load();
  versionAdapter.detectConfig();
  try {
    checkDependencies();
  } catch (err: any) {
    // In embedded (degraded) mode missing helper binaries (PTY/Zip-Tools)
    // must not take down the whole panel - log a warning and continue.
    // Standalone mode keeps the original fail-fast behavior.
    if (degraded) {
      logger.warn("Embedded daemon: optional dependency check failed:", err?.message);
    } else {
      throw err;
    }
  }

  const config = globalConfiguration.config;
  if (fs.existsSync(LOCAL_PRESET_LANG_PATH)) {
    i18next.changeLanguage(fs.readFileSync(LOCAL_PRESET_LANG_PATH, "utf-8"));
  } else {
    i18next.changeLanguage(config.language || "en_us");
  }

  return config;
}

/** chmod the bundled helper binaries (idempotent). */
export function prepareHelperBinaries() {
  try {
    fs.chmodSync(GOLANG_ZIP_PATH, 0o755);
    fs.chmodSync(PTY_PATH, 0o755);
  } catch (error: any) {
    logger.error(error?.message);
    logger.error($t("TXT_CODE_a8b245fa"));
  }
}

/** Register the Socket.IO routing used by the panel protocol. */
function attachSocketRouting(io: Server) {
  io.on("connection", (socket) => {
    protocol.addGlobalSocket(socket);
    router.navigation(socket);

    socket.on("error", (err) => {
      logger.error("Connection(): Socket.io Error:", err);
    });

    socket.on("disconnect", () => {
      protocol.delGlobalSocket(socket);
      for (const name of socket.eventNames()) socket.removeAllListeners(name);
    });
  });
}

/**
 * Embedded boot step 1: load configuration, instances and the Koa app.
 * Must be called while `process.cwd()` points at the daemon directory so that
 * daemon data/log paths resolve to the daemon tree.
 */
export function initEmbeddedDaemon(): EmbeddedState {
  if (state) return state;

  const config = bootDaemonServices(true);
  logger.info("Daemon embedded mode: loading daemon services inside the panel process");

  // Mark this daemon as embedded-managed so isEmbeddedDaemonEnabled() reports
  // correctly and consumers can branch on single-process mode.
  if (!globalConfiguration.config.embedded) {
    globalConfiguration.config.embedded = true;
    globalConfiguration.store();
  }

  const koaApp = koa.initKoa({ ignorePrefix: true });

  try {
    InstanceSubsystem.loadInstances();
    logger.info($t("TXT_CODE_app.instanceLoad", { n: InstanceSubsystem.getInstances().length }));
  } catch (err) {
    logger.error($t("TXT_CODE_app.instanceLoadError"), err);
    throw err;
  }

  prepareHelperBinaries();
  logger.info($t("TXT_CODE_app.password", { key: config.key }));

  state = { koaApp };
  return state;
}

/** Embedded boot step 2: attach the daemon Socket.IO server to a shared HTTP server. */
export function attachEmbeddedSocketServer(
  httpServer: http.Server | https.Server,
  socketPath: string
) {
  if (!state) throw new Error("Embedded daemon is not initialized");
  if (state.io) return state.io;
  const io = new Server(httpServer, {
    serveClient: false,
    pingInterval: 1000 * 20,
    pingTimeout: 1000 * 10,
    cookie: false,
    path: socketPath,
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PUT", "DELETE"]
    },
    maxHttpBufferSize: 1e7
  });
  attachSocketRouting(io);
  state.io = io;
  state.socketPath = socketPath;
  logger.info(`Daemon embedded mode: Socket.IO mounted on shared server at ${socketPath}`);
  return io;
}

/** Koa request handler for mounting daemon HTTP routes under the panel server. */
export function getEmbeddedHttpHandler() {
  if (!state) throw new Error("Embedded daemon is not initialized");
  return state.koaApp.callback();
}

/** The daemon access key, used by the panel to authenticate its local socket. */
export function getEmbeddedDaemonKey() {
  return globalConfiguration.config.key;
}

/** Port configured for the daemon (informational only in embedded mode). */
export function getEmbeddedDaemonPort() {
  return globalConfiguration.config.port;
}

/** Whether this daemon instance is the panel's embedded local node. */
export function isEmbeddedDaemonEnabled() {
  return globalConfiguration.config.embedded === true;
}

/**
 * Graceful shutdown used when the panel process exits. Mirrors the standalone
 * signal handling strategy (soft shutdown first, force on second signal).
 */
export async function shutdownEmbeddedDaemon(force = false) {
  if (!state) return;
  const config = globalConfiguration.config;
  try {
    if (force || !config.enableSoftShutdown) {
      await InstanceSubsystem.exit(true);
    } else {
      await InstanceSubsystem.softExit(
        Boolean(config.softShutdownSkipDocker),
        Number(config.softShutdownWaitSeconds) || 10
      );
    }
    await uploadManager.exit();
    state.io?.close();
  } catch (err) {
    logger.error("Embedded daemon shutdown error:", err);
    throw err;
  }
}
