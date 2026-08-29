import { useDefineApi } from "@/stores/useDefineApi";

export interface AgentProvider {
  id: string;
  label: string;
  endpoint: string;
  apiKey?: string;
  /** Default / primary model */
  model: string;
  /** All selectable models (falls back to [model]) */
  models?: string[];
  headers?: Record<string, string>;
  reasoning?: boolean;
  reasoningMode?: string;
  ctx?: number;
  maxToken?: number;
  searchEndpoint?: string;
  searchApiKey?: string;
  allowedHosts?: string[];
}

export interface AgentSession {
  id: string;
  label: string;
  workspace: string;
  daemonId?: string;
  instanceUuid?: string;
  providerId: string;
  /** Model selected for this session */
  modelOverride?: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{
    role: string;
    content?: string;
    reasoning?: string;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
    name?: string;
    timestamp: string;
  }>;
  approved: boolean;
  mode: "normal" | "fix" | "msl";
  /** Token usage of the most recent assistant turn */
  lastUsage?: AgentUsage;
}

export interface AgentApproval {
  id: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  /** Permission key the tool maps to (edit / bash / instance / msl). */
  permission?: string;
  /** Resource pattern this approval covers. */
  pattern?: string;
  /** True when the admin chose "always allow" for this pattern. */
  always?: boolean;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  expiresAt: string;
}

export interface AgentSnapshot {
  id: string;
  sessionId: string;
  workspace: string;
  path: string;
  relativePath: string;
  beforeContent: string | null;
  afterContent: string | null;
  beforeSize: number;
  afterSize: number;
  diff: string;
  createdAt: string;
  rolledBack: boolean;
}

/** Body of a provider create/update. */
export type AgentProviderPayload = Omit<AgentProvider, "id">;

export const agentProviders = useDefineApi<unknown, { providers: AgentProvider[]; defaultProviderId: string }>({
  url: "/api/agent/config/providers",
  method: "GET"
});

export const agentProviderCreate = useDefineApi<{ data: AgentProviderPayload }, { provider: AgentProvider }>({
  url: "/api/agent/config/providers",
  method: "POST"
});

export const agentProviderUpdate = useDefineApi<
  { params: { id: string }; data?: AgentProviderPayload },
  { provider: AgentProvider }
>({
  url: "/api/agent/config/providers",
  method: "PUT"
});

export const agentProviderDelete = useDefineApi<{ params: { id: string } }, { success: boolean }>({
  url: "/api/agent/config/providers",
  method: "DELETE"
});

export const agentProviderSetDefault = useDefineApi<{ params: { id: string } }, { success: boolean }>({
  url: "/api/agent/config/providers/default",
  method: "POST"
});

export const agentSessions = useDefineApi<unknown, { sessions: AgentSession[] }>({
  url: "/api/agent/sessions",
  method: "GET"
});

export const agentSessionDetail = useDefineApi<{ params: { id: string } }, { session: AgentSession }>({
  url: "/api/agent/sessions/detail",
  method: "GET"
});

export const agentSessionDelete = useDefineApi<{ params: { id: string } }, { success: boolean }>({
  url: "/api/agent/sessions",
  method: "DELETE"
});

export const agentSessionClear = useDefineApi<{ params: { id: string } }, { session: AgentSession }>({
  url: "/api/agent/sessions/clear",
  method: "POST"
});

export const agentSessionAbort = useDefineApi<{ params: { id: string } }, { success: boolean }>({
  url: "/api/agent/sessions/abort",
  method: "POST"
});

export const agentApprovals = useDefineApi<unknown, { approvals: AgentApproval[] }>({
  url: "/api/agent/approvals",
  method: "GET"
});

export const agentApprovalApprove = useDefineApi<{ params: { id: string } }, { approval: AgentApproval }>({
  url: "/api/agent/approvals/approve",
  method: "POST"
});

export const agentApprovalReject = useDefineApi<{ params: { id: string } }, { approval: AgentApproval }>({
  url: "/api/agent/approvals/reject",
  method: "POST"
});

export const agentApprovalAlways = useDefineApi<{ params: { id: string } }, { approval: AgentApproval }>({
  url: "/api/agent/approvals/always",
  method: "POST"
});

export const agentApprovalsClear = useDefineApi<unknown, { success: boolean }>({
  url: "/api/agent/approvals/clear",
  method: "POST"
});

export const agentSnapshots = useDefineApi<{ params?: { sessionId?: string } }, { snapshots: AgentSnapshot[] }>({
  url: "/api/agent/snapshots",
  method: "GET"
});

export const agentSnapshotRollback = useDefineApi<{ params: { id: string } }, { restored: boolean }>({
  url: "/api/agent/snapshots/rollback",
  method: "POST"
});

export const agentCapabilities = useDefineApi<unknown, { tools: string[]; specialModes: string[]; maxSteps: number }>({
  url: "/api/agent/capabilities",
  method: "GET"
});
/** Token usage reported by the provider for one assistant turn. */
export interface AgentUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
}

/** A model entry rendered in the picker: provider + model combined. */
export interface AgentModelOption {
  value: string;
  providerId: string;
  providerLabel: string;
  model: string;
}
