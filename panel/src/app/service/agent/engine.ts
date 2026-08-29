import axios from "axios";
import configStore, { modelList } from "./config_store";
import { findTool, toolDefinitions, type ToolContext } from "./tools";
import { buildSystemPrompt, buildWorkspaceContext, stripModeTag } from "./prompt";
import ApprovalStore from "./approvals";
import { evaluatePermission, type PermissionRule } from "./permission";
import SessionStore from "./sessions";
import type { AgentRunConfig, ChatMessage, EmitFn, ToolCall, AgentUsage } from "./types";

/**
 * Agent engine: the tool-calling loop.
 *
 * It talks to an OpenAI-compatible chat completions endpoint over a *stream*
 * (SSE), forwards reasoning / content / tool-call deltas through the emit
 * callback as they arrive, creates approval requests for sensitive tools, and
 * persists messages to the session. Aborts are honoured at any point via the
 * AbortController.
 */

const MAX_STEPS = 40;
const MAX_OUTPUT = 20000;
/** Longest a single provider stream may run before being killed. */
const STREAM_TIMEOUT = 300000;


/** Read a provider error body even when it is a stream (responseType: stream). */
async function readErrorBody(data: any): Promise<string> {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data.slice(0, 500);
  if (Buffer.isBuffer(data)) return data.toString("utf-8").slice(0, 500);
  if (typeof data === "object" && typeof data.on === "function" && typeof data[Symbol.asyncIterator] === "function") {
    try {
      let text = "";
      for await (const chunk of data as AsyncIterable<Buffer | string>) {
        text += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
        if (text.length > 1000) break;
      }
      return text.slice(0, 500);
    } catch {
      return "(unreadable error stream)";
    }
  }
  try {
    return JSON.stringify(data).slice(0, 500);
  } catch {
    return String(data).slice(0, 500);
  }
}

export class AgentAbortError extends Error {
  constructor() {
    super("Agent run aborted by user");
    this.name = "AgentAbortError";
  }
}

/** Per-step accumulator of an in-flight provider stream. */
interface StepStream {
  reasoning: string;
  content: string;
  toolCalls: Array<{ index: number; id: string; name: string; arguments: string }>;
  usage?: AgentUsage;
}

function emitUsage(emit: EmitFn, usage: AgentUsage | undefined) {
  if (!usage) return;
  const total = usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  emit("usage", { ...usage, total_tokens: total });
}

/**
 * Parse one OpenAI-style chunk and fold it into the step accumulator.
 * Returns true when the chunk marked the end of the stream.
 */
function consumeChunk(
  step: StepStream,
  chunk: any,
  emit: EmitFn
): boolean {
  if (chunk === null || typeof chunk !== "object") return false;
  // usage arrives either as a standalone top-level field (include_usage) or nested
  if (chunk.usage) {
    const u = chunk.usage;
    const merged: any = { ...(step.usage || {}), ...u };
    // Some providers nest reasoning tokens under completion_tokens_details
    if (u.completion_tokens_details?.reasoning_tokens != null && merged.reasoning_tokens == null) {
      merged.reasoning_tokens = u.completion_tokens_details.reasoning_tokens;
    }
    step.usage = merged;
  }
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  if (!choice) return false;
  const delta = choice.delta || {};
  if (!delta || typeof delta !== "object") return false;

  // Reasoning deltas: different providers use different field names.
  const reasoningDelta =
    delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text ?? delta.thinking ?? delta.chain_of_thought ?? "";
  if (typeof reasoningDelta === "string" && reasoningDelta) {
    step.reasoning += reasoningDelta;
    emit("reasoning", { delta: reasoningDelta, index: 0 });
  }

  if (typeof delta.content === "string" && delta.content) {
    step.content += delta.content;
    emit("message", { content: delta.content, delta: true, index: 0 });
  }

  // Tool-call deltas (OpenAI compatible): array of {index, id?, function?{name?,arguments?}}
  const deltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const tc of deltas) {
    if (!tc || typeof tc !== "object") continue;
    const index = typeof tc.index === "number" ? tc.index : 0;
    const current = step.toolCalls[index] || { index, id: "", name: "", arguments: "" };
    if (!step.toolCalls[index]) step.toolCalls[index] = current;
    let changed = false;
    if (typeof tc.id === "string" && tc.id) {
      current.id = tc.id;
      changed = true;
    }
    const fn = tc.function || {};
    if (fn && typeof fn === "object") {
      if (typeof fn.name === "string" && fn.name) {
        // Some providers repeat the name in every delta - replace, never concat.
        if (current.name !== fn.name) {
          current.name = fn.name;
          changed = true;
          if (!step.toolCalls[index]!.id) step.toolCalls[index]!.id = "call_" + index;
          emit("tool_start", { index, id: step.toolCalls[index]!.id, name: fn.name });
        }
      }
      if (typeof fn.arguments === "string" && fn.arguments) {
        current.arguments += fn.arguments;
        changed = true;
        emit("tool_args", { index, delta: fn.arguments });
      }
    }
    void changed;
  }

  // Some providers send a finish_reason that may be useful later.
  void choice.finish_reason;
  return false;
}

