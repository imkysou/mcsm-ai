import fs from "fs-extra";
import path from "path";
import { agentDir, readJson, writeJsonAtomic, withLock } from "./store_util";
import type { ApprovalRequest } from "./types";

/**
 * Persistent approval queue. Dangerous Agent actions (file writes, instance
 * control, shell commands, rollbacks) are held here until the single admin
 * approves or rejects them from the web UI. Requests expire after a TTL.
 */

const APPROVALS_DIR = () => path.join(agentDir(), "approvals");
const APPROVAL_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PENDING = 100;

function approvalFile(id: string) {
  return path.join(APPROVALS_DIR(), `${id}.json`);
}

function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) throw new Error("Invalid approval id");
  return id;
}

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

export class ApprovalStore {
  list(): ApprovalRequest[] {
    fs.ensureDirSync(APPROVALS_DIR());
    const files = fs
      .readdirSync(APPROVALS_DIR())
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    const out: ApprovalRequest[] = [];
    for (const f of files.slice(0, 200)) {
      const a = readJson<ApprovalRequest>(path.join(APPROVALS_DIR(), f), null as any);
      if (a && a.id) {
        if (a.status === "pending" && new Date(a.expiresAt).getTime() < Date.now()) {
          a.status = "expired";
          writeJsonAtomic(path.join(APPROVALS_DIR(), f), a);
        }
        out.push(a);
      }
    }
    return out;
  }

  get(id: string): ApprovalRequest | null {
    return readJson<ApprovalRequest>(approvalFile(safeId(id)), null as any);
  }

  create(input: {
    sessionId: string;
    tool: string;
    args: Record<string, unknown>;
    reason: string;
    permission?: string;
    pattern?: string;
  }): ApprovalRequest {
    const req: ApprovalRequest = {
      id: [Date.now().toString(36), Math.random().toString(36).slice(2, 8)].join(""),
      sessionId: input.sessionId,
      tool: input.tool,
      args: input.args,
      reason: input.reason,
      permission: input.permission,
      pattern: input.pattern,
      status: "pending",
      createdAt: nowIso(),
      expiresAt: nowIso(APPROVAL_TTL_MS)
    };
    writeJsonAtomic(approvalFile(req.id), req);
    // Keep disk bounded
    const pending = this.list().filter((a) => a.status === "pending");
    if (pending.length > MAX_PENDING) {
      const oldest = pending.slice(MAX_PENDING);
      for (const old of oldest) this.remove(old.id);
    }
    return req;
  }

  async decide(id: string, approved: boolean, operator = "admin", always = false): Promise<ApprovalRequest> {
    return withLock(`agent-approval-${id}`, async () => {
      const req = this.get(id);
      if (!req) throw new Error("Approval not found");
      if (req.status !== "pending") throw new Error("Approval already decided");
      req.status = approved ? "approved" : "rejected";
      req.always = approved ? always : Boolean(req.always);
      req.decidedAt = nowIso();
      req.decidedBy = operator;
      writeJsonAtomic(approvalFile(req.id), req);
      return req;
    });
  }

  remove(id: string): void {
    const file = approvalFile(safeId(id));
    if (fs.existsSync(file)) fs.removeSync(file);
  }

  clearDecided(): void {
    fs.ensureDirSync(APPROVALS_DIR());
    for (const a of this.list()) {
      if (a.status !== "pending") this.remove(a.id);
    }
  }
}

export default new ApprovalStore();