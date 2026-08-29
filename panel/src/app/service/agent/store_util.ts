import crypto from "crypto";
import fs from "fs-extra";
import path from "path";

/**
 * Shared utilities for the Agent subsystem: persistent JSON storage with
 * atomic writes, in-process mutual exclusion, encryption helpers for API
 * keys and a small unified-diff generator.
 */

export const AGENT_DATA_DIR = path.join(process.cwd(), "data", "agent");

export function agentDir(...segments: string[]): string {
  const dir = path.join(AGENT_DATA_DIR, ...segments);
  fs.ensureDirSync(dir);
  return dir;
}

/** Simple per-key async mutex to serialize read-modify-write cycles. */
const locks = new Map<string, Promise<unknown>>();
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  locks.set(
    key,
    run.catch(() => undefined)
  );
  try {
    return await run;
  } finally {
    if (locks.get(key) === undefined) locks.delete(key);
  }
}

/** Atomic JSON write: temp file + rename, durable across restarts. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.ensureDirSync(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (err) {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Secret file + AES-256-GCM encryption for provider API keys
// ---------------------------------------------------------------------------

function secretFile(): string {
  const file = path.join(agentDir(), "secret.key");
  if (!fs.existsSync(file)) {
    const key = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, key, { encoding: "utf-8", mode: 0o600 });
  }
  return file;
}

function encryptionKey(): Buffer {
  return Buffer.from(fs.readFileSync(secretFile(), "utf-8").trim(), "hex");
}

const ENC_PREFIX = "enc:v1:";

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  if (plain.startsWith(ENC_PREFIX)) return plain; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(value: string): string {
  if (!value) return "";
  if (!value.startsWith(ENC_PREFIX)) return value; // plain (legacy/imported)
  try {
    const raw = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
  } catch (err) {
    throw new Error("Failed to decrypt stored secret (key mismatch?)");
  }
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.startsWith(ENC_PREFIX)) return "•••• stored";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/**
 * Replace the local encryption key. The caller is responsible for re-encrypting
 * stored secrets: decrypt all values with the current key first, then call this
 * and encrypt/save them again with the fresh key.
 */
export function replaceEncryptionKey(): void {
  const file = secretFile();
  fs.copyFileSync(file, `${file}.${Date.now()}.bak`);
  fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { encoding: "utf-8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Unified diff (line based, simple LCS)
// ---------------------------------------------------------------------------

export interface DiffRow {
  type: "context" | "add" | "del";
  text: string;
}

export function unifiedDiff(before: string, after: string, context = 3): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  // LCS table (guard against pathological sizes)
  if (n * m > 4_000_000) {
    return `--- a/file\n+++ b/file\n@@ (large diff omitted: ${n} -> ${m} lines)`;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i] });
      i++;
    } else {
      rows.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", text: a[i++] });
  while (j < m) rows.push({ type: "add", text: b[j++] });

  // Compress unchanged runs to +/- context lines
  const out: string[] = [];
  let k = 0;
  while (k < rows.length) {
    if (rows[k].type !== "context") {
      out.push(...rows.slice(k, k + 1).map((r) => (r.type === "add" ? `+${r.text}` : `-${r.text}`)));
      k++;
      continue;
    }
    let end = k;
    while (end < rows.length && rows[end].type === "context") end++;
    const run = rows.slice(k, end);
    if (end === rows.length) {
      out.push(...run.slice(0, context).map((r) => ` ${r.text}`));
    } else if (k === 0) {
      out.push(...run.slice(-context).map((r) => ` ${r.text}`));
    } else {
      out.push(...run.slice(0, context).map((r) => ` ${r.text}`));
      if (end - k > context * 2) out.push("@@ ... @@");
      out.push(...run.slice(-context).map((r) => ` ${r.text}`));
    }
    k = end;
  }
  if (!out.length) out.push(" (no changes)");
  return out.join("\n");
}