export class AgentEngine {
  /**
   * Run one agent turn. Returns the final assistant message.
   * - config.sessionId: resume an existing session, otherwise a new one is created.
   * - emit(event, data): streamed events: session, step, reasoning, message,
   *   tool_start, tool_args, tool, approval, usage, error, done.
   */
  async run(config: AgentRunConfig, emit: EmitFn, signal?: AbortSignal): Promise<string> {
    const provider = configStore.getSecret(config.providerId);
    if (!provider) throw new Error("Model provider not found");
    if (!provider.endpoint) throw new Error("Provider endpoint not configured");

    const mode = config.mode || "normal";
    let session =
      config.sessionId && SessionStore.get(config.sessionId) ? SessionStore.get(config.sessionId)! : null;

    if (!session) {
      session = SessionStore.create({
        workspace: config.workspace,
        daemonId: config.daemonId,
        instanceUuid: config.instanceUuid,
        providerId: config.providerId,
        modelOverride: config.model,
        mode
      });
      emit("session", { id: session.id });
    } else {
      session = SessionStore.update(session.id, {
        workspace: config.workspace,
        daemonId: config.daemonId || session.daemonId,
        instanceUuid: config.instanceUuid || session.instanceUuid,
        mode,
        // approved is PER RUN - the auto-approve switch must apply to exactly
        // this run and never stick to the session (it used to accumulate).
        approved: config.approved === true,
        modelOverride: config.model || session.modelOverride
      });
    }

    // Resolve the actual model: explicit selection first, else provider default.
    const available = modelList(provider);
    const model = config.model && available.includes(config.model) ? config.model : provider.model || available[0];
    if (!model) throw new Error("Provider has no model configured");

    const url = provider.endpoint.replace(/\/+$/, "") + "/chat/completions";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(provider.headers || {})
    };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

