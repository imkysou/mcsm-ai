import fs from "fs-extra";
import path from "path";
import net from "net";
import { agentDir, readJson, writeJsonAtomic, encryptSecret, decryptSecret, maskSecret } from "./store_util";
import type { ProviderConfig } from "./types";

/**
 * Persisted Agent model/provider configuration.
 *
 * Providers are stored in `data/agent/providers.json`. API keys are encrypted
 * at rest with AES-256-GCM (see store_util). The store also keeps a default
 * provider id and last-used search/workspace preferences.
 */

interface ProviderStoreFile {
  providers: ProviderConfig[];
  defaultProviderId: string;
}

const STORE_FILE = () => path.join(agentDir(), "providers.json");

function readStore(): ProviderStoreFile {
  return readJson<ProviderStoreFile>(STORE_FILE(), { providers: [], defaultProviderId: "" });
}

function writeStore(store: ProviderStoreFile) {
  writeJsonAtomic(STORE_FILE(), store);
}

/** Sanitise a provider before returning to the frontend (keys masked). */
export function sanitizeProvider(p: ProviderConfig): ProviderConfig {
  return {
    ...p,
    apiKey: p.apiKey ? maskSecret(p.apiKey) : "",
    searchApiKey: p.searchApiKey ? maskSecret(p.searchApiKey) : "",
    headers: p.headers ? { ...p.headers } : undefined
  };
}

/** True if the value looks like an already-masked secret placeholder. */
function isMasked(value: string) {
  return /^•{2,}/.test(value) || /stored$/.test(value);
}

/**
 * Normalise a model list from a string (comma/newline separated), an array of
 * strings, or a mixed input. Falls back to the provider's default model.
 */
function normalizeModels(input: unknown, fallback: string): string[] {
  const list: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") {
      for (const s of v.split(/[\n,]+/)) {
        const m = s.trim();
        if (m && !list.includes(m)) list.push(m);
      }
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (Array.isArray(item)) continue;
        if (typeof item === "string") push(item);
        else if (item && typeof item === "object") {
          // allow { id/name: "model" } entries from some clients
          const obj = item as Record<string, unknown>;
          push(obj.name ?? obj.id ?? obj.model ?? "");
        }
      }
    }
  };
  push(input);
  if (!list.length && fallback) list.push(fallback);
  return list.slice(0, 60);
}

/** All selectable models of a provider (models list, else the default model). */
export function modelList(p: ProviderConfig): string[] {
  const models = (p.models || []).filter(Boolean);
  return models.length ? models : p.model ? [p.model] : [];
}

/**
 * Validate that an endpoint is not an SSRF hazard: must be http(s), and if a
 * hostname/IP allowlist is configured the resolved host must be allowed.
 */
export function validateEndpoint(endpoint: string, allowedHosts?: string[]): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Invalid endpoint URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Endpoint must be http(s)");
  }
  if (!allowedHosts || allowedHosts.length === 0) return;

  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((h) => {
    const rule = String(h).trim().toLowerCase();
    if (!rule) return false;
    if (rule === host) return true;
    // CIDR support for IP ranges
    if (rule.includes("/") && net.isIP(host)) {
      try {
        return isIpInCidr(host, rule);
      } catch {
        return false;
      }
    }
    // subdomain wildcard: *.example.com
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return false;
  });
  if (!allowed) throw new Error(`Endpoint host "${host}" is not in the allowed hosts allowlist`);
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (!net.isIP(range) || !Number.isInteger(bits)) throw new Error("Bad CIDR");
  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(range);
  const mask = bits === 0 ? 0 : ~0 << (32 - bits);
  return (ipNum & mask) === (rangeNum & mask);
}

function ipToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export class AgentConfigStore {
  list(): ProviderConfig[] {
    return readStore().providers.map(sanitizeProvider);
  }

  getRaw(id: string): ProviderConfig | undefined {
    return readStore().providers.find((p) => p.id === id);
  }

  /** Full provider with decrypted keys - NEVER expose to the frontend. */
  getSecret(id: string): ProviderConfig | undefined {
    const p = this.getRaw(id);
    if (!p) return undefined;
    return {
      ...p,
      apiKey: p.apiKey ? decryptSecret(p.apiKey) : "",
      searchApiKey: p.searchApiKey ? decryptSecret(p.searchApiKey) : ""
    };
  }

  defaultProviderId(): string {
    return readStore().defaultProviderId;
  }

  getDefault(): ProviderConfig | undefined {
    const store = readStore();
    if (store.defaultProviderId) return store.providers.find((p) => p.id === store.defaultProviderId);
    return store.providers[0];
  }

  setDefault(id: string): void {
    const store = readStore();
    if (!store.providers.some((p) => p.id === id)) throw new Error("Provider not found");
    store.defaultProviderId = id;
    writeStore(store);
  }

  add(input: Partial<ProviderConfig> & { endpoint: string; model?: string }): ProviderConfig {
    const endpoint = String(input.endpoint || "").trim();
    const models = normalizeModels(input.models, typeof input.model === "string" ? input.model.trim() : "");
    const model = String(input.model || "").trim() || models[0] || "";
    if (!endpoint || !models.length) throw new Error("Endpoint and model are required");
    validateEndpoint(endpoint, input.allowedHosts);
    const store = readStore();
    const provider: ProviderConfig = {
      id: [Date.now(), Math.random().toString(36).slice(2, 8)].join(""),
      label: String(input.label || model || "Provider").slice(0, 40),
      endpoint,
      model,
      models,
      apiKey: input.apiKey ? encryptSecret(String(input.apiKey)) : "",
      headers: normalizeHeaders(input.headers),
      reasoning: Boolean(input.reasoning),
      reasoningMode: String(input.reasoningMode || "medium"),
      ctx: Number(input.ctx) || undefined,
      maxToken: Number(input.maxToken) || undefined,
      searchEndpoint: String(input.searchEndpoint || "").trim() || undefined,
      searchApiKey: input.searchApiKey ? encryptSecret(String(input.searchApiKey)) : "",
      allowedHosts: input.allowedHosts?.map(String) || []
    };
    store.providers.push(provider);
    if (!store.defaultProviderId) store.defaultProviderId = provider.id;
    writeStore(store);
    return sanitizeProvider(provider);
  }

  update(id: string, input: Partial<ProviderConfig>): ProviderConfig {
    const store = readStore();
    const idx = store.providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error("Provider not found");
    const current = store.providers[idx];
    const endpoint = String(input.endpoint ?? current.endpoint);
    const models = input.models !== undefined
      ? normalizeModels(input.models, typeof input.model === "string" ? input.model.trim() : current.model)
      : current.models && current.models.length
        ? current.models
        : [current.model];
    const model = String(input.model ?? current.model).trim() || models[0] || current.model;
    validateEndpoint(endpoint, input.allowedHosts || current.allowedHosts);
    const headers = input.headers !== undefined ? normalizeHeaders(input.headers) : current.headers;
    const apiKey =
      input.apiKey !== undefined
        ? isMasked(String(input.apiKey))
          ? current.apiKey
          : encryptSecret(String(input.apiKey))
        : current.apiKey;
    const searchApiKey =
      input.searchApiKey !== undefined
        ? isMasked(String(input.searchApiKey))
          ? current.searchApiKey
          : encryptSecret(String(input.searchApiKey))
        : current.searchApiKey;
    const updated: ProviderConfig = {
      ...current,
      label: String(input.label ?? current.label).slice(0, 40),
      endpoint,
      model,
      models,
      apiKey,
      headers,
      reasoning: input.reasoning !== undefined ? Boolean(input.reasoning) : current.reasoning,
      reasoningMode: String(input.reasoningMode ?? current.reasoningMode ?? "medium"),
      ctx: input.ctx !== undefined ? Number(input.ctx) || undefined : current.ctx,
      maxToken: input.maxToken !== undefined ? Number(input.maxToken) || undefined : current.maxToken,
      searchEndpoint: String(input.searchEndpoint ?? current.searchEndpoint ?? "").trim() || undefined,
      searchApiKey,
      allowedHosts: input.allowedHosts ? input.allowedHosts.map(String) : current.allowedHosts
    };
    store.providers[idx] = updated;
    writeStore(store);
    return sanitizeProvider(updated);
  }

  remove(id: string): void {
    const store = readStore();
    store.providers = store.providers.filter((p) => p.id !== id);
    if (store.defaultProviderId === id) store.defaultProviderId = store.providers[0]?.id || "";
    writeStore(store);
  }

  importAll(providers: Array<Omit<ProviderConfig, "id">>): number {
    let count = 0;
    for (const p of providers) {
      if (!p.endpoint || (!p.model && !(p.models && p.models.length))) continue;
      this.add(p as any);
      count++;
    }
    return count;
  }
}

function normalizeHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).trim();
    // Never allow overriding Authorization through custom headers
    if (!key || key.toLowerCase() === "authorization") continue;
    const val = String(v).slice(0, 2000);
    if (val) out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

export default new AgentConfigStore();