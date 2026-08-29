import fs from "fs-extra";
import path from "path";
import crypto from "crypto";
import { agentDir, readJson, writeJsonAtomic, unifiedDiff } from "./store_util";
import type { FileSnapshot } from "./types";

/**
 * File modification records for the Agent.
 *
 * Every write/delete the Agent performs captures a before/after snapshot plus a
 * unified diff. Snapshots live under `data/agent/snapshots/` (index + content)
 * and can be rolled back individually or in bulk. Old snapshots are pruned to
 * keep disk usage low (MAX_SNAPSHOTS, MAX_TOTAL_BYTES).
 */

const SNAPSHOTS_DIR = () => path.join(agentDir(), "snapshots");
const MAX_SNAPSHOTS = 200;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB of stored contents
const MAX_SINGLE_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_CHARS = 20000;

function indexFile(id: string) {
  return path.join(SNAPSHOTS_DIR(), `${id}.json`);
}

function contentFile(id: string) {
  return path.join(SNAPSHOTS_DIR(), `${id}.content`);
}

function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) throw new Error("Invalid snapshot id");
  return id;
}

export class SnapshotStore {
  private index(): string[] {
    fs.ensureDirSync(SNAPSHOTS_DIR());
    return fs.readdirSync(SNAPSHOTS_DIR()).filter((f) => f.endsWith(".json"));
  }

  list(sessionId?: string, limit = 100): FileSnapshot[] {
    const files = this.index().sort().reverse().slice(0, limit);
    const out: FileSnapshot[] = [];
    for (const f of files) {
      const s = readJson<FileSnapshot>(path.join(SNAPSHOTS_DIR(), f), null as any);
      if (s?.id && (!sessionId || s.sessionId === sessionId)) out.push(s);
    }
    return out;
  }

  get(id: string): FileSnapshot | null {
    return readJson<FileSnapshot>(indexFile(safeId(id)), null as any);
  }

  /**
   * Record a modification. `before` is the previous file content (null if the
   * file did not exist), `after` the new content (null if deleted).
   */
  record(input: {
    sessionId: string;
    workspace: string;
    path: string;
    before: string | null;
    after: string | null;
  }): FileSnapshot {
    fs.ensureDirSync(SNAPSHOTS_DIR());
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const rel = path.relative(input.workspace, input.path) || path.basename(input.path);
    const beforeSize = input.before == null ? 0 : Buffer.byteLength(input.before);
    const afterSize = input.after == null ? 0 : Buffer.byteLength(input.after);
    let diff = "";
    try {
      if (input.before == null && input.after != null) {
        diff = `--- (new file)\n+++ ${rel}\n${input.after
          .split(/\r?\n/)
          .slice(0, 300)
          .map((l) => `+${l}`)
          .join("\n")}`;
      } else if (input.before != null && input.after == null) {
        diff = `--- ${rel}\n+++ (deleted)\n${input.before
          .split(/\r?\n/)
          .slice(0, 300)
          .map((l) => `-${l}`)
          .join("\n")}`;
      } else {
        diff = unifiedDiff(input.before || "", input.after || "");
      }
      if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n...[truncated]";
    } catch {
      diff = "(diff unavailable)";
    }

    const snapshot: FileSnapshot = {
      id,
      sessionId: input.sessionId,
      workspace: input.workspace,
      path: input.path,
      relativePath: rel,
      beforeContent: input.before,
      afterContent: input.after,
      beforeSize,
      afterSize,
      diff,
      createdAt: new Date().toISOString(),
      rolledBack: false
    };
    // Store big contents out-of-band to keep the index JSON small.
    const index = { ...snapshot };
    if (input.before != null && beforeSize > 64 * 1024) {
      fs.writeFileSync(contentFile(`${id}.before`), input.before, "utf-8");
      index.beforeContent = null;
    }
    if (input.after != null && afterSize > 64 * 1024) {
      fs.writeFileSync(contentFile(`${id}.after`), input.after, "utf-8");
      index.afterContent = null;
    }
    writeJsonAtomic(indexFile(id), index);
    this.prune();
    return snapshot;
  }

  /** Apply a rollback. Returns the restored content (or null for deletion). */
  rollback(id: string): { restored: string | null } {
    const index = readJson<FileSnapshot>(indexFile(safeId(id)), null as any);
    if (!index) throw new Error("Snapshot not found");
    if (index.rolledBack) throw new Error("Snapshot already rolled back");
    let before = index.beforeContent;
    if (before == null && fs.existsSync(contentFile(`${id}.before`))) {
      before = fs.readFileSync(contentFile(`${id}.before`), "utf-8");
    }
    if (before == null) {
      fs.removeSync(index.path);
    } else {
      fs.ensureDirSync(path.dirname(index.path));
      fs.writeFileSync(index.path, before, "utf-8");
    }
    index.rolledBack = true;
    index.beforeContent = before;
    writeJsonAtomic(indexFile(id), index);
    return { restored: before };
  }

  private prune() {
    try {
      const files = this.index().sort();
      // Keep at most MAX_SNAPSHOTS index files
      while (files.length > MAX_SNAPSHOTS) {
        const f = files.shift();
        if (!f) break;
        const base = f.replace(/\.json$/, "");
        fs.removeSync(path.join(SNAPSHOTS_DIR(), f));
        fs.removeSync(path.join(SNAPSHOTS_DIR(), `${base}.before`));
        fs.removeSync(path.join(SNAPSHOTS_DIR(), `${base}.after`));
      }
      // Enforce a total size budget on content files
      let total = 0;
      const contentFiles = fs
        .readdirSync(SNAPSHOTS_DIR())
        .filter((f) => f.endsWith(".content") || f.endsWith(".before") || f.endsWith(".after"))
        .sort();
      for (const f of contentFiles) {
        const stat = fs.statSync(path.join(SNAPSHOTS_DIR(), f));
        total += stat.size;
        if (total > MAX_TOTAL_BYTES || stat.size > MAX_SINGLE_BYTES) {
          fs.removeSync(path.join(SNAPSHOTS_DIR(), f));
        }
      }
    } catch {
      // Best-effort pruning; never crash the agent
    }
  }
}

export default new SnapshotStore();