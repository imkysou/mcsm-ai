<script setup lang="ts">
/**
 * MCSM-AI Agent page
 *
 * - Sidebar with session list (drawer on mobile)
 * - Modern message bubbles with provider/model chips
 * - Streaming output: reasoning (thinking), tool calls, markdown content
 * - Tool calls displayed as live status cards (running / pending / done / error)
 * - Unified input card: workspace + model selector + permission + send
 * - Right drawer: ctx usage, approvals, changes (all i18n'd)
 */
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { remoteInstancesGlobal } from "@/services/apis";
import {
  agentSessions,
  agentSessionDelete,
  agentSessionAbort,
  agentApprovals,
  agentApprovalApprove,
  agentApprovalReject,
  agentApprovalAlways,
  agentApprovalsClear,
  agentSnapshots,
  agentSnapshotRollback,
  agentProviders,
  agentProviderCreate,
  agentProviderUpdate,
  agentProviderDelete,
  agentProviderSetDefault,
  type AgentSession,
  type AgentProvider,
  type AgentApproval,
  type AgentSnapshot,
  type AgentUsage,
  type AgentProviderPayload
} from "@/services/apis/agent";
import { t } from "@/lang/i18n";
import { message, Modal } from "ant-design-vue";
import {
  PlusOutlined,
  DeleteOutlined,
  ClearOutlined,
  CloseOutlined,
  CheckOutlined,
  RollbackOutlined,
  FileOutlined,
  SettingOutlined,
  StopOutlined,
  NodeIndexOutlined,
  MenuOutlined,
  BulbOutlined,
  ToolOutlined,
  ThunderboltOutlined,
  LockOutlined,
  UnlockOutlined,
  DownOutlined,
  UpOutlined,
  LoadingOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleOutlined,
  ProfileOutlined,
  ThunderboltFilled,
  ClockCircleOutlined,
  ArrowUpOutlined
} from "@ant-design/icons-vue";
import AgentStarIcon from "@/components/AgentStarIcon.vue";
import { GLOBAL_INSTANCE_UUID } from "@/config/const";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { useScreen } from "@/hooks/useScreen";

const { isPhone } = useScreen();
const { state: appState } = useAppStateStore();

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------
const allInstances = ref<Array<{ uuid: string; daemonId: string; nickname: string; type: string }>>([]);
const instancesLoading = ref(false);

