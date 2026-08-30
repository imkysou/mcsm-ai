import fs from "fs-extra";
import path from "path";
import { operationLogger } from "../operation_logger";
import RemoteRequest from "../remote_command";
import RemoteServiceSubsystem from "../remote_service";
import SnapshotStore from "./snapshots";
import { isReadOnlyShellCommand, runShellCommand, validateShellCommand } from "./shell_security";
import { fetchPageText, webSearch } from "./search";
import { readTextSmart } from "./encoding";
import { evaluatePermission, type PermissionRule } from "./permission";
import { applyPatchToContents, locateEdit, parsePatch } from "./editing";
import type { ApprovalStore } from "./approvals";
import type { Session } from "./types";

/**
 * Agent tool registry + implementations.
 *
 * Every tool is a plain async function `(args, ctx) => string` that returns a
 * text result the model can read. Tools that mutate files or control instances
 * require an approved approval record (created by the engine) before running.
 */

export interface ToolContext {
  session: Session;
  approved: boolean;
  /** Map of approvalId -> resolved approval record created for this turn. */
  approvals: Map<
    string,
    { tool: string; args: Record<string, any>; status: "approved" | "rejected"; reason?: string; permission?: string; pattern?: string; always?: boolean }
  >;
  /** Session ruleset (approved "always" rules + defaults). */
  rules: PermissionRule[];
  /** Provider-configured web search endpoint + key (can be undefined). */
  search?: { endpoint?: string; apiKey?: string };
  emit: (event: string, data: unknown) => void;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>;
  required?: string[];
  /** opencode-style permission key: edit / bash / instance / msl. */
  permission?: string;
  /** Resource pattern for this call (used for ask + "always allow"). */
  patternFor?: (args: Record<string, any>, ctx: ToolContext) => string;
  /** Whether this specific call needs approval (default true when permission set). */
  approvalNeeded?: boolean | ((args: Record<string, any>, ctx: ToolContext) => boolean);
  impl: (args: Record<string, any>, ctx: ToolContext) => Promise<string>;
}

const MAX_OUTPUT = 20000;
const MAX_FILE = 4 * 1024 * 1024;