    // Build the message list for this turn.
    const systemPrompt = buildSystemPrompt(mode);
    const userContent = stripModeTag(config.prompt) + buildWorkspaceContext(config.workspace);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt, timestamp: new Date().toISOString() },
      ...session.messages.map((m) => ({ ...m })),
      { role: "user", content: userContent, timestamp: new Date().toISOString() }
    ];
    // Persist the *clean* user prompt (no workspace context block) so the session
    // history and titles stay readable; the context is regenerated per request.
    SessionStore.appendMessage(session.id, {
      role: "user",
      content: stripModeTag(config.prompt),
      timestamp: new Date().toISOString()
    });

    const toolCtx: ToolContext = {
      session,
      approved: config.approved === true,
      approvals: new Map(),
      rules: [...(session.approvedRules || [])],
      search: {
        endpoint: provider.searchEndpoint || "",
        apiKey: provider.searchApiKey || ""
      },
      emit
    };

    let steps = 0;
    let finalText = "";
    let lastUsage: AgentUsage | undefined;
    try {
      for (steps = 0; steps < MAX_STEPS; steps++) {
        if (signal?.aborted) throw new AgentAbortError();
        emit("step", { step: steps, total: MAX_STEPS });

        const payload: Record<string, any> = {
          model,
          messages: messages.map(({ role, content, tool_calls, tool_call_id, name }) => {
            const m: Record<string, any> = { role };
            if (content !== undefined) m.content = content;
            // NOTE: stored reasoning is deliberately not sent back - most APIs reject it.
            if (tool_calls) m.tool_calls = tool_calls;
            if (tool_call_id) m.tool_call_id = tool_call_id;
            if (name) m.name = name;
            return m;
          }),
          tools: toolDefinitions(),
          tool_choice: "auto",
          max_tokens: provider.maxToken || 4096,
          stream: true,
          stream_options: { include_usage: true }
        };
        if (provider.reasoning) {
          // Some providers (e.g. DeepSeek reasoner) accept a reasoning effort field
          payload.reasoning_effort = provider.reasoningMode || "medium";
        }

        // 1) Stream the provider reply.
        const step: StepStream = { reasoning: "", content: "", toolCalls: [] };
        try {
          const res = await axios.post(url, payload, {
            headers,
            timeout: STREAM_TIMEOUT,
            maxContentLength: Infinity,
            responseType: "stream",
            signal: signal as any
          });

          const stream = res.data as AsyncIterable<Buffer | string>;
          let buffer = "";
          for await (const raw of stream) {
            if (signal?.aborted) throw new AgentAbortError();
            buffer += Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              if (!block.trim()) continue;
              let dataStr = "";
              for (const line of block.split("\n")) {
                const l = line.trim();
                if (l.startsWith("data:")) {
                  dataStr += l.slice(5).trim() + "\n";
                }
              }
              dataStr = dataStr.replace(/\n$/, "");
              if (!dataStr || dataStr === "[DONE]") continue;
              let chunk: any;
              try {
                chunk = JSON.parse(dataStr);
              } catch {
                continue; // ignore malformed keep-alive frames
              }
              consumeChunk(step, chunk, emit);
            }
          }
          // Any trailing buffered payload without the standard separator.
          const rest = buffer.trim();
          if (rest.startsWith("data:")) {
            const d = rest.slice(5).trim();
            if (d && d !== "[DONE]") {
              try {
                consumeChunk(step, JSON.parse(d), emit);
              } catch {
                /* ignore */
              }
            }
          }
        } catch (err: any) {
          if (signal?.aborted) throw new AgentAbortError();
          if (err?.response) {
            // response is a STREAM (responseType stream) - never JSON.stringify it
            const raw = await readErrorBody(err.response.data);
            const inner = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            const detail = inner && inner[1] ? inner[1].replace(/\\n/g, " ") : raw || "";
            throw new Error(`Provider error ${err.response.status}: ${detail.slice(0, 400)}`);
          }
          if (err?.code === "ETIMEDOUT" || err?.code === "ECONNABORTED") {
            throw new Error(`Provider response timed out after ${STREAM_TIMEOUT / 1000}s`);
          }
          throw new Error(`Cannot reach provider: ${err.message}`);
        }

        const content = step.content;
        const calls: ToolCall[] = step.toolCalls
          .filter((c) => c && (c.name || c.arguments))
          .map((c) => ({
            id: c.id || `call_${c.index}`,
            type: "function",
            function: { name: c.name, arguments: c.arguments || "{}" }
          }));

        if (step.usage) lastUsage = step.usage;
        emitUsage(emit, step.usage);
        if (step.reasoning) emit("reasoning_done", { length: step.reasoning.length });

        // Persist the assistant message (content + reasoning + tool_calls).
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: content || "",
          timestamp: new Date().toISOString()
        };
        if (step.reasoning) assistantMsg.reasoning = step.reasoning;
        if (calls.length) assistantMsg.tool_calls = calls;
        SessionStore.appendMessage(session.id, assistantMsg);

        if (content) {
          finalText = content;
          emit("message_done", { length: content.length });
        } else {
          emit("message_done", { length: 0 });
        }

        if (!calls.length) {
          return content || "(empty response)";
        }

        // Critical ordering: the assistant message (with tool_calls) MUST be
        // echoed into the request array BEFORE the tool results, otherwise the
        // provider rejects the conversation with a 400 (tool response precedes
        // the tool call). The session file already stores it correctly; the
        // local array was wrong and could break every multi-step run.
        messages.push(assistantMsg);

        // Execute tool calls sequentially (they may need approvals).
        for (let ci = 0; ci < calls.length; ci++) {
          if (signal?.aborted) throw new AgentAbortError();
          const call = calls[ci];
          const toolName = call.function?.name || "";
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(call.function?.arguments || "{}");
          } catch {
            args = {};
          }
          const tool = findTool(toolName);
          if (!tool) {
            SessionStore.appendMessage(session.id, {
              role: "tool",
              tool_call_id: call.id,
              name: toolName,
              content: `ERROR: unknown tool ${toolName}`,
              timestamp: new Date().toISOString()
            });
            emit("tool", { index: ci, id: call.id, name: toolName, args, result: `ERROR: unknown tool ${toolName}`, status: "error", durationMs: 0 });
            continue;
          }

          emit("tool_start", { index: ci, id: call.id, name: toolName });

          // opencode-style permission resolution: tools map to a permission key
          // and a resource pattern; session "always allow" rules are checked
          // first, then ask. Approvals support once / always / reject.
          if (tool.permission && !toolCtx.approved) {
            const pattern = tool.patternFor ? tool.patternFor(args, toolCtx) : toolName;
            const needs =
              typeof tool.approvalNeeded === "function"
                ? tool.approvalNeeded(args, toolCtx)
                : tool.approvalNeeded !== false;
            const rule = evaluatePermission(toolCtx.rules, tool.permission, pattern);
            if (
              needs &&
              rule === "ask" &&
              ![...toolCtx.approvals.values()].some(
                (r) => r.tool === toolName && r.permission === tool.permission && r.pattern === pattern && r.status === "approved"
              )
            ) {
              // Create an approval request and wait for the user.
              const approval = ApprovalStore.create({
                sessionId: session.id,
                tool: toolName,
                args,
                permission: tool.permission,
                pattern,
                reason: `${toolName} requested by Agent`
              });
              emit("approval", { id: approval.id, tool: toolName, args, reason: approval.reason, permission: tool.permission, pattern });
              emit("tool_pending", { index: ci, id: call.id, name: toolName, approvalId: approval.id });
              const decision = await this.waitForApproval(approval.id, signal);
              toolCtx.approvals.set(approval.id, { ...decision, permission: tool.permission, pattern });
              if (decision.status === "rejected") {
                const toolResult = `ERROR: ${toolName} was rejected (${decision.reason || "no reason"})`;
                SessionStore.appendMessage(session.id, {
                  role: "tool",
                  tool_call_id: call.id,
                  name: toolName,
                  content: toolResult,
                  timestamp: new Date().toISOString()
                });
                emit("tool", { index: ci, id: call.id, name: toolName, args, result: toolResult, status: "error", durationMs: 0 });
                continue;
              }
              if (decision.always) {
                const ruleEntry: PermissionRule = { permission: tool.permission, pattern, action: "allow" };
                toolCtx.rules.push(ruleEntry);
                const savedRules = [...(session.approvedRules || []), ruleEntry];
                session.approvedRules = savedRules;
                try {
                  SessionStore.update(session.id, { approvedRules: savedRules });
                } catch {
                  /* best effort */
                }
              }
            }
          }

          // Execute.
          const started = Date.now();
          let result = "";
          let status: "ok" | "error" = "ok";
          try {
            result = await tool.impl(args, toolCtx);
          } catch (err: any) {
            result = `ERROR: ${err.message}`;
            status = "error";
          }
          const durationMs = Date.now() - started;
          emit("tool", { index: ci, id: call.id, name: toolName, args, result: result.slice(0, MAX_OUTPUT), status, durationMs });
          SessionStore.appendMessage(session.id, {
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: result.slice(0, MAX_OUTPUT),
            timestamp: new Date().toISOString()
          });
          // feed the tool result back into the conversation
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: result.slice(0, MAX_OUTPUT),
            timestamp: new Date().toISOString()
          });
        }
      }
      if (lastUsage) emitUsage(emit, lastUsage);
      if (steps >= MAX_STEPS) {
        const notice =
          "\n\n> ⚠️ " +
          "已达最大工具调用步数 (" + MAX_STEPS + ")，任务可能尚未完成。可以继续发送消息让 Agent 继续。";
        emit("message", { content: notice, delta: false });
        return finalText ? finalText + notice : notice;
      }
      return finalText || "(empty response)";
    } finally {
      emit("done", { steps });
      // Persist the last turn usage so switching back to this session in the UI
      // can still show real token numbers instead of a placeholder.
      if (session && lastUsage) {
        try {
          SessionStore.update(session.id, { lastUsage });
        } catch {
          /* best effort */
        }
      }
    }
  }

  private waitForApproval(
    approvalId: string,
    signal?: AbortSignal
  ): Promise<{ tool: string; args: Record<string, any>; status: "approved" | "rejected"; reason?: string; always?: boolean }> {
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (signal?.aborted) {
          clearInterval(timer);
          reject(new AgentAbortError());
          return;
        }
        const req = ApprovalStore.get(approvalId);
        if (!req) {
          clearInterval(timer);
          reject(new Error("Approval record disappeared"));
          return;
        }
        if (req.status === "approved" || req.status === "rejected") {
          clearInterval(timer);
          resolve({
            tool: req.tool,
            args: req.args,
            status: req.status as "approved" | "rejected",
            reason: req.status === "rejected" ? "rejected by user" : undefined,
            always: req.status === "approved" ? Boolean(req.always) : false
          });
        } else if (req.status === "expired") {
          clearInterval(timer);
          reject(new Error("Approval expired"));
        }
      };
      const timer = setInterval(poll, 1200);
      timer.unref?.();
      poll();
    });
  }
}

export default new AgentEngine();