async function loadInstances() {
  instancesLoading.value = true;
  try {
    const { execute } = remoteInstancesGlobal();
    const res = await execute({ params: { page: 1, page_size: 100 } } as any);
    if (res.value) {
      const list: Array<{ uuid: string; daemonId: string; nickname: string; type: string }> = [];
      for (const [daemonId, daemon] of Object.entries(res.value)) {
        if (daemon.instances) {
          for (const inst of daemon.instances) {
            list.push({
              uuid: inst.instanceUuid,
              daemonId,
              nickname: inst.config?.nickname || inst.instanceUuid,
              type: inst.config?.type || "unknown"
            });
          }
        }
      }
      allInstances.value = list;
      // Default: pick first Minecraft instance
      if (!list.find((i) => i.uuid === selectedInstanceId.value)) {
        const mc = list.find((i) => i.type.startsWith("minecraft"));
        const pick = mc || list[0];
        if (pick) {
          selectedInstanceId.value = pick.uuid;
          selectedDaemonId.value = pick.daemonId;
        }
      }
    }
  } catch {
    // ignore
  } finally {
    instancesLoading.value = false;
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const sessions = ref<AgentSession[]>([]);
const activeSessionId = ref<string | null>(null);
const sessionsLoading = ref(false);


async function fetchSessions() {
  sessionsLoading.value = true;
  try {
    const { execute } = agentSessions();
    const res = await execute({ forceRequest: true } as any);
    if (res.value) sessions.value = res.value.sessions || [];
  } catch {
    // ignore
  } finally {
    sessionsLoading.value = false;
  }
}

function newSession() {
  activeSessionId.value = null;
  messages.value = [];
  usageInfo.value = null;
  currentStep.value = 0;
  if (streaming.value) abortRun();
  sidebarOpen.value = false;
}

async function deleteSession(sessionId: string) {
  try {
    const { execute } = agentSessionDelete();
    await execute({ params: { id: sessionId } });
    if (activeSessionId.value === sessionId) activeSessionId.value = null;
    await fetchSessions();
  } catch {
    message.error(t("TXT_CODE_agent_error"));
  }
}

async function selectSession(session: AgentSession) {
  activeSessionId.value = session.id;
  messages.value = hydrateMessages(session);
  providerId.value = session.providerId || "";
  modelName.value = session.modelOverride || "";
  syncModelSelection(session.providerId, session.modelOverride);
  if (session.workspace) {
    const inst = allInstances.value.find((i) => i.uuid === session.instanceUuid);
    if (inst && session.instanceUuid) {
      selectedInstanceId.value = inst.uuid;
      selectedDaemonId.value = inst.daemonId;
      workspaceType.value = "instance";
    } else if (session.workspace && !session.instanceUuid) {
      workspaceType.value = "folder";
      workspace.value = session.workspace;
    }
  }
  usageInfo.value = session.lastUsage || null;
  sidebarOpen.value = false;
  await updateApprovals();
  await updateSnapshots();
}

/** Convert stored session messages into the rich UI message model. */
interface UiTool {
  index: number;
  id: string;
  name: string;
  argsRaw: string;
  args?: any;
  result?: string;
  status: "running" | "pending" | "done" | "error";
  durationMs?: number;
  approvalId?: string;
}

/** One ordered piece of an assistant reply: thinking / tool call / text / error. */
interface UiSegment {
  kind: "thinking" | "tool" | "text" | "error";
  id: string;
  reasoning?: string;
  reasoningLive?: boolean;
  content?: string;
  tool?: UiTool;
  error?: string;
}
interface UiMessage {
  uid: string;
  role: "user" | "assistant";
  segments: UiSegment[];
  timestamp: string;
  modelLabel?: string;
}

let uidCounter = 0;
let segCounter = 0;
function nextUid() {
  return "m" + Date.now().toString(36) + "_" + (uidCounter++).toString(36);
}
function nextSegId() {
  return "s" + Date.now().toString(36) + "_" + (segCounter++).toString(36);
}

/** Remove the "[Workspace: ...]" context block appended by older engine versions. */
function stripWorkspaceContext(text: string): string {
  if (!text) return "";
  const idx = text.indexOf("\n[Workspace: ");
  if (idx < 0) return text;
  return text.slice(0, idx).trim();
}

/**
 * Rebuild the ordered segment list from stored session messages. Old sessions
 * only preserve assistant content/reasoning/tool_calls, so ordering falls back
 * to thinking -> tools -> text.
 */
function hydrateMessages(session: AgentSession): UiMessage[] {
  const out: UiMessage[] = [];
  const prov = providers.value.find((p) => p.id === session.providerId);
  const modelLabel = prov ? prov.label + " · " + (session.modelOverride || prov.model) : session.modelOverride || "";
  for (const m of session.messages) {
    if (m.role === "user") {
      out.push({ uid: nextUid(), role: "user", segments: [], timestamp: m.timestamp });
      const seg: UiSegment = { kind: "text", id: nextSegId(), content: stripWorkspaceContext(m.content || "") };
      out[out.length - 1].segments.push(seg);
    } else if (m.role === "assistant") {
      const segments: UiSegment[] = [];
      if (m.reasoning) segments.push({ kind: "thinking", id: nextSegId(), reasoning: m.reasoning, reasoningLive: false });
      const calls = m.tool_calls || [];
      for (let i = 0; i < calls.length; i++) {
        const tc = calls[i];
        segments.push({
          kind: "tool",
          id: nextSegId(),
          tool: {
            index: i,
            id: tc.id,
            name: tc.function?.name || "tool",
            argsRaw: tc.function?.arguments || "{}",
            status: "done"
          }
        });
      }
      if (m.content) segments.push({ kind: "text", id: nextSegId(), content: m.content });
      // The engine persists one assistant message per step, so a multi-step
      // reply is stored as assistant -> tool -> assistant -> ... . Merge
      // consecutive assistant entries of the same turn into ONE bubble so the
      // "Agent" name header appears exactly once per reply (mirrors live runs,
      // which stream all steps into a single assistant message).
      const last = out[out.length - 1];
      if (last && last.role === "assistant") {
        last.segments.push(...segments);
      } else {
        out.push({ uid: nextUid(), role: "assistant", segments, timestamp: m.timestamp, modelLabel });
      }
    } else if (m.role === "tool") {
      // Attach the tool result to the last assistant message's matching tool call.
      const last = [...out].reverse().find((x) => x.role === "assistant");
      const toolSeg = last ? [...last.segments].reverse().find((s) => s.kind === "tool" && s.tool?.id === m.tool_call_id) : undefined;
      if (toolSeg && toolSeg.tool) {
        toolSeg.tool.result = m.content || "";
        toolSeg.tool.status = /^ERROR/.test(m.content || "") ? "error" : "done";
      }
    }
  }
  return out;
}

// Session title: first chars of first user message
function sessionTitle(s: AgentSession): string {
  const first = s.messages.find((m) => m.role === "user");
  const content = first ? stripWorkspaceContext(first.content || "") : "";
  if (content) return content.replace(/@\w+\b/g, "").trim().slice(0, 16) || "New";
  return s.label.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Providers & models
// ---------------------------------------------------------------------------
const showProviderDialog = ref(false);
const providers = ref<AgentProvider[]>([]);
const providerForm = ref<any>({
  endpoint: "",
  model: "",
  apiKey: "",
  label: "",
  reasoning: false,
  reasoningMode: "medium",
  maxToken: undefined,
  ctx: undefined,
  searchEndpoint: "",
  searchApiKey: "",
  _allowedHostsText: "",
  _models: [] as string[]
});
const editingProviderId = ref<string | null>(null);

async function fetchProviders() {
  try {
    const { execute } = agentProviders();
    const res = await execute();
    if (res.value) {
      providers.value = res.value.providers || [];
      if (res.value.defaultProviderId) {
        syncModelSelection(res.value.defaultProviderId, undefined);
      } else {
        syncModelSelection();
      }
    }
  } catch {
    providers.value = [];
  }
}

interface ModelOpt {
  value: string;
  providerId: string;
  providerLabel: string;
  model: string;
  label: string;
}

const modelOptions = computed<ModelOpt[]>(() => {
  const opts: ModelOpt[] = [];
  for (const p of providers.value) {
    const models = p.models && p.models.length ? p.models : p.model ? [p.model] : [];
    for (const m of models) {
      opts.push({
        value: p.id + "::" + m,
        providerId: p.id,
        providerLabel: p.label || p.id,
        model: m,
        label: (p.label || p.id) + " · " + m
      });
    }
  }
  return opts;
});

const providerId = ref("");
const modelName = ref("");
const modelKey = computed({
  get: () => (providerId.value && modelName.value ? providerId.value + "::" + modelName.value : ""),
  set: (v: string) => {
    const opt = modelOptions.value.find((o) => o.value === v);
    if (opt) {
      providerId.value = opt.providerId;
      modelName.value = opt.model;
    }
  }
});

/** Make sure providerId/modelName point at a valid option. */
function syncModelSelection(preferredProvider?: string, preferredModel?: string) {
  const opts = modelOptions.value;
  if (!opts.length) {
    providerId.value = "";
    modelName.value = "";
    return;
  }
  const target =
    opts.find((o) => o.providerId === (preferredProvider || providerId.value) && o.model === (preferredModel || modelName.value)) ||
    opts.find((o) => o.providerId === (preferredProvider || providerId.value)) ||
    opts[0];
  providerId.value = target.providerId;
  modelName.value = target.model;
}

function openNewProvider() {
  editingProviderId.value = null;
  providerForm.value = {
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "",
    label: "",
    reasoning: false,
    reasoningMode: "medium",
    maxToken: 4096,
    ctx: 8192,
    searchEndpoint: "",
    searchApiKey: "",
    _allowedHostsText: "",
    _models: ["gpt-4o-mini"]
  };
  showProviderDialog.value = true;
}

function openEditProvider(p: AgentProvider) {
  editingProviderId.value = p.id;
  providerForm.value = {
    ...p,
    apiKey: "",
    searchApiKey: "",
    _allowedHostsText: (p.allowedHosts || []).join("\n"),
    _models: p.models && p.models.length ? [...p.models] : p.model ? [p.model] : []
  };
  showProviderDialog.value = true;
}

async function saveProvider() {
  const modelsArray = Array.isArray(providerForm.value._models) ? providerForm.value._models : [];
  const models: string[] = Array.from(
    new Set<string>(
      modelsArray
        .map((s: any) => String(s || "").trim())
        .filter(Boolean)
        .concat(providerForm.value.model ? [String(providerForm.value.model).trim()] : [])
    )
  );
  if (!providerForm.value.endpoint || !models.length) {
    message.warning(t("TXT_CODE_agent_provider_required"));
    return;
  }
  const payload: AgentProviderPayload = {
    label: providerForm.value.label,
    endpoint: providerForm.value.endpoint,
    model: models[0],
    models,
    apiKey: providerForm.value.apiKey || undefined,
    reasoning: providerForm.value.reasoning,
    reasoningMode: providerForm.value.reasoningMode,
    maxToken: providerForm.value.maxToken ? Number(providerForm.value.maxToken) : undefined,
    ctx: providerForm.value.ctx ? Number(providerForm.value.ctx) : undefined,
    searchEndpoint: providerForm.value.searchEndpoint || undefined,
    searchApiKey: providerForm.value.searchApiKey || undefined,
    allowedHosts: String(providerForm.value._allowedHostsText || "")
      .split("\n")
      .map((s: string) => s.trim())
      .filter(Boolean)
  };
  try {
    if (editingProviderId.value) {
      const { execute } = agentProviderUpdate();
      await execute({ params: { id: editingProviderId.value }, data: payload });
    } else {
      const { execute } = agentProviderCreate();
      const res = await execute({ data: payload });
      if (res.value?.provider && !providerId.value) {
        syncModelSelection(res.value.provider.id, res.value.provider.model);
      }
    }
    showProviderDialog.value = false;
    await fetchProviders();
  } catch (err: any) {
    message.error(t("TXT_CODE_agent_error") + ": " + (err?.message || err));
  }
}

async function deleteProvider(id: string) {
  try {
    const { execute } = agentProviderDelete();
    await execute({ params: { id } });
    if (providerId.value === id) providerId.value = "";
    await fetchProviders();
  } catch {
    message.error(t("TXT_CODE_agent_error"));
  }
}

async function setDefaultProvider(id: string) {
  try {
    const { execute } = agentProviderSetDefault();
    await execute({ params: { id } });
    providerId.value = id;
    await fetchProviders();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Inline controls
// ---------------------------------------------------------------------------
const workspace = ref("");
const workspaceType = ref<"instance" | "folder">("instance");
const selectedInstanceId = ref("");
const selectedDaemonId = ref("");
const autoApprove = ref(false);
const prompt = ref("");
const mode = ref<"normal" | "fix" | "msl">("normal");
/** File referenced by the user via "Ask Agent" entry points - shown as a tag. */
const referencedFile = ref<string>("");

// Sync daemonId when instance changes
watch(selectedInstanceId, (id) => {
  if (id) {
    const inst = allInstances.value.find((i) => i.uuid === id);
    if (inst) selectedDaemonId.value = inst.daemonId;
  }
});

const currentWorkspace = computed(() => {
  if (workspaceType.value === "instance" && selectedInstanceId.value) {
    const inst = allInstances.value.find((i) => i.uuid === selectedInstanceId.value);
    return inst ? "/instance/" + inst.uuid : "";
  }
  return workspace.value.trim();
});

function detectModeFromInput(): "normal" | "fix" | "msl" {
  const m = prompt.value.match(/@(fix|msl)\b/i);
  if (m) return m[1].toLowerCase() as "fix" | "msl";
  return "normal";
}
watch(prompt, () => {
  mode.value = detectModeFromInput();
});

// ---------------------------------------------------------------------------
// Chat / SSE
// ---------------------------------------------------------------------------
const messages = ref<UiMessage[]>([]);
const streaming = ref(false);
const currentStep = ref(0);
const abortController = ref<AbortController | null>(null);
const chatContainer = ref<HTMLElement | null>(null);
const inputTextarea = ref<HTMLTextAreaElement | null>(null);
const usageInfo = ref<AgentUsage | null>(null);
const collapsedThinking = ref<Set<string>>(new Set());
const expandedTools = ref<Set<string>>(new Set());

// SSE heartbeat watchdog: every decoded event/heartbeat pokes it. If the
// provider stream dies silently (or the panel connection is severed) no
// done/error arrives and the UI would stay disabled forever. We abort and
// surface a visible message instead of waiting indefinitely.
const SSE_IDLE_TIMEOUT = 90000;
let sseIdleTimer: ReturnType<typeof setTimeout> | null = null;
let sseLastActivity = 0;

function pokeSseActivity() {
  sseLastActivity = Date.now();
  if (sseIdleTimer) clearTimeout(sseIdleTimer);
  sseIdleTimer = setTimeout(() => {
    if (streaming.value && Date.now() - sseLastActivity >= SSE_IDLE_TIMEOUT - 500) {
      message.warning(t("TXT_CODE_agent_sse_timeout"));
      abortRun();
    }
  }, SSE_IDLE_TIMEOUT);
}

function clearSseWatchdog() {
  if (sseIdleTimer) clearTimeout(sseIdleTimer);
  sseIdleTimer = null;
}

function scrollToBottom() {
  nextTick(() => {
    if (chatContainer.value) chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
  });
}
watch(
  messages,
  () => {
    scrollToBottom();
  },
  { deep: true }
);

const canSend = computed(
  () =>
    prompt.value.trim().length > 0 &&
    !streaming.value &&
    Boolean(currentWorkspace.value) &&
    Boolean(providerId.value) &&
    Boolean(modelName.value)
);

function workspaceValid() {
  if (!currentWorkspace.value) {
    message.warning(t("TXT_CODE_agent_workspace_required"));
    return false;
  }
  if (!providerId.value || !modelName.value) {
    message.warning(t("TXT_CODE_agent_provider_required"));
    return false;
  }
  return true;
}

/** Last assistant UiMessage, creating one if needed (for streaming). */
function ensureAssistantMessage(): UiMessage {
  let last = messages.value[messages.value.length - 1];
  if (!last || last.role !== "assistant") {
    last = { uid: nextUid(), role: "assistant", segments: [], timestamp: new Date().toISOString() };
    messages.value.push(last);
  }
  return last;
}

/** Last segment, or a new one of the requested kind (events append in order). */
function ensureSegment(msg: UiMessage, kind: UiSegment["kind"], create: () => UiSegment): UiSegment {
  const last = msg.segments[msg.segments.length - 1];
  if (last && last.kind === kind) return last;
  const seg = create();
  msg.segments.push(seg);
  return seg;
}

/** Live tool segment by call id (indexes restart every step and collide). */
function toolSegment(msg: UiMessage, callId: string, index?: number): UiSegment | undefined {
  // Prefer an exact call-id match (ids are unique across the whole run).
  if (callId) {
    for (let i = msg.segments.length - 1; i >= 0; i--) {
      const s = msg.segments[i];
      if (s.kind === "tool" && s.tool && s.tool.id === callId) return s;
    }
  }
  // Fallback by index, but ONLY for the live segment of the call currently
  // streaming. tool_args may arrive without the real id (older engine) and
  // indexes restart at 0 every step, so a done/pending segment never matches.
  if (typeof index === "number") {
    for (let i = msg.segments.length - 1; i >= 0; i--) {
      const s = msg.segments[i];
      if (
        s.kind === "tool" &&
        s.tool &&
        s.tool.index === index &&
        (s.tool.status === "running" || s.tool.status === "pending")
      ) {
        return s;
      }
    }
  }
  return undefined;
}

function toggleThinking(id: string) {
  const set = new Set(collapsedThinking.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  collapsedThinking.value = set;
}

function toggleTool(id: string) {
  const set = new Set(expandedTools.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  expandedTools.value = set;
}

// Markdown render
function renderMarkdown(text: string): string {
  if (!text) return "";
  const raw = marked.parse(text, { async: false }) as string;
  return sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "details", "summary"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      code: ["class"]
    },
    allowedSchemes: ["http", "https", "mailto"]
  });
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || "{}"), null, 2);
  } catch {
    return raw || "{}";
  }
}

function fmtDuration(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

async function sendMessage() {
  const text = prompt.value.trim();
  if (!text || streaming.value) return;
  if (!workspaceValid()) return;

  const userMsg: UiMessage = { uid: nextUid(), role: "user", segments: [{ kind: "text", id: nextSegId(), content: text }], timestamp: new Date().toISOString() };
  messages.value.push(userMsg);
  prompt.value = "";
  resizeTextarea();
  streaming.value = true;
  currentStep.value = 0;
  usageInfo.value = null;
  abortController.value = new AbortController();
  pokeSseActivity();

  try {
    // Ensure daemonId is set for instance workspace
    let daemonId = selectedDaemonId.value;
    if (workspaceType.value === "instance" && !daemonId && selectedInstanceId.value) {
      const inst = allInstances.value.find((i) => i.uuid === selectedInstanceId.value);
      if (inst) daemonId = inst.daemonId;
    }

    const response = await fetch("/api/agent/run?token=" + (appState.userInfo?.token || ""), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({
        workspace: currentWorkspace.value,
        prompt: text,
        providerId: providerId.value,
        model: modelName.value,
        sessionId: activeSessionId.value || undefined,
        approved: autoApprove.value,
        mode: mode.value || "normal",
        daemonId: daemonId || undefined,
        instanceUuid: workspaceType.value === "instance" ? selectedInstanceId.value : undefined,
        file: referencedFile.value || undefined,
        stream: true
      }),
      signal: abortController.value.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => t("TXT_CODE_agent_error"));
      throw new Error(errText.slice(0, 500));
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let pendingEvent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Any raw byte counts as activity (covers keep-alive / comment frames
      // and partial events that never reach handleSSEEvent).
      pokeSseActivity();
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!rawEvent.trim()) continue;
        let event = pendingEvent;
        let dataStr = "";
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataStr += line.slice(6).trim();
        }
        pendingEvent = "";
        if (!dataStr) continue;
        pokeSseActivity();
        try {
          handleSSEEvent(event, JSON.parse(dataStr));
        } catch {
          /* ignore */
        }
      }
    }
    await fetchSessions();
    await updateSnapshots();
  } catch (err: any) {
    if (err.name === "AbortError") {
      messages.value.push({ uid: nextUid(), role: "assistant", segments: [{ kind: "error", id: nextSegId(), error: t("TXT_CODE_agent_aborted") }], timestamp: new Date().toISOString() });
    } else {
      messages.value.push({ uid: nextUid(), role: "assistant", segments: [{ kind: "error", id: nextSegId(), error: "Error: " + err.message }], timestamp: new Date().toISOString() });
    }
  } finally {
    clearSseWatchdog();
    streaming.value = false;
    abortController.value = null;
    // Close any live indicators
    for (const m of messages.value) {
      for (const seg of m.segments) {
        if (seg.kind === "thinking") seg.reasoningLive = false;
        if (seg.kind === "tool" && seg.tool && (seg.tool.status === "running" || seg.tool.status === "pending")) {
          seg.tool.status = "error";
        }
      }
    }
    scrollToBottom();
  }
}

