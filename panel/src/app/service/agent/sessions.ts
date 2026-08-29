import fs from "fs-extra";
import path from "path";
import { agentDir, readJson, writeJsonAtomic, withLock } from "./store_util";
import type { ChatMessage, Session } from "./types";

/**
 * Persistent Agent sessions. Each session binds a workspace, provider and a
 * message history so users can resume long-running conversations. Messages are
 * trimmed to a maximum token-ish budget to keep disk/CPU usage low.
 */

const SESSIONS_DIR = () => path.join(agentDir(), "sessions");
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 20000;
const MAX_SESSIONS = 40;

function sessionFile(id: string) {
  return path.join(SESSIONS_DIR(), `${id}.json`);
}

function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) throw new Error("Invalid session id");
  return id;
}

export class SessionStore {
  list(): Session[] {
    fs.ensureDirSync(SESSIONS_DIR());
    const files = fs
      .readdirSync(SESSIONS_DIR())
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    const sessions: Session[] = [];
    for (const f of files.slice(0, MAX_SESSIONS)) {
      const s = readJson<Session>(path.join(SESSIONS_DIR(), f), null as any);
      if (s && s.id) sessions.push(s);
    }
    return sessions;
  }

  get(id: string): Session | null {
    return readJson<Session>(sessionFile(safeId(id)), null as any);
  }

  create(input: {
    label?: string;
    workspace: string;
    daemonId?: string;
    instanceUuid?: string;
    providerId: string;
    modelOverride?: string;
    mode: "normal" | "fix" | "msl";
  }): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: [Date.now().toString(36), Math.random().toString(36).slice(2, 8)].join(""),
      label: String(input.label || "Agent session").slice(0, 60),
      workspace: input.workspace,
      daemonId: input.daemonId,
      instanceUuid: input.instanceUuid,
      providerId: input.providerId,
      modelOverride: input.modelOverride,
      createdAt: now,
      updatedAt: now,
      messages: [],
      approved: false,
      mode: input.mode
    };
    writeJsonAtomic(sessionFile(session.id), session);
    return session;
  }

  update(id: string, patch: Partial<Session>): Session {
    const session = this.get(id);
    if (!session) throw new Error("Session not found");
    const updated = { ...session, ...patch, updatedAt: new Date().toISOString() };
    writeJsonAtomic(sessionFile(session.id), updated);
    return updated;
  }

  async appendMessage(id: string, message: ChatMessage): Promise<Session> {
    return withLock(`agent-session-${id}`, async () => {
      const session = this.get(id);
      if (!session) throw new Error("Session not found");
      session.messages.push(message);
      // Trim to a bounded history
      while (session.messages.length > MAX_MESSAGES) session.messages.shift();
      for (const m of session.messages) {
        if (typeof m.content === "string" && m.content.length > MAX_MESSAGE_CHARS) {
          m.content = m.content.slice(0, MAX_MESSAGE_CHARS) + "\n...[truncated]";
        }
      }
      writeJsonAtomic(sessionFile(session.id), session);
      return session;
    });
  }

  clearMessages(id: string): Session {
    const session = this.get(id);
    if (!session) throw new Error("Session not found");
    session.messages = [];
    return this.update(id, { messages: [] });
  }

  remove(id: string): void {
    const file = sessionFile(safeId(id));
    if (fs.existsSync(file)) fs.removeSync(file);
  }
}

export default new SessionStore();