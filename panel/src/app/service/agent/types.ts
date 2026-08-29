/**
 * Shared types for the Agent subsystem.
 */

export interface ProviderConfig {
  id: string;
  label: string;
  /** OpenAI-compatible endpoint, e.g. https://api.openai.com/v1 */
  endpoint: string;
  apiKey?: string;
  /** Default/primary model name */
  model: string;
  /** List of selectable models for this provider (defaults to [model]) */
  models?: string[];
  /** Custom HTTP headers (except Authorization) */
  headers?: Record<string, string>;
  /** Enable reasoning / chain-of-thought */
  reasoning?: boolean;
  reasoningMode?: string;
  /** Context window length */
  ctx?: number;
  /** Max tokens per response */
  maxToken?: number;
  /** Optional web search endpoint (Tavily/Serper/Brave/Bing/etc.) */
  searchEndpoint?: string;
  searchApiKey?: string;
  /** SSRF allowlist (IPs / domains / CIDR) */
  allowedHosts?: string[];
}

export interface Session {
  id: string;
  label: string;
  workspace: string;
  daemonId?: string;
  instanceUuid?: string;
  providerId: string;
  modelOverride?: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  approved: boolean;
  mode: "normal" | "fix" | "msl";
  /** Token usage of the most recent assistant turn (displayed in the ctx drawer). */
  lastUsage?: AgentUsage;
  /** Session-scoped "always allow" rules approved by the user (opencode-style). */
  approvedRules?: PermissionRule[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Reasoning / chain-of-thought text (assistant messages only) */
  reasoning?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  timestamp: string;
}

/** Token usage reported by the provider for one assistant turn. */
export interface AgentUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** One permission rule (opencode-style ruleset). Wildcards supported. */
export interface PermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  /** Permission key the tool maps to (edit / bash / instance / msl). */
  permission?: string;
  /** Resource pattern this approval covers (e.g. "edit:server.properties"). */
  pattern?: string;
  /** True when the admin chose "always allow" for this pattern. */
  always?: boolean;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  expiresAt: string;
}

export interface FileSnapshot {
  id: string;
  sessionId: string;
  workspace: string;
  path: string;
  relativePath: string;
  /** null = file did not exist before */
  beforeContent: string | null;
  afterContent: string | null;
  beforeSize: number;
  afterSize: number;
  diff: string;
  createdAt: string;
  rolledBack: boolean;
}

export interface AgentRunConfig {
  workspace: string;
  daemonId?: string;
  instanceUuid?: string;
  providerId: string;
  model?: string;
  prompt: string;
  sessionId?: string;
  approved: boolean;
  mode: "normal" | "fix" | "msl";
}

export interface AgentEvent {
  event:
    | "session"
    | "step"
    | "reasoning"
    | "reasoning_done"
    | "message"
    | "message_done"
    | "tool_start"
    | "tool_args"
    | "tool_pending"
    | "tool"
    | "approval"
    | "usage"
    | "error"
    | "done"
    | "diff";
  data: unknown;
}

export type EmitFn = (event: string, data: unknown) => void;