function handleSSEEvent(event: string, data: any) {
  if (event === "step") {
    currentStep.value = data.step || 0;
  } else if (event === "reasoning") {
    const msg = ensureAssistantMessage();
    const seg = ensureSegment(msg, "thinking", () => ({ kind: "thinking", id: nextSegId(), reasoning: "", reasoningLive: true }));
    seg.reasoning = (seg.reasoning || "") + String(data.delta || "");
    seg.reasoningLive = true;
  } else if (event === "reasoning_done") {
    const msg = ensureAssistantMessage();
    const last = msg.segments[msg.segments.length - 1];
    if (last && last.kind === "thinking") last.reasoningLive = false;
  } else if (event === "message") {
    const msg = ensureAssistantMessage();
    const seg = ensureSegment(msg, "text", () => ({ kind: "text", id: nextSegId(), content: "" }));
    seg.content = (seg.content || "") + String(data.content || "");
  } else if (event === "message_done") {
    scrollToBottom();
  } else if (event === "tool_start") {
    const index = Number(data.index ?? 0);
    const callId = String(data.id || ("call_" + index));
    const name = String(data.name || "tool");
    const msg = ensureAssistantMessage();
    let seg = toolSegment(msg, callId, index);
    if (!seg) {
      seg = {
        kind: "tool",
        id: nextSegId(),
        tool: { index, id: callId, name, argsRaw: "", status: "running" }
      };
      msg.segments.push(seg);
    } else if (seg.tool) {
      // Segment was created earlier by tool_args (without the real id) - adopt
      // the id now so subsequent tool / tool_pending events match exactly.
      seg.tool.status = "running";
      seg.tool.id = callId || seg.tool.id;
      seg.tool.name = name || seg.tool.name;
    }
  } else if (event === "tool_args") {
    const msg = ensureAssistantMessage();
    const index = Number(data.index ?? 0);
    const callId = String(data.id || ("call_" + index));
    let seg = toolSegment(msg, callId, index);
    if (!seg) {
      // tool_args can race ahead of tool_start; open a running card and let
      // tool_start fill in the real id/name. Never name it "tool" permanently -
      // that placeholder only lasts until tool_start arrives.
      seg = { kind: "tool", id: nextSegId(), tool: { index, id: callId, name: "", argsRaw: "", status: "running" } };
      msg.segments.push(seg);
    }
    if (seg.tool) seg.tool.argsRaw += String(data.delta || "");
  } else if (event === "tool_pending") {
    const msg = ensureAssistantMessage();
    const index = Number(data.index ?? 0);
    const callId = String(data.id || ("call_" + index));
    let seg = toolSegment(msg, callId, index);
    if (!seg) {
      seg = {
        kind: "tool",
        id: nextSegId(),
        tool: { index, id: callId, name: String(data.name || "tool"), argsRaw: "", status: "pending" }
      };
      msg.segments.push(seg);
    }
    if (seg.tool) {
      // Adopt the real id if the card was created earlier by tool_args.
      seg.tool.id = callId || seg.tool.id;
      seg.tool.name = String(data.name || seg.tool.name || "tool");
      seg.tool.status = "pending";
      seg.tool.approvalId = data.approvalId;
    }
  } else if (event === "tool") {
    const msg = ensureAssistantMessage();
    const index = Number(data.index ?? 0);
    const callId = String(data.id || "");
    let seg = toolSegment(msg, callId, index);
    if (!seg) {
      seg = {
        kind: "tool",
        id: nextSegId(),
        tool: { index, id: String(data.id || ("call_" + index)), name: String(data.name || "tool"), argsRaw: "", status: "done" }
      };
      msg.segments.push(seg);
    }
    if (seg.tool) {
      seg.tool.id = String(data.id || seg.tool.id);
      seg.tool.name = String(data.name || seg.tool.name || "tool");
      seg.tool.argsRaw = typeof data.args === "string" ? data.args : JSON.stringify(data.args || {}, null, 2).slice(0, 4000);
      seg.tool.result = String(data.result || "");
      seg.tool.status = data.status === "error" ? "error" : "done";
      seg.tool.durationMs = data.durationMs;
    }
  } else if (event === "usage") {
    usageInfo.value = { ...(usageInfo.value || {}), ...data };
  } else if (event === "session") {
    if (data.id) {
      activeSessionId.value = data.id;
      fetchSessions();
    }
  } else if (event === "approval") {
    updateApprovals();
    const msg = ensureAssistantMessage();
    // The engine already emitted tool_pending for this call - attach to that
    // segment, or create ONE fallback card only when nothing is pending.
    const pendingSeg = [...msg.segments].reverse().find(
      (s) => s.kind === "tool" && s.tool && s.tool.status === "pending"
    );
    if (pendingSeg && pendingSeg.tool) {
      if (!pendingSeg.tool.approvalId) pendingSeg.tool.approvalId = data.id;
      pendingSeg.tool.name = data.tool || pendingSeg.tool.name;
      if (!pendingSeg.tool.argsRaw) pendingSeg.tool.argsRaw = JSON.stringify(data.args || {}, null, 2);
    } else {
      msg.segments.push({
        kind: "tool",
        id: nextSegId(),
        tool: {
          index: msg.segments.filter((s) => s.kind === "tool").length,
          id: "approval_" + data.id,
          name: data.tool || "approval",
          argsRaw: JSON.stringify(data.args || {}, null, 2),
          status: "pending",
          approvalId: data.id
        }
      });
    }
  } else if (event === "error") {
    const msg = ensureAssistantMessage();
    msg.segments.push({ kind: "error", id: nextSegId(), error: data.message || t("TXT_CODE_agent_error") });
  } else if (event === "done") {
    // Engine finished cleanly: close live indicators now instead of waiting
    // for the connection to end (also stops the idle watchdog from firing
    // during a long tail between done and socket close).
    pokeSseActivity();
  }
}

function abortRun() {
  if (abortController.value) abortController.value.abort();
  if (activeSessionId.value) {
    const { execute } = agentSessionAbort();
    execute({ params: { id: activeSessionId.value } }).catch(() => {});
  }
}

// Handle Enter / Shift+Enter
function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function resizeTextarea() {
  nextTick(() => {
    const el = inputTextarea.value;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  });
}

const inputFocused = ref(false);

const welcomeChips = computed(() => [
  { label: t("TXT_CODE_agent_welcome_1"), value: "@fix 检查最近的日志，找出问题" },
  { label: t("TXT_CODE_agent_welcome_2"), value: "@msl 写一个清除掉落物的插件" },
  { label: t("TXT_CODE_agent_welcome_3"), value: "查看服务器实例状态" }
]);