/** Convert a glob pattern into a RegExp against posix-style relative paths. */
function globToRegex(pattern: string): RegExp {
  let re = '';
  const src = String(pattern || '').replace(/\\/g, '/');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '*' && src[i + 1] === '*') {
      if (src[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
      else { re += '.*'; i += 1; }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if ('()[]{}|^$+.\\'.indexOf(ch) >= 0) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$');
}

const clip = (v: unknown, n = MAX_OUTPUT) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '\n...[truncated]' : s;
};
function safe(root: string, item = ".") {
  const r = path.resolve(root);
  const p = path.resolve(r, String(item ?? "."));
  if (p !== r && !p.startsWith(r + path.sep)) throw new Error("Path escapes workspace");
  return p;
}

function isTextFile(file: string, size: number) {
  if (size > MAX_FILE) return false;
  const ext = path.extname(file).toLowerCase();
  const binaryExts = [
    ".jar", ".zip", ".gz", ".rar", ".7z", ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".ico", ".bin", ".class", ".dat", ".db", ".sqlite", ".ogg", ".mp3", ".mp4",
    ".exe", ".dll", ".so", ".dylib", ".keystore", ".jks", ".p12", ".crt", ".pem", ".key"
  ];
  if (binaryExts.includes(ext)) return false;
  try {
    const buf = fs.readFileSync(file);
    const sample = buf.subarray(0, 4096);
    for (const b of sample) {
      if (b === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function readFileText(file: string) {
  if (!isTextFile(file, fs.statSync(file).size)) {
    return `(binary or oversized file: ${path.basename(file)} - not shown)`;
  }
  return await readTextSmart(file);
}

// ---------------------------------------------------------------------------
// Approval helper
// ---------------------------------------------------------------------------

function requireApproval(ctx: ToolContext, toolName: string, args: Record<string, any>): void {
  if (ctx.approved) return;
  const tool = findTool(toolName);
  if (tool?.permission) {
    const pattern = tool.patternFor ? tool.patternFor(args, ctx) : toolName;
    if (evaluatePermission(ctx.rules, tool.permission, pattern) === "allow") return;
  }
  for (const [id, rec] of ctx.approvals) {
    if (rec.tool === toolName && rec.status === "approved") return;
    if (rec.tool === toolName && rec.status === "rejected") {
      throw new Error(`Action was rejected: ${rec.reason || "no reason given"}`);
    }
  }
  throw new Error(`PENDING_APPROVAL: "${toolName}" requires your approval`);
}

// ---------------------------------------------------------------------------
// Instance helpers (talk to the daemon over its socket)
// ---------------------------------------------------------------------------

async function daemonRequest(daemonId: string, event: string, data: any, timeout = 60000) {
  const remote = RemoteServiceSubsystem.getInstance(daemonId);
  if (!remote) throw new Error(`Daemon ${daemonId} not found`);
  return await new RemoteRequest(remote).request(event, data, timeout);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function p(properties: Record<string, any>, required: string[] = []) {
  return { type: "object", properties, required };
}

const s = (description: string) => ({ type: "string", description });

export function buildTools(): ToolDef[] {
  return [
    // ---------- timing ----------
    {
      name: "timewait",
      description:
        "Sleep/wait for a given number of milliseconds before continuing - use it to wait for a Minecraft server to finish starting, restarting, or a plugin to load, then check the logs again. Never claim you waited unless you actually called this tool.",
      parameters: p({ ms: s("Milliseconds to wait (1 - 120000, default 1000)") }, []),
      impl: async (a) => {
        const ms = Math.min(120000, Math.max(0, Number(a.ms) || 1000));
        await new Promise((resolve) => setTimeout(resolve, ms));
        return "Waited " + ms + " ms";
      }
    },
    // ---------- filesystem ----------
    {
      name: "read_file",
      description:
        "Read a text file inside the workspace (max 4MB). Lines are numbered so exact blocks can be edited later. Use offset/limit for large files.",
      parameters: p(
        { path: s("Relative path inside the workspace"), offset: s('1-based starting line (default 1)'), limit: s("Max lines to return (default 2000, max 4000)") },
        ["path"]
      ),
      impl: async (a, ctx) => {
        const file = safe(ctx.session.workspace, a.path);
        if (!fs.existsSync(file)) throw new Error("File not found");
        const content = await readFileText(file);
        const lines = content.split(/\r?\n/);
        const offset = Math.max(1, Number(a.offset) || 1);
        const limit = Math.min(4000, Math.max(1, Number(a.limit) || 2000));
        let out = "# " + String(a.path) + " (" + lines.length + " lines, " + Buffer.byteLength(content) + " B)\n";
        out += lines
          .slice(offset - 1, offset - 1 + limit)
          .map((l, i) => String(offset + i) + "  " + l)
          .join("\n");
        if (offset - 1 + limit < lines.length) {
          out += "\n... [" + (lines.length - (offset - 1 + limit)) + " more lines - use offset=" + (offset + limit) + " to continue]";
        }
        return clip(out);
      }
    },
    {
      name: "list_files",
      description: "List files/directories in a workspace folder.",
      parameters: p({ path: s("Folder relative to workspace, default '.'") }),
      impl: async (a, ctx) => {
        const dir = safe(ctx.session.workspace, a.path || ".");
        const es = await fs.readdir(dir, { withFileTypes: true });
        return es
          .slice(0, 500)
          .map((e) => {
            let extra = "";
            try {
              if (!e.isDirectory()) {
                const st = fs.statSync(path.join(dir, e.name));
                extra = `  ${st.size} B`;
              }
            } catch { /* ignore */ }
            return `${e.isDirectory() ? "d" : "f"} ${e.name}${extra}`;
          })
          .join("\n");
      }
    },
    {
      name: "search_files",
      description: "Recursively search file contents for a string in the workspace.",
      parameters: p({ query: s("Text to search"), path: s("Start folder, default workspace root") }, ["query"]),
      impl: async (a, ctx) => {
        const q = String(a.query || "");
        if (!q || q.length > 300) throw new Error("Invalid query");
        const root = safe(ctx.session.workspace, a.path || ".");
        const out: string[] = [];
        const walk = async (d: string) => {
          if (out.length >= 100) return;
          for (const e of await fs.readdir(d, { withFileTypes: true })) {
            if (["node_modules", ".git", ".msl_logs", "logs", "cache"].includes(e.name)) continue;
            const full = path.join(d, e.name);
            if (e.isDirectory()) await walk(full);
            else {
              try {
                const st = fs.statSync(full);
                if (st.size > MAX_FILE) continue;
                if ((await readTextSmart(full)).toLowerCase().includes(q.toLowerCase())) {
                  out.push(path.relative(root, full));
                }
              } catch { /* ignore */ }
            }
          }
        };
        await walk(root);
        return out.join("\n") || "No matches";
      }
    },
    {
      name: "write_file",
      description: "Create or overwrite a text file in the workspace. Requires approval.",
      parameters: p({ path: s("Relative path inside the workspace"), content: s("Full new file content") }, ["path", "content"]),
      permission: "edit",
      patternFor: (a, ctx) => "edit:" + String(a.path || ""),
      impl: async (a, ctx) => {
        requireApproval(ctx, "write_file", a);
        const file = safe(ctx.session.workspace, a.path);
        const content = String(a.content ?? "");
        if (content.length > MAX_FILE) throw new Error("File too large");
        const before = fs.existsSync(file) ? await readFileText(file) : null;
        await fs.ensureDir(path.dirname(file));
        await fs.writeFile(file, content, "utf-8");
        SnapshotStore.record({
          sessionId: ctx.session.id,
          workspace: ctx.session.workspace,
          path: file,
          before,
          after: content
        });
        logAudit(ctx, "agent_write_file", { file: path.relative(ctx.session.workspace, file) });
        return `Written ${path.relative(ctx.session.workspace, file)} (${Buffer.byteLength(content)} bytes)`;
      }
    },
    {
      name: "patch_file",
      description:
        "Apply an exact text replacement to an existing file (opencode edit semantics). old_text must match exactly, including whitespace/indentation; provide enough surrounding context so it is unique. Lines are verified against the real file before writing - read_file first (it returns line numbers).",
      parameters: p(
        { path: s("Relative path"), old_text: s("Exact text to replace"), new_text: s("Replacement text (must differ)") },
        ["path", "old_text", "new_text"]
      ),
      permission: "edit",
      patternFor: (a, ctx) => "edit:" + String(a.path || ""),
      impl: async (a, ctx) => {
        requireApproval(ctx, "patch_file", a);
        const file = safe(ctx.session.workspace, a.path);
        const oldText = String(a.old_text ?? "");
        const newText = String(a.new_text ?? "");
        if (!oldText) throw new Error("old_text is required");
        if (oldText === newText) throw new Error("No changes to apply: old_text and new_text are identical");
        const before = await readFileText(file);
        const span = locateEdit(before, oldText);
        const after = before.slice(0, span.start) + newText + before.slice(span.end);
        await fs.writeFile(file, after, "utf-8");
        SnapshotStore.record({ sessionId: ctx.session.id, workspace: ctx.session.workspace, path: file, before, after });
        logAudit(ctx, "agent_patch_file", { file: path.relative(ctx.session.workspace, file) });
        return "Patched " + path.relative(ctx.session.workspace, file) + " (lines " + span.startLine + "-" + span.endLine + ", " + oldText.length + " -> " + newText.length + " chars)";
      }
    },
    {
      name: "apply_patch",
      description:
        "Apply a unified diff to one or more files (opencode/SWE-agent style). Use '*** Update File: <relative path>' sections, each with '@@ -a,b +c,d @@' hunks - context lines start with a space, removals with '-', additions with '+'. The whole patch is validated first and applies atomically; on mismatch nothing is written.",
      parameters: p({ patch: s("The full patch text describing all changes") }, ["patch"]),
      permission: "edit",
      patternFor: (a) => "edit:patch:" + String(a.patch || "").slice(0, 120),
      impl: async (a, ctx) => {
        requireApproval(ctx, "apply_patch", a);
        const patchText = String(a.patch || "");
        if (!patchText.trim()) throw new Error("patch is required");
        if (patchText.length > 200000) throw new Error("Patch too large (max 200KB)");
        const files = parsePatch(patchText);
        const contents = new Map<string, string>();
        const ordered: string[] = [];
        for (const f of files) {
          if (!f.path) throw new Error("apply_patch: '*** Update File: <path>' header missing");
          if (!f.hunks.length) continue;
          const file = safe(ctx.session.workspace, f.path);
          if (!fs.existsSync(file)) throw new Error("File not found: " + f.path);
          contents.set(f.path, await readTextSmart(file));
          ordered.push(f.path);
        }
        if (!ordered.length) throw new Error("No valid hunks in patch");
        const beforeMap = new Map(contents);
        applyPatchToContents(contents, files);
        let written = 0;
        for (const rel of ordered) {
          const after = contents.get(rel) || "";
          if (after === beforeMap.get(rel)) continue;
          const file = safe(ctx.session.workspace, rel);
          await fs.writeFile(file, after, "utf-8");
          SnapshotStore.record({ sessionId: ctx.session.id, workspace: ctx.session.workspace, path: file, before: beforeMap.get(rel) || null, after });
          logAudit(ctx, "agent_apply_patch", { file: rel });
          written++;
        }
        return "Applied patch to " + written + " file(s): " + ordered.join(", ");
      }
    },
    {
      name: "glob",
      description:
        "List files matching a glob pattern, e.g. '**/*.yml', 'plugins/**/*.js', 'config/*.json'. Skips node_modules/.git/cache/logs.",
      parameters: p({ pattern: s("Glob pattern (** = any depth, * = within one segment)"), path: s("Start folder relative to workspace, default '.'") }, ["pattern"]),
      impl: async (a, ctx) => {
        const pattern = String(a.pattern || "").trim();
        if (!pattern || pattern.length > 300) throw new Error("Invalid pattern");
        const root = safe(ctx.session.workspace, a.path || ".");
        const regex = globToRegex(pattern);
        const out: string[] = [];
        const walk = async (dir: string, base: string) => {
          if (out.length >= 500) return;
          for (const e of await fs.readdir(dir, { withFileTypes: true })) {
            if (["node_modules", ".git", "cache", "logs", ".msl_logs"].includes(e.name)) continue;
            const rel = base ? base + "/" + e.name : e.name;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full, rel);
            else if (regex.test(rel)) out.push(rel);
          }
        };
        await walk(root, "");
        return out.slice(0, 500).join("\n") || "No matches";
      }
    },
    {
      name: "delete_file",
      description: "Delete a file (or empty directory). Requires approval.",
      parameters: p({ path: s("Relative path"), recursive: s("Allow recursive directory delete") }, ["path"]),
      permission: "edit",
      patternFor: (a, ctx) => "edit:" + String(a.path || ""),
      impl: async (a, ctx) => {
        requireApproval(ctx, "delete_file", a);
        const file = safe(ctx.session.workspace, a.path);
        const st = await fs.stat(file);
        const before = st.isFile() ? await readFileText(file) : null;
        if (st.isDirectory() && !a.recursive) throw new Error("Use recursive:true to delete a directory");
        await fs.remove(file);
        SnapshotStore.record({ sessionId: ctx.session.id, workspace: ctx.session.workspace, path: file, before, after: null });
        logAudit(ctx, "agent_delete_file", { file: path.relative(ctx.session.workspace, file) });
        return "Deleted";
      }
    },
    {
      name: "move_file",
      description: "Move or rename a file/directory inside the workspace. Requires approval.",
      parameters: p({ source: s("Relative source path"), target: s("Relative target path") }, ["source", "target"]),
      permission: "edit",
      patternFor: (a) => "edit:" + String(a.source || "") + "->" + String(a.target || ""),
      impl: async (a, ctx) => {
        requireApproval(ctx, "move_file", a);
        const src = safe(ctx.session.workspace, a.source);
        const dst = safe(ctx.session.workspace, a.target);
        await fs.move(src, dst, { overwrite: false });
        logAudit(ctx, "agent_move_file", { from: a.source, to: a.target });
        return "Moved";
      }
    },
    {
      name: "rollback_file",
      description: "Roll back a previous Agent file change by snapshot id.",
      parameters: p({ snapshot_id: s("Snapshot id returned by write_file/patch_file/delete_file") }, ["snapshot_id"]),
      permission: "edit",
      patternFor: (a) => "edit:rollback:" + String(a.snapshot_id || ""),
      impl: async (a, ctx) => {
        requireApproval(ctx, "rollback_file", a);
        const { restored } = SnapshotStore.rollback(String(a.snapshot_id));
        return restored == null ? "File restored to deleted state" : "File rolled back to previous content";
      }
    },
    {
      name: "list_snapshots",
      description: "List recent Agent file modifications for this session.",
      parameters: p({}),
      impl: async (_a, ctx) => {
        const list = SnapshotStore.list(ctx.session.id, 50);
        return list
          .map((s) => `${s.id}  ${s.relativePath}  ${s.rolledBack ? "[rolled back]" : ""}  ${s.createdAt}`)
          .join("\n") || "No snapshots yet";
      }
    },
    {
      name: "compress",
      description: "Compress a folder/file inside the workspace into a .zip. Requires approval.",
      parameters: p({ source: s("Relative source path"), target: s("Relative .zip path") }, ["source", "target"]),
      permission: "edit",
      patternFor: (a) => "edit:compress:" + String(a.source || ""),
      impl: async (a, ctx) => {
        requireApproval(ctx, "compress", a);
        const src = safe(ctx.session.workspace, a.source);
        const dst = safe(ctx.session.workspace, a.target);
        const compress = await import("mcsmanager-common");
        if (typeof (compress as any).compress === "function") {
          await (compress as any).compress(src, dst);
          return `Compressed to ${a.target}`;
        }
        throw new Error("Compression library unavailable");
      }
    },

    // ---------- logs ----------
    {
      name: "read_log",
      description: "Read a log file (default logs/latest.log) - use first when diagnosing failures.",
      parameters: p({ path: s("Log path relative to workspace, e.g. logs/latest.log"), tail: s("Lines from the end, default 200") }),
      impl: async (a, ctx) => {
        const pth = String(a.path || "logs/latest.log");
        const tail = Math.max(10, Math.min(2000, Number(a.tail) || 200));
        const file = safe(ctx.session.workspace, pth);
        if (!fs.existsSync(file)) {
          // fall back to the newest log in logs/
          const logsDir = safe(ctx.session.workspace, "logs");
          const candidates = fs.existsSync(logsDir)
            ? fs.readdirSync(logsDir).filter((f) => f.endsWith(".log")).sort().reverse()
            : [];
          if (!candidates.length) throw new Error(`No log file found at ${pth}`);
          return `(latest.log not found; using ${candidates[0]})\n` + await readTail(path.join(logsDir, candidates[0]), tail);
        }
        return await readTail(file, tail);
      }
    },
    {
      name: "read_msl_log",
      description: "Read MSL runtime logs (.msl_logs/msl.log) for the bound instance.",
      parameters: p({ tail: s("Lines from the end, default 200") }),
      impl: async (a, ctx) => {
        const tail = Math.max(10, Math.min(2000, Number(a.tail) || 200));
        const file = safe(ctx.session.workspace, ".msl_logs/msl.log");
        if (!fs.existsSync(file)) throw new Error("No MSL log found (MSL may be disabled)");
        return await readTail(file, tail);
      }
    },

    // ---------- instance control ----------
    {
      name: "instance_list",
      description: "List all instances on the bound daemon.",
      parameters: p({}),
      impl: async (_a, ctx) => {
        const res = await daemonRequest(ctx.session.daemonId!, "instance/select", { page: 1, pageSize: 100, condition: {} });
        const rows = (res?.data || []).map((i: any) => {
          const st = i.status === 3 ? "running" : i.status === 0 ? "stopped" : `state:${i.status}`;
          return `${i.instanceUuid}  ${i.config?.nickname}  [${st}]  type=${i.config?.type}`;
        });
        return rows.join("\n") || "No instances";
      }
    },
    {
      name: "instance_detail",
      description: "Get detailed info + recent output log of an instance.",
      parameters: p({ instance_uuid: s("Instance UUID") }, ["instance_uuid"]),
      impl: async (a, ctx) => {
        const res = await daemonRequest(ctx.session.daemonId!, "instance/detail", { instanceUuid: a.instance_uuid });
        const cfg = res?.config || {};
        const info = res?.info || {};
        let out = `Instance ${res?.instanceUuid} "${cfg.nickname}"\n`;
        out += `status: ${res?.status} type: ${cfg.type} cwd: ${cfg.cwd}\n`;
        out += `startCommand: ${cfg.startCommand}\n`;
        out += `players: ${info.currentPlayers}/${info.maxPlayers} version: ${info.version} ping: ${info.latency}\n`;
        try {
          const log = await daemonRequest(ctx.session.daemonId!, "instance/outputlog", { instanceUuid: a.instance_uuid, size: 300 });
          out += `\n--- recent output ---\n${String(log || "").slice(-MAX_OUTPUT)}`;
        } catch { /* log may be unavailable */ }
        return clip(out);
      }
    },
    {
      name: "instance_open",
      description: "Start an instance. Requires approval.",
      parameters: p({ instance_uuid: s("Instance UUID") }, ["instance_uuid"]),
      permission: "instance",
      patternFor: (a) => "instance:" + String(a.instance_uuid || "") + ":open",
      impl: async (a, ctx) => {
        requireApproval(ctx, "instance_open", a);
        const res = await daemonRequest(ctx.session.daemonId!, "instance/open", { instanceUuids: [a.instance_uuid] });
        logAudit(ctx, "agent_instance_open", { instance: a.instance_uuid });
        return clip(res);
      }
    },
    {
      name: "instance_stop",
      description: "Gracefully stop an instance. Requires approval.",
      parameters: p({ instance_uuid: s("Instance UUID") }, ["instance_uuid"]),
      permission: "instance",
      patternFor: (a) => "instance:" + String(a.instance_uuid || "") + ":stop",
      impl: async (a, ctx) => {
        requireApproval(ctx, "instance_stop", a);
        const res = await daemonRequest(ctx.session.daemonId!, "instance/stop", { instanceUuids: [a.instance_uuid] });
        logAudit(ctx, "agent_instance_stop", { instance: a.instance_uuid });
        return clip(res);
      }
    },
    {
      name: "instance_restart",
      description: "Restart an instance. Requires approval.",
      parameters: p({ instance_uuid: s("Instance UUID") }, ["instance_uuid"]),
      permission: "instance",
      patternFor: (a) => "instance:" + String(a.instance_uuid || "") + ":restart",
      impl: async (a, ctx) => {
        requireApproval(ctx, "instance_restart", a);
        const res = await daemonRequest(ctx.session.daemonId!, "instance/restart", { instanceUuids: [a.instance_uuid] });
        logAudit(ctx, "agent_instance_restart", { instance: a.instance_uuid });
        return clip(res);
      }
    },
    {
      name: "instance_kill",
      description: "Force kill an instance. Requires approval.",
      parameters: p({ instance_uuid: s("Instance UUID") }, ["instance_uuid"]),
      permission: "instance",
      patternFor: (a) => "instance:" + String(a.instance_uuid || "") + ":kill",
      impl: async (a, ctx) => {
        requireApproval(ctx, "instance_kill", a);
        const res = await daemonRequest(ctx.session.daemonId!, "instance/kill", { instanceUuids: [a.instance_uuid] });
        logAudit(ctx, "agent_instance_kill", { instance: a.instance_uuid });
        return clip(res);
      }
    },
    {
      name: "instance_command",
      description: "Send a console command to a running instance (e.g. 'say hello', 'list'). Requires approval.",
      parameters: p({ instance_uuid: s("Instance UUID"), command: s("Command text") }, ["instance_uuid", "command"]),
      permission: "instance",
      patternFor: (a) => "instance:" + String(a.instance_uuid || "") + ":command",
      impl: async (a, ctx) => {
        requireApproval(ctx, "instance_command", a);
        const cmd = String(a.command || "");
        if (!cmd || cmd.length > 2000) throw new Error("Invalid command");
        await daemonRequest(ctx.session.daemonId!, "instance/command", { instanceUuid: a.instance_uuid, command: cmd }, 15000);
        logAudit(ctx, "agent_instance_command", { instance: a.instance_uuid, command: cmd.slice(0, 200) });
        return "Command sent";
      }
    },
    {
      name: "instance_config_get",
      description: "Read the full instance configuration.",
      parameters: p({ instance_uuid: s("Instance UUID") }, ["instance_uuid"]),
      impl: async (a, ctx) => {
        const res = await daemonRequest(ctx.session.daemonId!, "instance/detail", { instanceUuid: a.instance_uuid });
        return clip(res?.config);
      }
    },
    {
      name: "instance_config_set",
      description: "Update instance configuration fields (nickname, startCommand, stopCommand, type, tag, etc.). Requires approval.",
      parameters: p({ instance_uuid: s("Instance UUID"), config: s("JSON object with fields to update") }, ["instance_uuid", "config"]),
      permission: "instance",
      patternFor: (a) => "instance:" + String(a.instance_uuid || "") + ":config",
      impl: async (a, ctx) => {
        requireApproval(ctx, "instance_config_set", a);
        let cfg: Record<string, any>;
        try {
          cfg = typeof a.config === "string" ? JSON.parse(a.config) : a.config;
        } catch {
          throw new Error("config must be valid JSON");
        }
        if (!cfg || typeof cfg !== "object") throw new Error("config must be an object");
        const res = await daemonRequest(ctx.session.daemonId!, "instance/update", { instanceUuid: a.instance_uuid, config: cfg });
        logAudit(ctx, "agent_instance_config_set", { instance: a.instance_uuid, fields: Object.keys(cfg).join(",") });
        return clip(res);
      }
    },
    {
      name: "instance_create",
      description: "Create a new instance on the bound daemon. Requires approval.",
      parameters: p(
        {
          nickname: s("Instance name"),
          type: s("Instance type, e.g. minecraft/java"),
          cwd: s("Working directory relative to daemon instances dir"),
          startCommand: s("Start command"),
          tag: s("Comma-separated tags")
        },
        ["nickname", "type"]
      ),
      permission: "instance",
      patternFor: () => "instance:*:create",
      impl: async (a, ctx) => {
        requireApproval(ctx, "instance_create", a);
        const res = await daemonRequest(ctx.session.daemonId!, "instance/new", {
          nickname: String(a.nickname).slice(0, 60),
          type: String(a.type),
          cwd: String(a.cwd || ""),
          startCommand: String(a.startCommand || "").slice(0, 2000),
          tag: String(a.tag || "").split(",").map((t) => t.trim()).filter(Boolean)
        });
        logAudit(ctx, "agent_instance_create", { nickname: a.nickname });
        return clip(res);
      }
    },
    {
      name: "instance_delete",
      description: "Delete an instance (config; files remain). Requires approval.",
      parameters: p({ instance_uuid: s("Instance UUID") }, ["instance_uuid"]),
      permission: "instance",
      patternFor: (a) => "instance:" + String(a.instance_uuid || "") + ":delete",
      impl: async (a, ctx) => {
        requireApproval(ctx, "instance_delete", a);
        const res = await daemonRequest(ctx.session.daemonId!, "instance/delete", { instanceUuid: a.instance_uuid });
        logAudit(ctx, "agent_instance_delete", { instance: a.instance_uuid });
        return clip(res);
      }
    },
    {
      name: "schedule_list",
      description: "List scheduled tasks on the bound daemon.",
      parameters: p({}),
      impl: async (_a, ctx) => {
        const res = await daemonRequest(ctx.session.daemonId!, "schedule/list", {});
        return clip(res);
      }
    },

    // ---------- MSL ----------
    {
      name: "msl_status",
      description: "Get MSL status for the bound instance (enabled, debug, plugins, running).",
      parameters: p({}),
      impl: async (_a, ctx) => {
        if (!ctx.session.instanceUuid) throw new Error("This session is not bound to an instance");
        const res = await daemonRequest(ctx.session.daemonId!, "msl/status", { instanceUuid: ctx.session.instanceUuid });
        return clip(res);
      }
    },
    {
      name: "msl_config_get",
      description: "Read the MSL configuration of the bound instance.",
      parameters: p({}),
      impl: async (_a, ctx) => {
        if (!ctx.session.instanceUuid) throw new Error("This session is not bound to an instance");
        const res = await daemonRequest(ctx.session.daemonId!, "msl/config", { instanceUuid: ctx.session.instanceUuid });
        return clip(res);
      }
    },
    {
      name: "msl_config_set",
      description: "Update MSL config (enabled, debug, autoRestart, logRegexs). Requires approval.",
      parameters: p({ config: s("JSON object with MSL fields") }, ["config"]),
      permission: "msl",
      patternFor: (a) => "msl:config:" + Object.keys((typeof a.config === "string" ? {} : (a.config || {}))).join(","),
      impl: async (a, ctx) => {
        requireApproval(ctx, "msl_config_set", a);
        if (!ctx.session.instanceUuid) throw new Error("This session is not bound to an instance");
        let cfg: Record<string, any>;
        try {
          cfg = typeof a.config === "string" ? JSON.parse(a.config) : a.config;
        } catch {
          throw new Error("config must be valid JSON");
        }
        const res = await daemonRequest(ctx.session.daemonId!, "msl/config", { instanceUuid: ctx.session.instanceUuid, config: cfg });
        logAudit(ctx, "agent_msl_config_set", { fields: Object.keys(cfg).join(",") });
        return clip(res);
      }
    },
    {
      name: "msl_plugin_list",
      description: "List MSL plugins and their load status for the bound instance.",
      parameters: p({}),
      impl: async (_a, ctx) => {
        if (!ctx.session.instanceUuid) throw new Error("This session is not bound to an instance");
        const dir = safe(ctx.session.workspace, "plugins");
        const files = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter((f) => f.endsWith(".js"))
          : [];
        const res = await daemonRequest(ctx.session.daemonId!, "msl/status", { instanceUuid: ctx.session.instanceUuid });
        const loaded = res?.plugins || [];
        return files
          .map((f) => `${f}  ${loaded.includes(path.basename(f, ".js")) ? "[loaded]" : "[not loaded]"}`)
          .join("\n") || "No plugins found";
      }
    },
    {
      name: "msl_plugin_enable",
      description: "Load an MSL plugin (or 'all'). Requires approval.",
      parameters: p({ name: s("Plugin name without .js") }, ["name"]),
      permission: "msl",
      patternFor: (a) => "msl:plugin_enable:" + String(a.name || ""),
      impl: async (a, ctx) => {
        requireApproval(ctx, "msl_plugin_enable", a);
        if (!ctx.session.instanceUuid) throw new Error("This session is not bound to an instance");
        const res = await daemonRequest(ctx.session.daemonId!, "msl/plugin_enable", { instanceUuid: ctx.session.instanceUuid, name: String(a.name) });
        return clip(res);
      }
    },
    {
      name: "msl_plugin_disable",
      description: "Unload an MSL plugin (or 'all'). Requires approval.",
      parameters: p({ name: s("Plugin name without .js") }, ["name"]),
      permission: "msl",
      patternFor: (a) => "msl:plugin_disable:" + String(a.name || ""),
      impl: async (a, ctx) => {
        requireApproval(ctx, "msl_plugin_disable", a);
        if (!ctx.session.instanceUuid) throw new Error("This session is not bound to an instance");
        const res = await daemonRequest(ctx.session.daemonId!, "msl/plugin_disable", { instanceUuid: ctx.session.instanceUuid, name: String(a.name) });
        return clip(res);
      }
    },
    {
      name: "msl_debug",
      description: "Turn MSL debug mode on/off for the bound instance. Requires approval.",
      parameters: p({ enabled: s("true or false") }, ["enabled"]),
      permission: "msl",
      patternFor: () => "msl:debug",
      impl: async (a, ctx) => {
        requireApproval(ctx, "msl_debug", a);
        if (!ctx.session.instanceUuid) throw new Error("This session is not bound to an instance");
        const res = await daemonRequest(ctx.session.daemonId!, "msl/debug", { instanceUuid: ctx.session.instanceUuid, enabled: Boolean(a.enabled) });
        return clip(res);
      }
    },
    {
      name: "msl_plugin_template",
      description: "Generate an MSL plugin scaffold file. Requires approval.",
      parameters: p({ name: s("Plugin name"), purpose: s("What the plugin should do") }, ["name", "purpose"]),
      permission: "msl",
      patternFor: (a) => "msl:template:" + String(a.name || ""),
      impl: async (a, ctx) => {
        requireApproval(ctx, "msl_plugin_template", a);
        // Keep the name as the user/AI wrote it (Chinese names are legal - the
        // MSL loader matches the file base name exactly). Strip only what could
        // escape the plugins folder or make an invalid file name on Windows.
        const name = String(a.name)
          .replace(/[\\/:*?"'`<>|$\x00-\x1f]/g, "_")
          .replace(/\.js$/i, "")
          .trim()
          .slice(0, 40);
        if (!name || name === "." || name === "..") throw new Error("Invalid plugin name");
        const purpose = String(a.purpose || "").slice(0, 500);
        const dir = safe(ctx.session.workspace, "plugins");
        await fs.ensureDir(dir);
        const file = path.join(dir, `${name}.js`);
        const before = fs.existsSync(file) ? await readFileText(file) : null;
        const content = `// MSL plugin: ${name}
// Purpose: ${purpose}
plugin_log("INFO", "${name} loaded");

plugin_onEvent("serverStart", () => {
  plugin_log("INFO", "${name}: server started");
});

plugin_onEvent("serverStop", () => {
  plugin_log("INFO", "${name}: server stopped");
});

plugin_onEvent("playerJoin", (time, player) => {
  plugin_log("INFO", \`${name}: \${player} joined\`);
});

plugin_onEvent("playerQuit", (time, player) => {
  plugin_log("INFO", \`${name}: \${player} left\`);
});

plugin_registerCommand("!${name.toLowerCase()} <text>", (player, text) => {
  plugin_executeCommand(\`say [\${player}] \${text}\`);
});
`;
        await fs.writeFile(file, content, "utf-8");
        SnapshotStore.record({ sessionId: ctx.session.id, workspace: ctx.session.workspace, path: file, before, after: content });
        logAudit(ctx, "agent_msl_plugin_template", { plugin: name });
        return `Created plugins/${name}.js. Run msl_plugin_enable with name=${name} to load it.`;
      }
    },

    // ---------- shell / network ----------
    {
      name: "shell_command",
      description:
        "Run a safe shell command inside the workspace (no pipes, no shell metacharacters). " +
        "Allowed binaries: cat, ls, pwd, echo, head, tail, grep, wc, find, df, du, uname, curl, wget, java, node, python. Requires approval.",
      parameters: p({ command: s("Command line, e.g. `cat server.properties` or `curl -s https://example.com`") }, ["command"]),
      permission: "bash",
      // opencode asks for bash only when the command actually touches files or
      // runs an interpreter; pure inspection (ls/grep/head/...) runs silently.
      approvalNeeded: (a, ctx) => !isReadOnlyShellCommand(String(a.command || ""), ctx.session.workspace),
      patternFor: (a) => "bash:" + String(a.command || "").slice(0, 2000),
      impl: async (a, ctx) => {
        requireApproval(ctx, "shell_command", a);
        const raw = String(a.command || "").slice(0, 4096);
        const { argv } = validateShellCommand(raw, ctx.session.workspace);
        const result = await runShellCommand(argv, { cwd: ctx.session.workspace, timeoutMs: 60000 });
        logAudit(ctx, "agent_shell", { command: raw.slice(0, 200), code: result.code });
        const out = `[exit ${result.code ?? "timeout"}] ${result.durationMs}ms\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
        return clip(out);
      }
    },
    {
      name: "web_search",
      description: "Search the web using the provider-configured search service (Tavily/Serper/Brave/Bing/SearXNG/DDG).",
      parameters: p({ query: s("Search query") }, ["query"]),
      impl: async (a, ctx) => {
        const { webSearch: doSearch } = await import("./search");
        const query = String(a.query || "").slice(0, 500);
        if (!query) throw new Error("Query required");
        // MCSM-AI: search config lives on the model provider (searchEndpoint +
        // searchApiKey). Guess the adapter from the endpoint; no endpoint => honest error.
        const endpoint = String(ctx.search?.endpoint || "").trim();
        if (!endpoint) {
          return "Web search is NOT configured: configure searchEndpoint + searchApiKey for the model provider in the AI Agent provider settings.";
        }
        const e = endpoint.toLowerCase();
        const provider = e.includes("serper")
          ? "serper"
          : e.includes("brave")
            ? "brave"
            : e.includes("bing")
              ? "bing"
              : e.includes("searx")
                ? "searxng"
                : e.includes("duckduckgo")
                  ? "duckduckgo"
                  : e.includes("tavily")
                    ? "tavily"
                    : "custom";
        const items = await doSearch(query, { provider, endpoint, apiKey: ctx.search?.apiKey || "", maxResults: 5 });
        if (!items.length) return "No search results";
        return items.map((i, n) => `${n + 1}. ${i.title}\n   ${i.url}\n   ${i.snippet}`).join("\n\n");
      }
    },
    {
      name: "fetch_page",
      description: "Fetch and extract readable text from a web page (for research).",
      parameters: p({ url: s("Absolute http(s) URL") }, ["url"]),
      impl: async (a) => {
        const url = String(a.url || "").slice(0, 2000);
        const text = await fetchPageText(url);
        return clip(text);
      }
    }
  ];
}

async function readTail(file: string, tail: number) {
  const data = await readTextSmart(file);
  const lines = data.split(/\r?\n/);
  return lines.slice(-tail).join("\n");
}

function logAudit(ctx: ToolContext, type: string, detail: Record<string, any>) {
  try {
    operationLogger.log(type as any, {
      operator_name: "agent",
      operator_ip: "local",
      ...detail,
      session_id: ctx.session.id,
      workspace: ctx.session.workspace
    } as any);
  } catch {
    /* audit is best-effort */
  }
}

/** Resolve tool by name; throws when unknown. */
export function findTool(name: string): ToolDef | undefined {
  return buildTools().find((t) => t.name === name);
}

/** Get the OpenAI-style tool definitions. */
export function toolDefinitions() {
  return buildTools().map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

export const requiresApproval = (name: string) =>
  Boolean(buildTools().find((t) => t.name === name)?.permission);

export type { ApprovalStore };
