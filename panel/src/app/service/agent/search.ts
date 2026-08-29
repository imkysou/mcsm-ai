import axios from "axios";
import path from "path";
import fs from "fs-extra";
import { agentDir, readJson, writeJsonAtomic } from "./store_util";
import { validateEndpoint } from "./config_store";

/**
 * Web search adapters for the Agent.
 *
 * Supported providers (mainstream, no heavy deps):
 *  - tavily    : POST https://api.tavily.com/search  {api_key, query}
 *  - serper    : POST https://google.serper.dev/search {q} (X-API-KEY)
 *  - brave     : GET  https://api.search.brave.com/res/v1/web/search (X-Subscription-Token)
 *  - bing      : GET  https://api.bing.microsoft.com/v7.0/search (Ocp-Apim-Subscription-Key)
 *  - searxng   : GET  <self-hosted>/search?q=...&format=json
 *  - ddg       : POST https://duckduckgo.com/html/ (best-effort, no key)
 *
 * Results are normalised to {title, url, snippet}[]. Responses are cached on
 * disk (24h TTL) to reduce cost and latency.
 */

export type SearchProvider =
  | "tavily"
  | "serper"
  | "brave"
  | "bing"
  | "searxng"
  | "duckduckgo"
  | "custom";

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  provider?: SearchProvider;
  endpoint?: string;
  apiKey?: string;
  maxResults?: number;
  cacheTtlMs?: number;
}

const CACHE_FILE = () => path.join(agentDir(), "search_cache.json");
const DEFAULT_MAX = 5;
const DEFAULT_TTL = 24 * 60 * 60 * 1000;

function cacheKey(provider: string, endpoint: string, query: string) {
  return `${provider}|${endpoint}|${query.toLowerCase().trim()}`;
}

function readCache(): Record<string, { at: number; items: SearchResultItem[] }> {
  return readJson(CACHE_FILE(), {});
}

function writeCache(cache: Record<string, { at: number; items: SearchResultItem[] }>) {
  // Keep the cache small: drop expired + oldest entries over 200.
  const now = Date.now();
  const keys = Object.keys(cache);
  for (const k of keys) {
    if (now - cache[k].at > DEFAULT_TTL) delete cache[k];
  }
  let entries = Object.entries(cache);
  if (entries.length > 200) {
    entries = entries.sort((a, b) => a[1].at - b[1].at).slice(-200);
    const next: typeof cache = {};
    for (const [k, v] of entries) next[k] = v;
    cache = next;
  }
  writeJsonAtomic(CACHE_FILE(), cache);
}

function normalise(items: Array<Record<string, any>>, mapping: {
  title: string; url: string; snippet: string;
}): SearchResultItem[] {
  return items
    .filter((i) => i && (i[mapping.url] || i.link))
    .slice(0, DEFAULT_MAX)
    .map((i) => ({
      title: String(i[mapping.title] || i.title || "Untitled").slice(0, 300),
      url: String(i[mapping.url] || i.link || "").slice(0, 2000),
      snippet: String(i[mapping.snippet] || i.snippet || i.content || "").slice(0, 1000)
    }));
}

