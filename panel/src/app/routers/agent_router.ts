import Router from "@koa/router";
import path from "path";
import fs from "fs-extra";
import permission from "../middleware/permission";
import { ROLE } from "../entity/user";
import { operationLogger, getOperationLoggerOperator } from "../service/operation_logger";
import configStore from "../service/agent/config_store";
import SessionStore from "../service/agent/sessions";
import ApprovalStore from "../service/agent/approvals";
import SnapshotStore from "../service/agent/snapshots";
import { detectMode } from "../service/agent/prompt";
import engine, { AgentAbortError } from "../service/agent/engine";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";

const router = new Router({ prefix: "/agent" });
const MAX_PROMPT_LENGTH = 20000;

/** Abort registry: sessionId -> AbortController */
const abortControllers = new Map<string, AbortController>();

/**
 * Resolve a workspace selector to a real absolute path.
 *
 * The frontend may send a virtual workspace of the form `/instance/<uuid>` or
 * `/instance/<uuid>/<subpath>` which identifies an instance on a daemon host.
 * Since the Agent engine lives in the panel process and reads/writes files
 * directly, we ask the daemon for the instance's absolute working directory
 * (`instance/absolute_cwd`) and resolve subpaths against it. Plain absolute
 * folder paths are returned as-is.
 */
async function resolveWorkspace(value: unknown, daemonId?: string): Promise<string> {
  const workspace = String(value || "").trim();
  if (!workspace || workspace.length > 4096 || workspace.includes("\0")) throw new Error("Invalid workspace");

  const m = workspace.match(/^\/instance\/([^/]+)(\/.*)?$/);
  if (m) {
    const instanceUuid = m[1];
    const sub = m[2] || "";
    if (!daemonId) throw new Error("Daemon id is required for instance workspaces");
    const remote = RemoteServiceSubsystem.getInstance(daemonId);
    if (!remote) throw new Error("Daemon not found");
    const res = await new RemoteRequest(remote).request("instance/absolute_cwd", { instanceUuid }, 15000);
    const cwd = res?.cwd;
    if (!cwd) throw new Error("Cannot resolve instance working directory");
    return path.resolve(String(cwd), sub ? sub.replace(/^\/+/, "") : ".");
  }
  return path.resolve(workspace);
}

function abortSession(sessionId: string) {
  const ctrl = abortControllers.get(sessionId);
  if (ctrl) {
    ctrl.abort();
    abortControllers.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

router.get("/config/providers", permission({ level: ROLE.ADMIN }), async (ctx) => {
  ctx.body = {
    providers: configStore.list(),
    defaultProviderId: configStore.defaultProviderId()
  };
});

router.post("/config/providers", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const body = ctx.request.body || {};
  const provider = configStore.add(body);
  operationLogger.log("agent_config_change", {
    ...getOperationLoggerOperator(ctx),
    config_after: `provider:${provider.label}`
  } as any);
  ctx.body = { provider };
});

router.put("/config/providers", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Provider id is required");
  const provider = configStore.update(id, ctx.request.body || {});
  ctx.body = { provider };
});

router.delete("/config/providers", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Provider id is required");
  configStore.remove(id);
  ctx.body = { success: true };
});

router.post("/config/providers/default", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Provider id is required");
  configStore.setDefault(id);
  ctx.body = { success: true };
});

router.post("/config/import", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const body = ctx.request.body || {};
  const count = configStore.importAll(body.providers || []);
  ctx.body = { imported: count };
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

router.get("/sessions", permission({ level: ROLE.ADMIN }), async (ctx) => {
  ctx.body = { sessions: SessionStore.list() };
});

router.post("/sessions", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const body = ctx.request.body || {};
  const workspace = await resolveWorkspace(body.workspace, body.daemonId);
  if (!fs.existsSync(workspace)) throw new Error("Workspace does not exist");
  const providerId = String(body.providerId || "");
  if (!configStore.getRaw(providerId)) throw new Error("Provider not found");
  const mode = ["normal", "fix", "msl"].includes(body.mode) ? body.mode : "normal";
  const session = SessionStore.create({
    label: body.label,
    workspace,
    daemonId: body.daemonId,
    instanceUuid: body.instanceUuid,
    providerId,
    modelOverride: body.modelOverride,
    mode
  });
  ctx.body = { session };
});

router.get("/sessions/detail", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Session id is required");
  const session = SessionStore.get(id);
  if (!session) {
    ctx.status = 404;
    ctx.body = { error: "Session not found" };
    return;
  }
  ctx.body = { session };
});

router.delete("/sessions", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Session id is required");
  abortSession(id);
  SessionStore.remove(id);
  ctx.body = { success: true };
});

router.post("/sessions/clear", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Session id is required");
  const session = SessionStore.clearMessages(id);
  ctx.body = { session };
});