const drawerTitle = computed(() => {
  if (rightDrawerTab.value === "approvals") return t("TXT_CODE_agent_tab_approvals");
  if (rightDrawerTab.value === "changes") return t("TXT_CODE_agent_tab_changes");
  return t("TXT_CODE_agent_tab_ctx");
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------
const approvals = ref<AgentApproval[]>([]);
async function updateApprovals() {
  try {
    const { execute } = agentApprovals();
    const res = await execute({ forceRequest: true } as any);
    if (res.value) approvals.value = res.value.approvals || [];
  } catch {
    approvals.value = [];
  }
}
const pendingCount = computed(() => approvals.value.filter((a) => a.status === "pending").length);

function approvalStatusLabel(status: string): string {
  if (status === "pending") return t("TXT_CODE_agent_status_pending");
  if (status === "approved") return t("TXT_CODE_agent_status_approved");
  if (status === "rejected") return t("TXT_CODE_agent_status_rejected");
  return t("TXT_CODE_agent_status_expired");
}

async function approveApproval(id: string) {
  try {
    const { execute } = agentApprovalApprove();
    await execute({ params: { id } });
    await updateApprovals();
    message.success(t("TXT_CODE_agent_approve"));
  } catch {
    message.error(t("TXT_CODE_agent_error"));
  }
}
async function approveAlwaysApproval(id: string) {
  try {
    const { execute } = agentApprovalAlways();
    await execute({ params: { id } });
    await updateApprovals();
    message.success(t("TXT_CODE_agent_approve_always"));
  } catch {
    message.error(t("TXT_CODE_agent_error"));
  }
}

async function rejectApproval(id: string) {
  try {
    const { execute } = agentApprovalReject();
    await execute({ params: { id } });
    await updateApprovals();
  } catch {
    message.error(t("TXT_CODE_agent_error"));
  }
}
async function clearApprovals() {
  try {
    const { execute } = agentApprovalsClear();
    await execute({});
    await updateApprovals();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------
const snapshots = ref<AgentSnapshot[]>([]);
const selectedSnapshot = ref<AgentSnapshot | null>(null);
const showDiffDrawer = ref(false);

async function updateSnapshots() {
  if (!activeSessionId.value) return;
  try {
    const { execute } = agentSnapshots();
    const res = await execute({ params: { sessionId: activeSessionId.value }, forceRequest: true } as any);
    if (res.value) snapshots.value = res.value.snapshots || [];
  } catch {
    snapshots.value = [];
  }
}

async function rollbackSnapshot(id: string) {
  Modal.confirm({
    title: t("TXT_CODE_agent_rollback_confirm_title"),
    content: t("TXT_CODE_agent_rollback_confirm_body"),
    async onOk() {
      try {
        const { execute } = agentSnapshotRollback();
        const res = await execute({ params: { id } });
        if (res.value?.restored) {
          message.success(t("TXT_CODE_agent_rollback"));
          await updateSnapshots();
        }
      } catch {
        message.error(t("TXT_CODE_agent_error"));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Ctx estimation
// ---------------------------------------------------------------------------
const ctxUsed = computed(() => {
  let totalChars = 0;
  for (const m of messages.value) {
    for (const seg of m.segments) {
      if (seg.kind === "text") totalChars += (seg.content || "").length;
      else if (seg.kind === "thinking") totalChars += (seg.reasoning || "").length;
    }
  }
  return Math.round(totalChars / 4);
});
const currentProvider = computed(() => providers.value.find((p) => p.id === providerId.value));
const ctxBudget = computed(() => currentProvider.value?.ctx || 8192);
const ctxPct = computed(() => Math.min(100, Math.round((ctxUsed.value / ctxBudget.value) * 100)));

// ---------------------------------------------------------------------------
// Sidebar state (mobile drawer)
// ---------------------------------------------------------------------------
const sidebarOpen = ref(false);
const rightDrawerTab = ref<"ctx" | "approvals" | "changes">("ctx");
const rightDrawerOpen = ref(false);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let pollTimer: ReturnType<typeof setInterval> | null = null;

function applyQueryParams() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
  const inst = params.get("instanceUuid");
  const daemon = params.get("daemonId");
  const file = params.get("file");
  const ws = params.get("workspace");
  const seed = params.get("prompt");
  // A referenced file is displayed as a removable tag; the user still writes
  // their own question. Never pre-fill a canned prompt here.
  if (file) referencedFile.value = file;
  if (inst && daemon && inst !== GLOBAL_INSTANCE_UUID) {
    selectedInstanceId.value = inst;
    selectedDaemonId.value = daemon;
    if (seed) prompt.value = seed;
  } else if (ws) {
    // System folder mode: global0001 (non-instance browse) lands here.
    workspaceType.value = "folder";
    workspace.value = ws;
    if (seed) prompt.value = seed;
  }
}

onMounted(() => {
  fetchSessions();
  fetchProviders();
  loadInstances().then(() => applyQueryParams());
  updateApprovals();
  pollTimer = setInterval(() => {
    if (streaming.value) updateApprovals();
  }, 4000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  // Full stop on leave: abort the local fetch AND tell the panel to abort the
  // engine run, so the Agent stops working (and stops mutating files) even
  // when the user navigates away mid-run.
  abortRun();
});
</script>

<template>
  <div class="agent-page">
    <!-- Sidebar -->
    <div :class="['sidebar-mask', { show: sidebarOpen }]" @click="sidebarOpen = false" />
    <aside :class="['sidebar', { open: sidebarOpen }]">
      <div class="sidebar-new">
        <a-button type="primary" block class="new-session-btn" @click="newSession">
          <template #icon><PlusOutlined /></template>
          {{ t("TXT_CODE_agent_new") }}
        </a-button>
      </div>
      <div class="conv-list">
        <div
          v-for="s in sessions"
          :key="s.id"
          :class="['conv-item', { active: s.id === activeSessionId }]"
          @click="selectSession(s)"
        >
          <div class="conv-item-title">{{ sessionTitle(s) }}</div>
          <div class="conv-item-meta">
            <span v-if="s.mode !== 'normal'" class="mode-tag">@{{ s.mode }}</span>
            <span class="meta-text">{{ s.workspace.slice(0, 22) }}</span>
          </div>
          <span class="conv-item-del" @click.stop="deleteSession(s.id)"><DeleteOutlined /></span>
        </div>
        <div v-if="!sessions.length && !sessionsLoading" class="empty-hint">{{ t("TXT_CODE_agent_no_sessions") }}</div>
      </div>
      <div class="sidebar-footer">
        <a-button size="small" type="text" block @click="showProviderDialog = true">
          <template #icon><SettingOutlined /></template>
          {{ t("TXT_CODE_agent_provider") }}
        </a-button>
      </div>
    </aside>

    <!-- Main -->
    <div class="chat-main">
      <!-- Top bar -->
      <div class="topbar">
        <div class="topbar-left">
          <a-button v-if="isPhone" class="topbar-menu-btn" @click="sidebarOpen = true">
            <template #icon><MenuOutlined /></template>
          </a-button>
          <div class="brand">
            <div class="brand-logo"><AgentStarIcon :size="17" :sparkle="true" /></div>
            <div class="brand-text">
              <span class="brand-name">MCSM-AI</span>
              <span class="brand-sub">Agent</span>
            </div>
          </div>
          <span v-if="mode !== 'normal'" class="mode-chip">
            <a-tag :color="mode === 'fix' ? 'orange' : 'green'" size="small">@{{ mode }}</a-tag>
          </span>
        </div>
        <div class="topbar-right">
          <button class="ctx-chip" @click="rightDrawerOpen = true; rightDrawerTab = 'ctx'">
            <ProfileOutlined />
            <span class="ctx-label">{{ t("TXT_CODE_agent_tab_ctx") }}</span>
            <span class="ctx-msg-count">{{ ctxUsed }} / {{ ctxBudget }}</span>
          </button>
          <a-badge v-if="pendingCount" :count="pendingCount" size="small">
            <a-button size="small" type="text" class="topbar-approvals" @click="rightDrawerOpen = true; rightDrawerTab = 'approvals'">
              <ThunderboltOutlined /> {{ t("TXT_CODE_agent_tab_approvals") }}
            </a-button>
          </a-badge>
        </div>
      </div>

      <!-- Messages -->
      <div ref="chatContainer" class="messages">
        <div class="messages-inner">
          <div v-if="!messages.length && !streaming" class="welcome">
            <div class="welcome-badge"><AgentStarIcon :size="30" :sparkle="true" /></div>
            <div class="welcome-title">MCSM-AI <span>Agent</span></div>
            <p>{{ t("TXT_CODE_agent_welcome_sub") }}</p>
            <div class="welcome-chips">
              <button v-for="chip in welcomeChips" :key="chip.value" class="welcome-chip" @click="prompt = chip.value">
                <ThunderboltFilled /> {{ chip.label }}
              </button>
            </div>
          </div>

          <div v-for="(msg, idx) in messages" :key="msg.uid" :class="['msg', msg.role]">
            <!-- User: pure bubble, right aligned -->
            <template v-if="msg.role === 'user'">
              <div class="msg-body">
                <div v-for="seg in msg.segments" :key="seg.id" class="msg-user-text">{{ seg.content }}</div>
              </div>
            </template>
            <!-- Assistant: segments rendered in arrival order -->
            <template v-else>
              <div class="msg-body">
                <div class="msg-head">
                  <span class="agent-name">
                    <AgentStarIcon :size="12" class="agent-name-star" />
                    {{ t("TXT_CODE_agent_agent") }}
                  </span>
                  <span v-if="msg.modelLabel" class="agent-model-chip">{{ msg.modelLabel }}</span>
                </div>

                <template v-for="seg in msg.segments" :key="seg.id">
                  <!-- Thinking block -->
                  <div v-if="seg.kind === 'thinking'" :class="['thinking-block', { live: seg.reasoningLive }]">
                    <div class="thinking-head" @click="toggleThinking(seg.id)">
                      <span class="thinking-icon"><BulbOutlined /></span>
                      <span class="thinking-title">{{ t("TXT_CODE_agent_thinking_title") }}</span>
                      <span v-if="seg.reasoningLive" class="thinking-live"><LoadingOutlined spin /> {{ t("TXT_CODE_agent_thinking_live") }}</span>
                      <span v-else class="thinking-done"><CheckCircleFilled /></span>
                      <span class="thinking-toggle">
                        <UpOutlined v-if="!collapsedThinking.has(seg.id)" />
                        <DownOutlined v-else />
                      </span>
                    </div>
                    <div v-show="!collapsedThinking.has(seg.id)" class="thinking-body">{{ seg.reasoning }}</div>
                  </div>

                  <!-- Tool call (inline where it happened) -->
                  <div v-else-if="seg.kind === 'tool' && seg.tool" :class="['tool-block', 'tool-' + seg.tool.status]">
                    <div class="tool-head" @click="toggleTool(seg.id)">
                      <span class="tool-icon">
                        <LoadingOutlined v-if="seg.tool.status === 'running'" spin />
                        <ClockCircleOutlined v-else-if="seg.tool.status === 'pending'" />
                        <CheckCircleFilled v-else-if="seg.tool.status === 'done'" />
                        <CloseCircleFilled v-else />
                      </span>
                      <span class="tool-name"><ToolOutlined /> {{ seg.tool.name }}</span>
                      <span class="tool-status">
                        <template v-if="seg.tool.status === 'running'">{{ t("TXT_CODE_agent_tool_running") }}</template>
                        <template v-else-if="seg.tool.status === 'pending'">{{ t("TXT_CODE_agent_tool_pending") }}</template>
                        <template v-else-if="seg.tool.status === 'done'">{{ t("TXT_CODE_agent_tool_done") }}</template>
                        <template v-else>{{ t("TXT_CODE_agent_tool_error") }}</template>
                      </span>
                      <span v-if="seg.tool.durationMs != null" class="tool-duration">{{ fmtDuration(seg.tool.durationMs) }}</span>
                      <span class="tool-toggle">
                        <UpOutlined v-if="!expandedTools.has(seg.id)" />
                        <DownOutlined v-else />
                      </span>
                    </div>
                    <div v-show="expandedTools.has(seg.id)" class="tool-detail">
                      <div v-if="seg.tool.argsRaw" class="tool-section">
                        <div class="tool-section-title">{{ t("TXT_CODE_agent_tool_args") }}</div>
                        <pre class="tool-pre">{{ prettyArgs(seg.tool.argsRaw) }}</pre>
                      </div>
                      <div v-if="seg.tool.result" class="tool-section">
                        <div class="tool-section-title">{{ t("TXT_CODE_agent_tool_result") }}</div>
                        <pre class="tool-pre">{{ seg.tool.result }}</pre>
                      </div>
                    </div>
                  </div>

                  <!-- Markdown text -->
                  <div v-else-if="seg.kind === 'text'" class="msg-markdown" v-html="renderMarkdown(seg.content || '')">
                  </div>

                  <!-- Error -->
                  <div v-else-if="seg.kind === 'error'" class="msg-error">
                    <ExclamationCircleOutlined /> {{ seg.error }}
                  </div>
                </template>

                <!-- typing cursor on the last text segment while streaming -->
                <span
                  v-if="streaming && idx === messages.length - 1 && msg.segments.length && msg.segments[msg.segments.length - 1].kind === 'text'"
                  class="typing-cursor"
                />
              </div>
            </template>
          </div>

          <div
            v-if="streaming && (!messages.length || messages[messages.length - 1].role !== 'assistant')"
            class="msg assistant idle-stream"
          >
            <div class="msg-body">
              <span class="msg-streaming">
                <span class="dot d1" />
                <span class="dot d2" />
                <span class="dot d3" />
                {{ t("TXT_CODE_agent_waiting") }} {{ t("TXT_CODE_agent_thinking") }} {{ currentStep + 1 }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Input card -->
      <div class="input-wrap">
        <div class="input-card" :class="{ focused: inputFocused }">
          <div v-if="referencedFile" class="ref-file-row">
            <span class="ref-file-tag">
              <FileOutlined />
              <span class="ref-file-text" :title="referencedFile">{{ referencedFile }}</span>
              <CloseOutlined class="ref-file-close" @click="referencedFile = ''" />
            </span>
          </div>
          <div class="input-card-textarea">
            <textarea
              ref="inputTextarea"
              v-model="prompt"
              rows="1"
              :placeholder="t('TXT_CODE_agent_placeholder')"
              @keydown="handleKeyDown"
              @input="resizeTextarea"
              @focus="inputFocused = true"
              @blur="inputFocused = false"
            />
          </div>
          <div class="input-card-bottom">
            <div class="input-left">
              <a-select v-model:value="workspaceType" size="small" class="ws-type">
                <a-select-option value="instance">
                  <NodeIndexOutlined /> {{ t("TXT_CODE_agent_workspace_instance") }}
                </a-select-option>
                <a-select-option value="folder">
                  <FileOutlined /> {{ t("TXT_CODE_agent_workspace_folder") }}
                </a-select-option>
              </a-select>
              <a-select
                v-if="workspaceType === 'instance'"
                v-model:value="selectedInstanceId"
                size="small"
                :loading="instancesLoading"
                class="ws-select"
                :placeholder="t('TXT_CODE_agent_select_instance')"
                @focus="loadInstances"
              >
                <a-select-option v-for="inst in allInstances" :key="inst.uuid" :value="inst.uuid">
                  <NodeIndexOutlined /> {{ inst.nickname }}
                </a-select-option>
              </a-select>
              <a-input
                v-else
                v-model:value="workspace"
                size="small"
                class="ws-select"
                :placeholder="t('TXT_CODE_agent_folder_hint')"
              />
            </div>
            <div class="input-right">
              <!-- Model selector: provider name + model name -->
              <a-select
                v-model:value="modelKey"
                size="small"
                class="model-select"
                :placeholder="t('TXT_CODE_agent_model_select')"
                option-label-prop="label"
                popup-class-name="agent-model-popup"
              >
                <a-select-option
                  v-for="opt in modelOptions"
                  :key="opt.value"
                  :value="opt.value"
                  :label="opt.label"
                >
                  <div class="model-opt">
                    <span class="model-provider"><span class="model-dot" /> {{ opt.providerLabel }}</span>
                    <span class="model-name">{{ opt.model }}</span>
                  </div>
                </a-select-option>
              </a-select>

              <!-- Permission (auto approve) -->
              <a-tooltip :title="t('TXT_CODE_agent_auto_approve_desc')">
                <button
                  class="perm-toggle"
                  :class="{ on: autoApprove }"
                  @click="autoApprove = !autoApprove"
                >
                  <LockOutlined v-if="!autoApprove" />
                  <UnlockOutlined v-else />
                  <span class="perm-label">{{ t("TXT_CODE_agent_permission") }}</span>
                </button>
              </a-tooltip>

              <!-- Send -->
              <button
                class="send-btn"
                :class="{ disabled: !canSend }"
                :disabled="!canSend"
                @click="sendMessage"
              >
                <StopOutlined v-if="streaming" />
                <ArrowUpOutlined v-else />
              </button>
            </div>
          </div>
          <div v-if="streaming" class="input-abort" @click="abortRun">{{ t("TXT_CODE_agent_stop_run") }}</div>
        </div>
        <div class="input-hint">
          <span><kbd>Enter</kbd> {{ t("TXT_CODE_agent_send") }}</span>
          <span class="hint-sep">·</span>
          <span><kbd>Shift</kbd> + <kbd>Enter</kbd> {{ t("TXT_CODE_agent_newline") }}</span>
        </div>
      </div>
    </div>

    <!-- Right drawer: ctx / approvals / changes -->
    <a-drawer
      :open="rightDrawerOpen"
      placement="right"
      width="400px"
      root-class-name="agent-drawer"
      :body-style="{ padding: '20px 20px 26px' }"
      :destroy-on-close="true"
      @close="rightDrawerOpen = false"
    >
      <div class="drawer-inner">
        <div class="drawer-head">
          <div class="drawer-head-icon"><ProfileOutlined /></div>
          <div class="drawer-head-title">
            <div class="drawer-title">{{ drawerTitle }}</div>
            <div class="drawer-sub">{{ t("TXT_CODE_agent_drawer_sub") }}</div>
          </div>
          <button class="drawer-close" @click="rightDrawerOpen = false"><CloseOutlined /></button>
        </div>

        <div class="drawer-tabs">
          <button
            :class="['drawer-tab', { active: rightDrawerTab === 'ctx' }]"
            @click="rightDrawerTab = 'ctx'"
          >
            <ProfileOutlined /> {{ t("TXT_CODE_agent_tab_ctx") }}
          </button>
          <button
            :class="['drawer-tab', { active: rightDrawerTab === 'approvals' }]"
            @click="rightDrawerTab = 'approvals'"
          >
            <ThunderboltOutlined /> {{ t("TXT_CODE_agent_tab_approvals") }}
            <span v-if="pendingCount" class="tab-count">{{ pendingCount }}</span>
          </button>
          <button
            :class="['drawer-tab', { active: rightDrawerTab === 'changes' }]"
            @click="rightDrawerTab = 'changes'"
          >
            <RollbackOutlined /> {{ t("TXT_CODE_agent_tab_changes") }}
            <span v-if="snapshots.length" class="tab-count">{{ snapshots.length }}</span>
          </button>
        </div>

        <!-- Ctx panel -->
        <div v-if="rightDrawerTab === 'ctx'" class="drawer-section fade-in">
          <div class="ctx-hero">
            <div class="ctx-hero-ring" :style="{ '--pct': ctxPct + '%' }">
              <div class="ctx-hero-num"><span class="num">{{ ctxPct }}</span><span class="percent">%</span></div>
              <div class="ctx-hero-label">{{ t("TXT_CODE_agent_ctx_used") }}</div>
            </div>
            <div class="ctx-hero-info">
              <div class="ctx-info-row">
                <span class="ctx-info-label">{{ t("TXT_CODE_agent_ctx_provider") }}</span>
                <span class="ctx-info-value">{{ currentProvider?.label || '-' }}</span>
              </div>
              <div class="ctx-info-row">
                <span class="ctx-info-label">{{ t("TXT_CODE_agent_ctx_model") }}</span>
                <span class="ctx-info-value mono">{{ modelName || '-' }}</span>
              </div>
              <div class="ctx-info-row">
                <span class="ctx-info-label">{{ t("TXT_CODE_agent_ctx_budget") }}</span>
                <span class="ctx-info-value">{{ ctxBudget }} tokens</span>
              </div>
            </div>
          </div>

          <div class="ctx-bar">
            <div class="ctx-bar-track">
              <div class="ctx-bar-fill" :style="{ width: ctxPct + '%' }" />
            </div>
            <div class="ctx-bar-footer">
              <span>{{ ctxUsed }} / {{ ctxBudget }} <small>tokens</small></span>
              <span>{{ t("TXT_CODE_agent_ctx_messages") }} · {{ messages.length }}</span>
            </div>
          </div>

          <div class="drawer-card">
            <div class="drawer-card-title"><ThunderboltFilled /> {{ t("TXT_CODE_agent_ctx_usage") }}</div>
            <div class="usage-grid">
              <div class="usage-item">
                <span class="usage-label">{{ t("TXT_CODE_agent_ctx_prompt") }}</span>
                <span class="usage-value">{{ usageInfo?.prompt_tokens ?? '-' }}</span>
              </div>
              <div class="usage-item">
                <span class="usage-label">{{ t("TXT_CODE_agent_ctx_completion") }}</span>
                <span class="usage-value">{{ usageInfo?.completion_tokens ?? '-' }}</span>
              </div>
              <div class="usage-item">
                <span class="usage-label">{{ t("TXT_CODE_agent_ctx_reasoning") }}</span>
                <span class="usage-value">{{ usageInfo?.reasoning_tokens ?? '-' }}</span>
              </div>
              <div class="usage-item strong">
                <span class="usage-label">{{ t("TXT_CODE_agent_ctx_total") }}</span>
                <span class="usage-value">{{ usageInfo?.total_tokens ?? '-' }}</span>
              </div>
            </div>
            <div v-if="!usageInfo" class="usage-empty">{{ t("TXT_CODE_agent_ctx_usage_empty") }}</div>
          </div>

          <div v-if="modelOptions.length" class="drawer-card">
            <div class="drawer-card-title"><AgentStarIcon :size="13" gradient /> {{ t("TXT_CODE_agent_provider_models") }}</div>
            <div class="model-list">
              <div
                v-for="opt in modelOptions"
                :key="opt.value"
                :class="['model-list-item', { active: opt.value === modelKey }]"
                @click="modelKey = opt.value"
              >
                <span class="model-list-provider">{{ opt.providerLabel }}</span>
                <span class="model-list-name">{{ opt.model }}</span>
                <CheckOutlined v-if="opt.value === modelKey" class="model-list-check" />
              </div>
            </div>
          </div>
        </div>

        <!-- Approvals panel -->
        <div v-if="rightDrawerTab === 'approvals'" class="drawer-section fade-in">
          <div
            v-for="a in approvals"
            :key="a.id"
            :class="['approval-item', a.status, { live: a.status === 'pending' }]"
          >
            <div class="approval-head">
              <span class="approval-icon"><ToolOutlined /></span>
              <span class="approval-tool">{{ a.tool }}</span>
              <span :class="['approval-badge', a.status]">
                <LoadingOutlined v-if="a.status === 'pending'" spin />
                <CheckOutlined v-else-if="a.status === 'approved'" />
                <CloseOutlined v-else-if="a.status === 'rejected'" />
                <ExclamationCircleOutlined v-else />
                {{ approvalStatusLabel(a.status) }}
                <template v-if="a.always"> · {{ t("TXT_CODE_agent_approve_always") }}</template>
              </span>
            </div>
            <div class="approval-reason">{{ a.reason }}</div>
            <div v-if="a.pattern" class="approval-pattern mono">{{ a.permission }} {{ a.pattern }}</div>
            <pre class="approval-args">{{ JSON.stringify(a.args, null, 1).slice(0, 300) }}</pre>
            <div v-if="a.status === 'pending'" class="approval-actions">
              <a-button size="small" type="primary" @click="approveApproval(a.id)">
                <CheckOutlined /> {{ t("TXT_CODE_agent_approve") }}
              </a-button>
              <a-tooltip :title="t('TXT_CODE_agent_approve_always_desc')">
                <a-button size="small" class="always-btn" @click="approveAlwaysApproval(a.id)">
                  <ThunderboltFilled /> {{ t("TXT_CODE_agent_approve_always") }}
                </a-button>
              </a-tooltip>
              <a-button size="small" danger @click="rejectApproval(a.id)">
                <CloseOutlined /> {{ t("TXT_CODE_agent_reject") }}
              </a-button>
            </div>
          </div>
          <div v-if="!approvals.length" class="empty-well">{{ t("TXT_CODE_agent_no_approvals") }}</div>
          <a-button v-if="approvals.length" size="small" block class="clear-btn" @click="clearApprovals">
            <ClearOutlined /> {{ t("TXT_CODE_agent_clear_approvals") }}
          </a-button>
        </div>

        <!-- Changes panel -->
        <div v-if="rightDrawerTab === 'changes'" class="drawer-section fade-in">
          <div v-for="s in snapshots" :key="s.id" class="snapshot-item">
            <div class="snapshot-head">
              <span class="snapshot-icon"><FileOutlined /></span>
              <span class="snapshot-file">{{ s.relativePath }}</span>
            </div>
            <div class="snapshot-meta">
              <span v-if="s.rolledBack" class="snapshot-rolled"><RollbackOutlined /> {{ t("TXT_CODE_agent_rollback") }}</span>
              <template v-else>
                <FileOutlined /> {{ s.beforeSize }} → {{ s.afterSize }} B
              </template>
              <span class="snapshot-time">{{ new Date(s.createdAt).toLocaleString() }}</span>
            </div>
            <div class="snapshot-actions">
              <a-button size="small" @click="selectedSnapshot = s; showDiffDrawer = true">
                <FileOutlined /> {{ t("TXT_CODE_agent_diff") }}
              </a-button>
              <a-button size="small" :disabled="s.rolledBack" @click="rollbackSnapshot(s.id)">
                <RollbackOutlined /> {{ t("TXT_CODE_agent_rollback") }}
              </a-button>
            </div>
          </div>
          <div v-if="!snapshots.length" class="empty-well">{{ t("TXT_CODE_agent_no_changes") }}</div>
        </div>
      </div>
    </a-drawer>

    <!-- Provider dialog -->
    <a-modal
      :open="showProviderDialog"
      :title="editingProviderId ? t('TXT_CODE_agent_edit_provider') : t('TXT_CODE_agent_add_provider')"
      width="540px"
      :footer="null"
      :destroy-on-close="true"
      @cancel="showProviderDialog = false"
    >
      <div class="provider-form">
        <label>{{ t("TXT_CODE_agent_provider_label") }}</label>
        <a-input v-model:value="providerForm.label" />
        <label>{{ t("TXT_CODE_agent_provider_endpoint") }}</label>
        <a-input v-model:value="providerForm.endpoint" />
        <label>{{ t("TXT_CODE_agent_provider_apikey") }}</label>
        <a-input-password v-model:value="providerForm.apiKey" />
        <label>{{ t("TXT_CODE_agent_provider_models") }}</label>
        <a-select
          v-model:value="providerForm._models"
          mode="tags"
          class="models-tags"
          :placeholder="t('TXT_CODE_agent_models_placeholder')"
          :token-separators="[',']"
          :open="false"
        />
        <small class="models-hint">{{ t("TXT_CODE_agent_models_hint") }}</small>
        <div class="form-grid">
          <div>
            <label>{{ t("TXT_CODE_agent_provider_maxtoken") }}</label>
            <a-input v-model:value="providerForm.maxToken" type="number" />
          </div>
          <div>
            <label>{{ t("TXT_CODE_agent_provider_ctx") }}</label>
            <a-input v-model:value="providerForm.ctx" type="number" />
          </div>
        </div>
        <div class="form-row">
          <span class="form-label">{{ t("TXT_CODE_agent_provider_reasoning") }}</span>
          <a-switch v-model:checked="providerForm.reasoning" />
          <a-input v-if="providerForm.reasoning" v-model:value="providerForm.reasoningMode" style="width:120px" />
        </div>
        <label>{{ t("TXT_CODE_agent_provider_search") }}</label>
        <a-input v-model:value="providerForm.searchEndpoint" />
        <label>{{ t("TXT_CODE_agent_provider_searchkey") }}</label>
        <a-input-password v-model:value="providerForm.searchApiKey" />
        <label>{{ t("TXT_CODE_agent_provider_allowed") }}</label>
        <a-textarea v-model:value="providerForm._allowedHostsText" :rows="2" />
        <div class="provider-list">
          <div v-for="p in providers" :key="p.id" class="provider-item">
            <div class="provider-item-info">
              <span class="provider-item-name">{{ p.label }}</span>
              <span class="provider-item-models">{{ (p.models && p.models.length ? p.models : [p.model]).join(', ') }}</span>
            </div>
            <div class="provider-item-actions">
              <a-tooltip :title="t('TXT_CODE_agent_set_default')">
                <a-button size="small" type="text" @click="setDefaultProvider(p.id)"><CheckOutlined /></a-button>
              </a-tooltip>
              <a-button size="small" type="text" @click="openEditProvider(p)"><SettingOutlined /></a-button>
              <a-button size="small" type="text" danger @click="deleteProvider(p.id)"><DeleteOutlined /></a-button>
            </div>
          </div>
        </div>
        <div class="form-actions">
          <a-button @click="showProviderDialog = false">{{ t("TXT_CODE_agent_cancel") }}</a-button>
          <a-button type="primary" @click="saveProvider">{{ t("TXT_CODE_agent_save") }}</a-button>
        </div>
      </div>
    </a-modal>

    <!-- Diff drawer -->
    <a-drawer :open="showDiffDrawer" :title="t('TXT_CODE_agent_diff')" placement="right" width="600px" :destroy-on-close="true" @close="showDiffDrawer = false">
      <div v-if="selectedSnapshot">
        <div class="diff-file">{{ selectedSnapshot.relativePath }}</div>
        <div class="diff-meta">{{ selectedSnapshot.beforeSize }} → {{ selectedSnapshot.afterSize }} B · {{ selectedSnapshot.rolledBack ? t('TXT_CODE_agent_rollback') : t('TXT_CODE_agent_tool_done') }}</div>
        <pre class="diff-content">{{ selectedSnapshot.diff }}</pre>
      </div>
    </a-drawer>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
export default defineComponent({ name: "AgentPage" });
</script>

<style lang="scss" scoped>
@import "@/assets/global.scss";

.agent-page {
  position: relative;
  display: flex;
  height: calc(100svh - 146px);
  min-height: 420px;
  margin: 0 16px 16px;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--color-gray-5);
  box-shadow: var(--ag-shadow);
  background-color: var(--level-2-bg-color, var(--background-color));
  backdrop-filter: saturate(110%) blur(4px);
  -webkit-backdrop-filter: saturate(110%) blur(4px);
  color: var(--text-color);

  --ag-accent: #1677ff;
  --ag-accent-2: #0958d9;
  --ag-grad: linear-gradient(135deg, #1677ff 0%, #4096ff 60%, #69b1ff 100%);
  --ag-grad-soft: linear-gradient(135deg, rgba(22,119,255,0.14), rgba(64,150,255,0.1));
  --ag-radius: 12px;
  --ag-shadow: 0 16px 44px rgba(31, 41, 80, 0.12), 0 2px 8px rgba(31, 41, 80, 0.06);
  --ag-border: var(--card-border-color);
}

// ------------------------------------------------------------------
// Sidebar
// ------------------------------------------------------------------
.sidebar-mask { display: none; }
.sidebar {
  width: 264px; flex-shrink: 0; border-right: 1px solid var(--ag-border);
  display: flex; flex-direction: column; background-color: var(--background-color-white);

  .sidebar-new { margin: 16px 14px 10px;
    .new-session-btn { border-radius: 12px; box-shadow: 0 4px 14px rgba(22,119,255,0.35); }
  }

  .conv-list { flex: 1; overflow-y: auto; padding: 6px 12px 12px;
    .conv-item { position: relative; display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; margin-top: 4px; border-radius: 10px; cursor: pointer; border: 1px solid transparent; transition: background-color 0.15s ease, border-color 0.15s ease;
      &:hover { background-color: var(--color-gray-3); }
      &.active { background-color: var(--ag-grad-soft); border-color: rgba(22,119,255,0.35);
        .conv-item-title { color: var(--ag-accent); font-weight: 600; }
      }
      .conv-item-title { font-size: 13px; color: var(--text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 24px; }
      .conv-item-meta { font-size: 11px; color: var(--color-gray-7); display: flex; align-items: center; gap: 6px; overflow: hidden;
        .mode-tag { color: var(--ag-accent-2); font-weight: 600; }
        .meta-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      }
      .conv-item-del { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--color-gray-7); opacity: 0; transition: opacity 0.12s;
        &:hover { color: var(--color-red-6); }
      }
      &:hover .conv-item-del { opacity: 1; }
    }
  }

  .sidebar-footer { padding: 10px 12px; border-top: 1px solid var(--ag-border); }
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar {
  display: flex; align-items: center; gap: 12px; height: 58px; padding: 0 18px;
  border-bottom: 1px solid var(--ag-border); background-color: var(--background-color-white); flex-shrink: 0; z-index: 5;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);

  .topbar-left { display: flex; align-items: center; gap: 8px; }
  .topbar-menu-btn { display: none; }
  .brand { display: inline-flex; align-items: center; gap: 8px;
    .brand-logo { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: #fff; background: var(--ag-grad); box-shadow: 0 4px 12px rgba(22,119,255,0.35); transition: transform 0.2s ease; }
    .brand-logo:hover { transform: rotate(-8deg) scale(1.06); }
    .brand-text { display: flex; align-items: baseline; gap: 6px;
      .brand-name { font-size: 15px; font-weight: 700; background: var(--ag-grad); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
      .brand-sub { font-weight: 400; color: var(--color-gray-7); font-size: 12px; }
    }
  }
  .mode-chip { display: inline-flex; }

  .topbar-center { flex: 1; display: flex; align-items: center; gap: 8px; justify-content: center; }
  .ctx-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-color); background-color: var(--color-gray-3); border: 1px solid var(--ag-border); border-radius: 999px; padding: 5px 12px; cursor: pointer; transition: box-shadow 0.15s, border-color 0.15s;
    &:hover { border-color: var(--ag-accent); box-shadow: 0 2px 10px rgba(22,119,255,0.35); }
    .ctx-label { font-weight: 600; }
    .ctx-msg-count { color: var(--color-gray-7); font-variant-numeric: tabular-nums; }
  }
  .topbar-approvals { color: var(--ag-accent-2); }
  .topbar-right { display: flex; align-items: center; gap: 8px; margin-left: auto; }
}

// ------------------------------------------------------------------
// Messages
// ------------------------------------------------------------------
.messages { flex: 1; overflow-y: auto; padding: 22px 0 10px;
  .messages-inner { max-width: 840px; margin: 0 auto; padding: 0 20px; }

  .welcome { max-width: 620px; margin: 48px auto 24px; text-align: center; padding: 0 20px;
    .welcome-badge { position: relative; width: 68px; height: 68px; margin: 0 auto 18px; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 30px; color: #fff; background: var(--ag-grad); box-shadow: 0 10px 30px rgba(22,119,255,0.35); animation: welcome-float 3.4s ease-in-out infinite;
      &::after { content: ""; position: absolute; inset: -10px; border-radius: 22px; background: radial-gradient(closest-side, rgba(22,119,255,0.18), transparent); z-index: -1; }
    }
    .welcome-title { font-size: 26px; font-weight: 800; margin-bottom: 8px; background: var(--ag-grad); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
      span { font-weight: 400; font-size: 18px; -webkit-text-fill-color: var(--color-gray-7); }
    }
    p { color: var(--color-gray-7); font-size: 14px; line-height: 1.7; }
    .welcome-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 18px;
      .welcome-chip { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--ag-border); background-color: var(--background-color-white); color: var(--text-color); font-size: 12.5px; cursor: pointer; transition: all 0.18s ease; box-shadow: 0 2px 6px rgba(31,41,80,0.05);
        &:hover { border-color: var(--ag-accent); color: var(--ag-accent); transform: translateY(-1px); box-shadow: 0 6px 16px rgba(22,119,255,0.35); }
        .anticon { color: var(--ag-accent-2); }
      }
    }
  }

  .msg { display: flex; gap: 12px; padding: 13px 0;

    .msg-body { flex: 1; min-width: 0; font-size: 14px; line-height: 1.75; }

    &.user { flex-direction: row-reverse;
      .msg-user-text { background: var(--ag-grad-soft); border: 1px solid rgba(22,119,255,0.35); border-radius: 10px 10px 4px 10px; padding: 9px 15px; white-space: pre-wrap; word-break: break-word; max-width: 85%; margin-left: auto; }
    }

    .msg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px;
      .agent-name { font-size: 13px; font-weight: 700; color: var(--text-color); display: flex; align-items: center; gap: 5px;
        .agent-name-star { color: var(--ag-accent-2); }
      }
      .agent-model-chip { font-size: 10.5px; color: var(--color-gray-7); background-color: var(--color-gray-2); border: 1px solid var(--ag-border); padding: 1.5px 8px; border-radius: 999px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    }

    .msg-streaming { color: var(--color-gray-7); font-size: 13px; display: inline-flex; align-items: center; gap: 4px;
      .dot { width: 5px; height: 5px; border-radius: 50%; background-color: var(--ag-accent); animation: dot-bounce 1.2s infinite; }
      .d2 { animation-delay: 0.15s; } .d3 { animation-delay: 0.3s; }
    }
  }

  .idle-stream .msg-body { padding-top: 6px; }
}

// Thinking block
.thinking-block { margin: 6px 0 10px; border: 1px solid var(--ag-border); border-left: 3px solid var(--ag-accent-2); border-radius: 8px; background-color: var(--color-gray-2); overflow: hidden;
  &.live { border-left-color: var(--ag-accent); box-shadow: 0 2px 12px rgba(22,119,255,0.35); }
  .thinking-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; user-select: none;
    .thinking-icon { color: var(--ag-accent-2); font-size: 14px; }
    .thinking-title { font-size: 12px; font-weight: 600; }
    .thinking-live { font-size: 11px; color: var(--ag-accent); display: inline-flex; align-items: center; gap: 4px; }
    .thinking-done { color: var(--color-green-6); font-size: 13px; }
    .thinking-toggle { margin-left: auto; color: var(--color-gray-7); font-size: 10px; }
  }
  .thinking-body { padding: 4px 14px 12px; font-size: 12.5px; line-height: 1.7; color: var(--color-gray-7); white-space: pre-wrap; word-break: break-word; border-top: 1px dashed var(--ag-border); max-height: 220px; overflow: auto;
    &::selection { background: rgba(22,119,255,0.35); }
  }
}

.tool-block { margin: 6px 0 10px; border: 1px solid var(--ag-border); border-radius: 8px; background-color: var(--background-color-white); overflow: hidden; transition: border-color 0.15s;
  &.tool-running { border-color: rgba(22,119,255,0.35); }
  &.tool-error { border-color: rgba(207,34,46,0.4); }
  .tool-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; user-select: none;
    .tool-icon { font-size: 14px; display: inline-flex;
      &.tool-running { color: var(--ag-accent); }
    }
    .tool-name { font-size: 12.5px; font-weight: 600; font-family: ui-monospace, Consolas, monospace; display: inline-flex; align-items: center; gap: 5px; color: var(--text-color);
      .anticon { color: var(--ag-accent-2); font-size: 12px; }
    }
    .tool-status { font-size: 11px; margin-left: auto;
      .tool-running & { color: var(--ag-accent); }
      .tool-pending & { color: var(--color-orange-6); }
      .tool-done & { color: var(--color-green-6); }
      .tool-error & { color: var(--color-red-6); }
    }
    .tool-duration { font-size: 10.5px; color: var(--color-gray-7); font-variant-numeric: tabular-nums; }
    .tool-toggle { color: var(--color-gray-7); font-size: 10px; }
  }
  .tool-detail { border-top: 1px dashed var(--ag-border); background-color: var(--color-gray-2); padding: 8px 12px;
    .tool-section { margin-bottom: 6px;
      .tool-section-title { font-size: 10.5px; font-weight: 700; color: var(--color-gray-7); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; }
    }
    .tool-pre { font-size: 11px; line-height: 1.55; background-color: var(--color-gray-1); border: 1px solid var(--ag-border); border-radius: 6px; padding: 8px; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, Consolas, monospace; color: var(--text-color); }
  }
}

.msg-markdown { word-break: break-word;
  :deep(h1), :deep(h2), :deep(h3), :deep(h4) { margin: 16px 0 8px; font-weight: 600; line-height: 1.4; }
  :deep(h1) { font-size: 20px; border-bottom: 1px solid var(--ag-border); padding-bottom: 6px; }
  :deep(h2) { font-size: 17px; } :deep(h3) { font-size: 15px; }
  :deep(p) { margin: 8px 0; }
  :deep(ul), :deep(ol) { margin: 8px 0; padding-left: 22px; }
  :deep(blockquote) { margin: 10px 0; padding: 4px 14px; border-left: 3px solid var(--ag-accent-2); color: var(--color-gray-7); background-color: var(--color-gray-2); border-radius: 0 6px 6px 0; }
  :deep(a) { color: var(--ag-accent); text-decoration: none; &:hover { text-decoration: underline; } }
  :deep(code) { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; background-color: var(--color-gray-3); color: var(--color-red-7); padding: 1.5px 5px; border-radius: 5px; }
  :deep(pre) { margin: 10px 0; padding: 12px; overflow-x: auto; border: 1px solid var(--ag-border); border-radius: 8px; background-color: var(--color-gray-2); code { background: transparent; padding: 0; color: var(--text-color); } }
  :deep(table) { border-collapse: collapse; font-size: 13px; width: 100%; margin: 10px 0; }
  :deep(th), :deep(td) { border: 1px solid var(--color-gray-5); padding: 6px 10px; text-align: left; }
  :deep(th) { background-color: var(--color-gray-3); font-weight: 600; }
  :deep(hr) { border: none; border-top: 1px solid var(--ag-border); margin: 16px 0; }
  :deep(img) { max-width: 100%; border-radius: 6px; }
}
.typing-cursor { display: inline-block; width: 8px; height: 15px; background: var(--ag-grad); margin-left: 2px; vertical-align: -2px; animation: blink 1s step-end infinite; border-radius: 1px; }
.msg-error { margin-top: 8px; display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 8px; background-color: rgba(207,34,46,0.08); border: 1px solid rgba(207,34,46,0.3); color: var(--color-red-6); font-size: 12.5px; }

// ------------------------------------------------------------------
// Input card
// ------------------------------------------------------------------
.input-wrap { padding: 6px 0 14px; flex-shrink: 0; }

// File reference tag (Ask Agent deep-link): shows the referenced file path,
// removable, never expands the file content into the prompt.
.ref-file-row { max-width: 840px; margin: 0 auto 8px; padding: 0 2px; }
.ref-file-tag { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 10px; border-radius: 8px; font-size: 12px; color: var(--ag-accent-2); background: var(--ag-grad-soft); border: 1px solid rgba(22,119,255,0.35); }
.ref-file-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 460px; font-family: ui-monospace, Consolas, monospace; }
.ref-file-close { flex-shrink: 0; font-size: 11px; cursor: pointer; opacity: 0.7; transition: opacity 0.15s;
  &:hover { opacity: 1; }
}

.input-card {
  max-width: 840px; margin: 0 auto; padding: 12px 14px 10px;
  border-radius: 14px;
  background-color: var(--background-color-white);
  border: 1px solid var(--ag-border);
  box-shadow: 0 10px 34px rgba(31,41,80,0.10), 0 2px 8px rgba(31,41,80,0.05);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
  position: relative;

  &.focused { border-color: rgba(22,119,255,0.35); box-shadow: 0 0 0 4px rgba(22,119,255,0.35), 0 12px 36px rgba(22,119,255,0.35); }

  .input-card-textarea {
    textarea { width: 100%; border: none; outline: none; resize: none; font: inherit; font-size: 14px; line-height: 1.65; padding: 2px 2px 8px; background: transparent; color: var(--text-color); max-height: 220px;
      &::placeholder { color: var(--color-gray-7); }
    }
  }

  .input-card-bottom { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; border-top: 1px solid var(--ag-border); padding-top: 9px;

    .input-left { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0;
      .ws-type, .ws-select { max-width: 220px; }
      .ws-type { width: 112px; }
      .ws-select { min-width: 170px; }
    }

    .input-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0;

      .model-select { width: 250px;
        :deep(.ant-select-selector) { border-radius: 9px !important; }
      }

      .perm-toggle { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--ag-border); background-color: var(--color-gray-2); color: var(--color-gray-7); font-size: 11.5px; cursor: pointer; transition: all 0.16s;
        .perm-label { font-weight: 600; }
        &.on { border-color: rgba(22,119,255,0.35); background-color: rgba(22,119,255,0.35); color: var(--ag-accent); }
        &:hover { border-color: var(--ag-accent); }
      }

      .send-btn { width: 36px; height: 36px; border-radius: 12px; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: #fff; background: var(--ag-grad); box-shadow: 0 4px 12px rgba(22,119,255,0.35); transition: transform 0.15s, box-shadow 0.15s, opacity 0.15s; font-size: 15px;
        &:hover:not(.disabled) { transform: translateY(-1px); box-shadow: 0 7px 18px rgba(22,119,255,0.35); }
        &:active:not(.disabled) { transform: translateY(0); }
        &.disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
      }
    }
  }

  .input-abort { text-align: center; font-size: 11px; color: var(--color-red-6); margin-top: 6px; cursor: pointer; }
}
.input-hint { max-width: 840px; margin: 7px auto 0; padding: 0 20px; font-size: 11px; color: var(--color-gray-7); text-align: center; display: flex; align-items: center; justify-content: center; gap: 4px;
  kbd { font-family: ui-monospace, Consolas, monospace; font-size: 10px; background-color: var(--color-gray-3); border: 1px solid var(--ag-border); border-radius: 4px; padding: 1px 5px; }
  .hint-sep { margin: 0 4px; }
}

// Drawer (global portal polish). The portal is OUTSIDE .agent-page, so the
// --ag-* variables must be re-defined here or gradient icons stay invisible.
// The app uses antd LIGHT tokens always, so the drawer text must be forced to
// the theme text color or it renders black-on-black in dark mode.
:global(.agent-drawer .ant-drawer-body) { color: var(--text-color); }
:global(.agent-drawer .ant-drawer-content) {
  --ag-accent: #1677ff;
  --ag-accent-2: #0958d9;
  --ag-grad: linear-gradient(135deg, #1677ff 0%, #4096ff 60%, #69b1ff 100%);
  --ag-grad-soft: linear-gradient(135deg, rgba(22,119,255,0.14), rgba(64,150,255,0.1));
  --ag-border: var(--card-border-color);
  border-radius: 16px 0 0 16px;
  box-shadow: -16px 0 40px rgba(31,41,80,0.14);
}
:global(.agent-drawer .ant-drawer-content-wrapper) { box-shadow: none; }
// ------------------------------------------------------------------
// Drawer
// ------------------------------------------------------------------
.drawer-inner { display: flex; flex-direction: column; min-height: 100%; }
.drawer-head { display: flex; align-items: center; gap: 12px; padding: 2px 2px 14px; border-bottom: 1px solid var(--ag-border);
  .drawer-head-icon { width: 38px; height: 38px; border-radius: 12px; display: flex; align-items: center; justify-content: center; color: #fff; background: var(--ag-grad); font-size: 17px; box-shadow: 0 4px 12px rgba(22,119,255,0.35); }
  .drawer-head-title { flex: 1; min-width: 0;
    .drawer-title { font-size: 15px; font-weight: 700; }
    .drawer-sub { font-size: 11px; color: var(--color-gray-7); }
  }
  .drawer-close { width: 30px; height: 30px; border-radius: 8px; border: none; background: transparent; color: var(--color-gray-7); cursor: pointer; font-size: 13px;
    &:hover { background-color: var(--color-gray-3); color: var(--text-color); }
  }
}
.drawer-tabs { display: flex; gap: 6px; padding: 14px 0 16px;
  .drawer-tab { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--ag-border); background-color: var(--color-gray-2); color: var(--color-gray-7); font-size: 12px; cursor: pointer; transition: all 0.16s;
    .tab-count { min-width: 16px; height: 16px; border-radius: 8px; background-color: var(--color-red-6); color: #fff; font-size: 10px; display: inline-flex; align-items: center; justify-content: center; padding: 0 4px; }
    &.active { border-color: rgba(22,119,255,0.35); background: var(--ag-grad-soft); color: var(--ag-accent); font-weight: 600; }
    &:hover:not(.active) { border-color: var(--ag-accent); color: var(--text-color); }
  }
}
.drawer-section { display: flex; flex-direction: column; gap: 10px; }
.fade-in { animation: fade-up 0.25s ease; }

// Ctx hero
.ctx-hero { display: flex; align-items: center; gap: 16px; padding: 16px; border-radius: 8px; border: 1px solid var(--ag-border); background: var(--ag-grad-soft);
  .ctx-hero-ring { width: 92px; height: 92px; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0;
    background: conic-gradient(var(--ag-accent) calc(var(--pct) * 1%), rgba(22,119,255,0.35) 0);
    position: relative;
    &::after { content: ""; position: absolute; inset: 7px; border-radius: 50%; background-color: var(--background-color-white); }
    .ctx-hero-num { position: relative; z-index: 1; display: flex; align-items: baseline;
      .num { font-size: 22px; font-weight: 800; color: var(--text-color); }
      .percent { font-size: 11px; color: var(--color-gray-7); }
    }
    .ctx-hero-label { position: relative; z-index: 1; font-size: 9.5px; color: var(--color-gray-7); }
  }
  .ctx-hero-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;
    .ctx-info-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px;
      .ctx-info-label { color: var(--color-gray-7); }
      .ctx-info-value { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 68%; color: var(--text-color); }
      .mono { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
    }
  }
}
.ctx-bar { padding: 12px 16px; border-radius: 8px; border: 1px solid var(--ag-border); background-color: var(--color-gray-2);
  .ctx-bar-track { height: 8px; border-radius: 4px; background-color: var(--color-gray-4); overflow: hidden;
    .ctx-bar-fill { height: 100%; border-radius: 4px; background: var(--ag-grad); transition: width 0.4s ease; }
  }
  .ctx-bar-footer { display: flex; justify-content: space-between; margin-top: 7px; font-size: 11px; color: var(--color-gray-7);
    small { opacity: 0.75; }
  }
}
.drawer-card { padding: 13px 14px; border-radius: 8px; border: 1px solid var(--ag-border); background-color: var(--background-color-white);
  .drawer-card-title { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 700; margin-bottom: 10px; color: var(--text-color);
    .anticon { color: var(--ag-accent-2); }
  }
  .usage-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
    .usage-item { display: flex; justify-content: space-between; align-items: center; padding: 7px 10px; border-radius: 8px; background-color: var(--color-gray-2); font-size: 11.5px;
      .usage-label { color: var(--color-gray-7); }
      .usage-value { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-color); }
      &.strong .usage-value { color: var(--ag-accent); }
    }
  }
  .usage-empty { font-size: 11px; color: var(--color-gray-7); margin-top: 8px; }
  .model-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow: auto;
    .model-list-item { position: relative; display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; font-size: 12px;
      &:hover { background-color: var(--color-gray-2); }
      &.active { border-color: rgba(22,119,255,0.35); background: var(--ag-grad-soft); }
      .model-list-provider { color: var(--color-gray-7); font-size: 11px; flex-shrink: 0; }
      .model-list-name { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .model-list-check { margin-left: auto; color: var(--ag-accent); font-size: 11px; }
    }
  }
}

// Approvals
.approval-item { padding: 12px; border-radius: 8px; background-color: var(--color-gray-2); border: 1px solid var(--ag-border); overflow: hidden; min-width: 0;
  &.live { border-color: rgba(22,119,255,0.35); background: var(--ag-grad-soft); }
  &.approved { opacity: 0.75; border-color: rgba(26,127,55,0.35); }
  &.rejected { opacity: 0.75; border-color: rgba(207,34,46,0.35); }
  .approval-head { display: flex; align-items: center; gap: 8px;
    .approval-icon { color: var(--ag-accent-2); font-size: 13px; }
    .approval-tool { font-weight: 700; font-size: 12.5px; color: var(--text-color); }
    .approval-badge { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; padding: 2px 8px; border-radius: 999px; background-color: var(--background-color-white); border: 1px solid var(--ag-border); color: var(--color-gray-7);
      &.pending { color: var(--color-orange-6); border-color: rgba(250,140,22,0.4); }
      &.approved { color: var(--color-green-6); }
      &.rejected { color: var(--color-red-6); }
    }
  }
  .approval-reason { font-size: 11.5px; color: var(--color-gray-7); margin-top: 3px; word-break: break-all; overflow-wrap: anywhere; }
  .approval-pattern {
    font-size: 10.5px; color: var(--color-gray-7); margin-top: 3px;
    word-break: break-all; overflow-wrap: anywhere;
    max-height: 54px; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  }
  .mono { font-family: ui-monospace, Consolas, monospace; }
  .approval-args { font-size: 10.5px; line-height: 1.5; max-height: 110px; overflow: auto; background-color: var(--color-gray-1); border-radius: 8px; border: 1px solid var(--ag-border); padding: 8px; margin: 8px 0; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, Consolas, monospace; color: var(--text-color); }
  .approval-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .always-btn {
    color: var(--ag-accent-2);
    border-color: var(--ag-accent-2);
    background: transparent;
    &:hover, &:focus {
      color: #fff !important;
      background: var(--ag-accent-2) !important;
      border-color: var(--ag-accent-2) !important;
    }
  }
}
.empty-well { color: var(--color-gray-7); font-size: 12.5px; text-align: center; padding: 26px 10px; border: 1px dashed var(--ag-border); border-radius: 8px; }
.clear-btn { border-radius: 8px; }

// Snapshots
.snapshot-item { padding: 12px; border-radius: 8px; background-color: var(--color-gray-2); border: 1px solid var(--ag-border);
  .snapshot-head { display: flex; align-items: center; gap: 8px;
    .snapshot-icon { color: var(--ag-accent); font-size: 13px; }
    .snapshot-file { font-size: 12.5px; font-weight: 600; word-break: break-all; color: var(--text-color); }
  }
  .snapshot-meta { display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: var(--color-gray-7); margin-top: 4px; flex-wrap: wrap;
    .snapshot-rolled { color: var(--color-green-6); display: inline-flex; align-items: center; gap: 3px; font-weight: 600; }
    .snapshot-time { margin-left: auto; }
  }
  .snapshot-actions { display: flex; gap: 8px; margin-top: 8px; }
}

// Provider form
.provider-form { display: flex; flex-direction: column; gap: 6px;
  label { font-size: 12px; color: var(--color-gray-7); margin-top: 8px; }
  .models-tags { width: 100%; }
  .models-hint { font-size: 11px; color: var(--color-gray-7); line-height: 1.5; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .form-row { display: flex; align-items: center; gap: 10px; margin-top: 10px;
    .form-label { font-size: 12px; color: var(--color-gray-7); }
  }
  .provider-list { margin-top: 10px;
    .provider-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-radius: 8px; background-color: var(--color-gray-2); margin-bottom: 6px;
      .provider-item-info { min-width: 0;
        .provider-item-name { font-size: 12.5px; font-weight: 600; display: block; }
        .provider-item-models { font-size: 10.5px; color: var(--color-gray-7); font-family: ui-monospace, Consolas, monospace; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
      }
      .provider-item-actions { display: flex; align-items: center; gap: 2px; }
    }
  }
  .form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
}
.diff-file { font-weight: 700; font-size: 14px; word-break: break-all; }
.diff-meta { font-size: 11px; color: var(--color-gray-7); margin: 8px 0; }
.diff-content { font-size: 11px; line-height: 1.55; background-color: var(--color-gray-2); padding: 12px; border-radius: 8px; max-height: 70vh; overflow: auto; white-space: pre-wrap; border: 1px solid var(--ag-border); }
.empty-hint { color: var(--color-gray-7); font-size: 12px; text-align: center; padding: 18px 8px; }

// Animations
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
@keyframes dot-bounce { 0%, 100% { transform: translateY(0); opacity: 0.5; } 50% { transform: translateY(-3px); opacity: 1; } }
@keyframes bot-pulse { 0%, 100% { box-shadow: 0 4px 10px rgba(22,119,255,0.35); } 50% { box-shadow: 0 4px 18px rgba(22,119,255,0.35); } }
@keyframes welcome-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
@keyframes fade-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

:global(.app-layout-sidebar-only) .agent-page {
  height: calc(100svh - 93px);
  margin: 10px 16px 16px;
}

// Responsive
@media (max-width: 768px) {
  .sidebar { position: fixed; top: 0; bottom: 0; left: 0; width: 280px; z-index: 120; transform: translateX(-100%); transition: transform 0.22s ease; box-shadow: 0 0 24px rgba(0,0,0,0.14);
    &.open { transform: translateX(0); }
  }
  .sidebar-mask { display: block; position: fixed; inset: 0; background: rgba(31,35,40,0.4); z-index: 110; opacity: 0; pointer-events: none; transition: opacity 0.22s;
    &.show { opacity: 1; pointer-events: auto; }
  }
  .topbar-menu-btn { display: inline-flex; }
  .conv-item-del { opacity: 1; }
}
@media (max-width: 640px) {
  .agent-page { height: calc(100svh - 124px); margin: 0 10px 8px; }
  .topbar { flex-wrap: wrap; height: auto; padding: 8px 12px 10px; row-gap: 6px; }
  .topbar-center { order: 3; flex-basis: 100%; justify-content: flex-start; overflow-x: auto; }
  .messages { padding: 12px 0 4px; }
  .messages-inner, .input-inner { padding: 0 12px; }
  .msg { gap: 8px; padding: 10px 0; }
  .welcome { margin: 30px auto 18px; }
  .input-card { margin: 0 10px; padding: 10px 10px 8px; }
  .input-card-bottom { flex-direction: column; align-items: stretch; }
  .input-left { width: 100%; }
  .input-right { width: 100%; justify-content: flex-end; }
  .model-select { flex: 1; width: auto !important; }
  .input-hint { padding: 0 12px; }
}
</style>