async function fetchFromProvider(
  provider: SearchProvider,
  endpoint: string,
  apiKey: string,
  query: string
): Promise<SearchResultItem[]> {
  const timeout = 25000;
  const headers: Record<string, string> = { "User-Agent": "MCSM-Agent/1.0" };
  let items: Array<Record<string, any>> = [];

  switch (provider) {
    case "tavily": {
      const url = endpoint || "https://api.tavily.com/search";
      validateEndpoint(url);
      const res = await axios.post(
        url,
        { api_key: apiKey, query, max_results: DEFAULT_MAX, search_depth: "basic" },
        { headers, timeout }
      );
      items = res.data?.results || [];
      return normalise(items, { title: "title", url: "url", snippet: "content" });
    }
    case "serper": {
      const url = endpoint || "https://google.serper.dev/search";
      validateEndpoint(url);
      if (apiKey) headers["X-API-KEY"] = apiKey;
      const res = await axios.post(url, { q: query, num: DEFAULT_MAX }, { headers, timeout });
      items = res.data?.organic || [];
      return normalise(items, { title: "title", url: "link", snippet: "snippet" });
    }
    case "brave": {
      const url = endpoint || "https://api.search.brave.com/res/v1/web/search";
      validateEndpoint(url);
      if (apiKey) headers["X-Subscription-Token"] = apiKey;
      const res = await axios.get(url, { params: { q: query, count: DEFAULT_MAX }, headers, timeout });
      items = res.data?.web?.results || [];
      return normalise(items, { title: "title", url: "url", snippet: "description" });
    }
    case "bing": {
      const url = endpoint || "https://api.bing.microsoft.com/v7.0/search";
      validateEndpoint(url);
      if (apiKey) headers["Ocp-Apim-Subscription-Key"] = apiKey;
      const res = await axios.get(url, { params: { q: query, count: DEFAULT_MAX }, headers, timeout });
      items = res.data?.webPages?.value || [];
      return normalise(items, { title: "name", url: "url", snippet: "snippet" });
    }
    case "searxng": {
      const url = endpoint || "http://127.0.0.1:8888/search";
      validateEndpoint(url);
      const res = await axios.get(url, { params: { q: query, format: "json" }, headers, timeout });
      items = res.data?.results || [];
      return normalise(items, { title: "title", url: "url", snippet: "content" });
    }
    case "duckduckgo": {
      const url = endpoint || "https://duckduckgo.com/html/";
      validateEndpoint(url);
      const res = await axios.post(
        url,
        new URLSearchParams({ q: query }),
        { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, timeout }
      );
      const html = String(res.data || "");
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const out: SearchResultItem[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && out.length < DEFAULT_MAX) {
        const urlRaw = m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "");
        let target = urlRaw;
        try {
          target = decodeURIComponent(urlRaw);
        } catch {
          /* keep raw */
        }
        out.push({
          title: m[2].replace(/<[^>]+>/g, "").trim().slice(0, 300),
          url: target.slice(0, 2000),
          snippet: m[3].replace(/<[^>]+>/g, "").trim().slice(0, 1000)
        });
      }
      return out;
    }
    case "custom": {
      if (!endpoint) throw new Error("Custom search requires an endpoint");
      validateEndpoint(endpoint);
      const res = await axios.post(
        endpoint,
        { query, q: query },
        { headers: { ...headers, "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, timeout }
      );
      const data = res.data;
      const raw = Array.isArray(data?.results) ? data.results : Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      return normalise(raw, { title: "title", url: "url", snippet: "snippet" });
    }
    default:
      throw new Error(`Unsupported search provider: ${provider}`);
  }
}

export async function webSearch(query: string, opts: SearchOptions = {}): Promise<SearchResultItem[]> {
  const q = String(query || "").trim();
  if (!q || q.length > 500) throw new Error("Invalid search query");
  const provider = opts.provider || "tavily";
  const endpoint = opts.endpoint || "";
  const apiKey = opts.apiKey || "";

  const cache = readCache();
  const key = cacheKey(provider, endpoint, q);
  const hit = cache[key];
  if (hit && Date.now() - hit.at < (opts.cacheTtlMs ?? DEFAULT_TTL)) {
    return hit.items;
  }

  const items = await fetchFromProvider(provider, endpoint, apiKey, q);
  cache[key] = { at: Date.now(), items };
  writeCache(cache);
  return items;
}

/** Fetch a single page and extract readable text (for deeper research). */
export async function fetchPageText(url: string, maxBytes = 512 * 1024): Promise<string> {
  validateEndpoint(url);
  const res = await axios.get(url, {
    timeout: 20000,
    maxContentLength: maxBytes,
    responseType: "text",
    headers: { "User-Agent": "MCSM-Agent/1.0" },
    validateStatus: (s) => s >= 200 && s < 400
  });
  const html = String(res.data || "");
  // crude HTML → text extraction without dependencies
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 8000);
}

/** Tiny helper to remember last used provider for the UI. */
export function rememberSearchProvider(provider: string) {
  const file = path.join(agentDir(), "search_pref.json");
  writeJsonAtomic(file, { provider, at: Date.now() });
}

export function lastSearchProvider(): string {
  const pref = readJson<{ provider?: string }>(path.join(agentDir(), "search_pref.json"), {});
  return pref.provider || "tavily";
}