router.post("/sessions/abort", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Session id is required");
  abortSession(id);
  ctx.body = { success: true };
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

router.get("/approvals", permission({ level: ROLE.ADMIN }), async (ctx) => {
  ctx.body = { approvals: ApprovalStore.list() };
});

router.post("/approvals/approve", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Approval id is required");
  const req = await ApprovalStore.decide(id, true, getOperationLoggerOperator(ctx).operator_name || "admin");
  operationLogger.log("agent_approval_approve", { ...getOperationLoggerOperator(ctx), approval_id: req.id, tool: req.tool } as any);
  ctx.body = { approval: req };
});

router.post("/approvals/reject", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Approval id is required");
  const req = await ApprovalStore.decide(id, false, getOperationLoggerOperator(ctx).operator_name || "admin");
  operationLogger.log("agent_approval_reject", { ...getOperationLoggerOperator(ctx), approval_id: req.id, tool: req.tool } as any);
  ctx.body = { approval: req };
});

router.post("/approvals/always", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Approval id is required");
  const req = await ApprovalStore.decide(id, true, getOperationLoggerOperator(ctx).operator_name || "admin", true);
  operationLogger.log("agent_approval_always" as any, { ...getOperationLoggerOperator(ctx), approval_id: req.id, tool: req.tool, pattern: req.pattern } as any);
  ctx.body = { approval: req };
});

router.post("/approvals/clear", permission({ level: ROLE.ADMIN }), async (ctx) => {
  ApprovalStore.clearDecided();
  ctx.body = { success: true };
});

// ---------------------------------------------------------------------------
// Snapshots / change history
// ---------------------------------------------------------------------------

router.get("/snapshots", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const sessionId = String(ctx.query.sessionId || "");
  ctx.body = { snapshots: SnapshotStore.list(sessionId || undefined) };
});

router.post("/snapshots/rollback", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) throw new Error("Snapshot id is required");
  const { restored } = SnapshotStore.rollback(id);
  operationLogger.log("agent_rollback", { ...getOperationLoggerOperator(ctx), snapshot_id: id } as any);
  ctx.body = { restored: restored != null };
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

router.get("/capabilities", permission({ level: ROLE.ADMIN }), async (ctx) => {
  ctx.body = {
    tools: [
      "timewait", "read_file", "list_files", "search_files", "read_log", "read_msl_log",
      "write_file", "patch_file", "delete_file", "move_file", "rollback_file", "list_snapshots", "compress",
      "instance_list", "instance_detail", "instance_open", "instance_stop", "instance_restart",
      "instance_kill", "instance_command", "instance_config_get", "instance_config_set",
      "instance_create", "instance_delete", "schedule_list",
      "msl_status", "msl_config_get", "msl_config_set", "msl_plugin_list", "msl_plugin_enable",
      "msl_plugin_disable", "msl_debug", "msl_plugin_template",
      "shell_command", "web_search", "fetch_page"
    ],
    specialModes: ["fix", "msl"],
    maxSteps: 40
  };
});

// ---------------------------------------------------------------------------
// Run (SSE or JSON)
// ---------------------------------------------------------------------------

router.post("/run", permission({ level: ROLE.ADMIN }), async (ctx) => {
  const body = ctx.request.body || {};
  const workspace = await resolveWorkspace(body.workspace, body.daemonId);
  const prompt = String(body.prompt || "").trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new Error("Invalid prompt");
  if (!fs.existsSync(workspace)) throw new Error("Workspace does not exist");
  const providerId = String(body.providerId || "");
  const sessionId = String(body.sessionId || "");
  const mode = body.mode || detectMode(prompt);
  const approved = body.approved === true;

  const wantsStream = ctx.accepts("text/event-stream") || body.stream === true;
  if (wantsStream) {
    ctx.respond = false;
    ctx.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    ctx.req.on("close", () => {
      // client disconnected -> abort the run
      if (sessionId) abortSession(sessionId);
    });
    const send = (event: string, data: unknown) => {
      ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const signal = new AbortController();
    if (sessionId) abortControllers.set(sessionId, signal);
    try {
      const result = await engine.run(
        { workspace, prompt, providerId, sessionId: sessionId || undefined, approved, mode, daemonId: body.daemonId, instanceUuid: body.instanceUuid, model: body.model },
        send,
        signal.signal
      );
      send("done", { success: true, message: result, workspace });
    } catch (e: any) {
      if (e instanceof AgentAbortError) {
        send("error", { message: "Run aborted by user", aborted: true });
      } else {
        send("error", { message: e.message });
      }
    } finally {
      if (sessionId) abortControllers.delete(sessionId);
      ctx.res.end();
    }
    return;
  }

  const signal = new AbortController();
  if (sessionId) abortControllers.set(sessionId, signal);
  try {
    const result = await engine.run(
      { workspace, prompt, providerId, sessionId: sessionId || undefined, approved, mode, daemonId: body.daemonId, instanceUuid: body.instanceUuid, model: body.model },
      () => {},
      signal.signal
    );
    ctx.body = { success: true, message: result, workspace };
  } finally {
    if (sessionId) abortControllers.delete(sessionId);
  }
});

export default router;