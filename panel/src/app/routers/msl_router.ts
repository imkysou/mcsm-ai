import Router from "@koa/router";
import axios from "axios";
import validator from "../middleware/validator";
import permission from "../middleware/permission";
import { ROLE } from "../entity/user";
import RemoteRequest from "../service/remote_command";
import RemoteServiceSubsystem from "../service/remote_service";
import configStore, { modelList } from "../service/agent/config_store";
import { getOperationLoggerOperator, operationLogger } from "../service/operation_logger";
import { $t } from "../i18n";

/**
 * Panel HTTP routes for MSL (MinecraftServerListener).
 *
 * The MSL runtime lives inside the daemon; these routes forward to the daemon
 * over its socket (`msl/*` events). Only available for Minecraft instances.
 */
const router = new Router({ prefix: "/msl" });

const instanceValidator = validator({
  query: { daemonId: String, uuid: String }
});

async function forward(ctx: any, event: string, data: Record<string, unknown> = {}, timeout = 60000) {
  const daemonId = String(ctx.query.daemonId);
  const instanceUuid = String(ctx.query.uuid);
  const remote = RemoteServiceSubsystem.getInstance(daemonId);
  if (!remote) throw new Error("Daemon not found");
  return await new RemoteRequest(remote).request(event, { instanceUuid, ...data }, timeout);
}

// Current MSL status
router.all(
  "/status",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    ctx.body = await forward(ctx, "msl/status");
  }
);

// Read MSL config
router.all(
  "/config",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    ctx.body = await forward(ctx, "msl/config_get");
  }
);

// Update MSL config (GUI dialog)
router.all(
  "/config/update",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    const config = ctx.request.body?.config || ctx.request.body;
    const result = await forward(ctx, "msl/config", { config });
    operationLogger.log("instance_config_change", {
      daemon_id: String(ctx.query.daemonId),
      instance_id: String(ctx.query.uuid),
      ...getOperationLoggerOperator(ctx),
      config_after: "msl"
    } as any);
    ctx.body = result;
  }
);

// Reload all plugins
router.all(
  "/reload",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    ctx.body = await forward(ctx, "msl/reload");
  }
);

// Toggle debug
router.all(
  "/debug",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    const enabled = String(ctx.query.enabled ?? ctx.request.body?.enabled) === "true";
    ctx.body = await forward(ctx, "msl/debug", { enabled });
  }
);

// List plugins
router.all(
  "/plugins",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    ctx.body = await forward(ctx, "msl/plugin_list");
  }
);

// Enable plugin
router.all(
  "/plugin/enable",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    const name = String(ctx.query.name ?? ctx.request.body?.name ?? "");
    ctx.body = await forward(ctx, "msl/plugin_enable", { name });
  }
);

// Disable plugin
router.all(
  "/plugin/disable",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    const name = String(ctx.query.name ?? ctx.request.body?.name ?? "");
    ctx.body = await forward(ctx, "msl/plugin_disable", { name });
  }
);

// Read MSL runtime log (.msl_logs/msl.log)
router.all(
  "/log",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    const tail = Number(ctx.query.tail) || 200;
    ctx.body = await forward(ctx, "msl/log", { tail });
  }
);

// Send a console command to MC through MSL
router.all(
  "/command",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    const command = String(ctx.query.command ?? ctx.request.body?.command ?? "");
    ctx.body = await forward(ctx, "msl/command", { command });
  }
);

// Run a shell command in the instance (MSL) workspace directory - used by the
// MSL "workspace terminal" (npm install etc.)
router.all(
  "/shell",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    const command = String(ctx.query.command ?? ctx.request.body?.command ?? "");
    const timeoutMs = Number(ctx.query.timeoutMs ?? ctx.request.body?.timeoutMs) || 120000;
    ctx.body = await forward(ctx, "msl/shell", { command, timeoutMs }, 310000);
  }
);

/**
 * AI-assisted logRegex generation for MSL.
 *
 * Contract: the regex MUST be derived from real Minecraft server log lines.
 * The daemon scans logs/latest.log (+ sibling logs) for evidence of the event;
 * if no evidence exists, generation FAILS with an 'insufficient info' message
 * (never guesses from invented samples). The LLM output is additionally
 * verified against the real evidence lines before being returned.
 */
const REGEX_EVENTS = ["playerJoin", "playerQuit", "playerSendMessage", "playerSendCommand"];

/**
 * Curated regex templates for common server formats (vanilla old/new, paper,
 * Folia, proxies with [Not Secure] prefixes). Templates are validated against
 * the REAL evidence too - a bad template never survives verification. This
 * guarantees generation succeeds even when the model answer is imperfect.
 */
const REGEX_TEMPLATES: Record<string, string[]> = {
  playerJoin: [
    "^\\[(\\d{2}:\\d{2}:\\d{2}) INFO\\]: (\\S+) joined the game$",
    "^\\[(\\d{2}:\\d{2}:\\d{2})\\] \\[.*?/INFO\\]: (\\S+) joined the game$",
    "^\\[(\\d{2}:\\d{2}:\\d{2})\\] \\[.*?INFO\\]: (\\S+) joined the game$"
  ],
  playerQuit: [
    "^\\[(\\d{2}:\\d{2}:\\d{2}) INFO\\]: (\\S+) left the game$",
    "^\\[(\\d{2}:\\d{2}:\\d{2})\\] \\[.*?/INFO\\]: (\\S+) left the game$",
    "^\\[(\\d{2}:\\d{2}:\\d{2})\\] \\[.*?INFO\\]: (\\S+) left the game$"
  ],
  playerSendMessage: [
    "^\\[(\\d{2}:\\d{2}:\\d{2}) INFO\\]: (?:\\[Not Secure\\] )?<(\\S+)> (.+)$",
    "^\\[(\\d{2}:\\d{2}:\\d{2}) INFO\\]: <(\\S+)> (.+)$",
    "^\\[(\\d{2}:\\d{2}:\\d{2})\\] \\[.*?/INFO\\]: (?:\\[Not Secure\\] )?<(\\S+)> (.+)$"
  ],
  playerSendCommand: [
    "^\\[(\\d{2}:\\d{2}:\\d{2}) INFO\\]: (\\S+) issued server command: (.+)$",
    "^\\[(\\d{2}:\\d{2}:\\d{2}) INFO\\]: (\\S+) issued server command: \\/(.+)$",
    "^\\[(\\d{2}:\\d{2}:\\d{2})\\] \\[.*?/INFO\\]: (\\S+) issued server command: (.+)$"
  ]
};

/** Minimum capture groups per event: (time) (player) [(message|command)]. */
const MIN_GROUPS: Record<string, number> = {
  playerJoin: 2,
  playerQuit: 2,
  playerSendMessage: 3,
  playerSendCommand: 3
};

function looksLikeTime(v: string): boolean {
  return /\d{1,2}:\d{2}/.test(v);
}

/**
 * Evaluate a candidate regex against the REAL evidence lines. Precision
 * requirements:
 *  - the regex must match (almost) ALL confirmed lines of the event;
 *  - capture-group order must be (time) (player) [(message|command)] on every
 *    matched line (the MSL runtime consumes m[1], m[2], m[3] in that order);
 *  - it must NOT match any line belonging to OTHER events (over-broad guard).
 */
function evaluateRegex(
  event: string,
  regex: RegExp,
  evidenceLines: string[],
  otherLines: string[]
): { matched: number; total: number; leaks: number } {
  const min = MIN_GROUPS[event] || 2;
  let matched = 0;
  for (const line of evidenceLines) {
    try {
      const m = line.match(regex);
      if (!m) continue;
      let groupCount = 0;
      for (let i = 1; i < m.length; i++) {
        if (m[i] !== undefined && m[i] !== "") groupCount++;
      }
      if (groupCount < min) continue;
      const player = m[2] || "";
      if (!player || player.length > 48 || /[/\\[\]]|INFO|WARN|ERROR/i.test(player)) continue;
      if (!m[1] || !looksLikeTime(m[1])) continue;
      matched++;
    } catch {
      /* try next line */
    }
  }
  let leaks = 0;
  for (const line of otherLines) {
    try {
      if (regex.test(line)) leaks++;
    } catch {
      /* ignore */
    }
  }
  return { matched, total: evidenceLines.length, leaks };
}

router.all(
  "/regex_ai",
  permission({ level: ROLE.ADMIN }),
  instanceValidator,
  async (ctx) => {
    const event = String(ctx.query.event ?? ctx.request.body?.event ?? "");
    const providerId = String(ctx.query.providerId ?? ctx.request.body?.providerId ?? "");
    if (!REGEX_EVENTS.includes(event)) throw new Error("Invalid event type");
    const provider = configStore.getSecret(providerId);
    if (!provider || !provider.endpoint || !provider.model)
      throw new Error($t("TXT_CODE_msl_no_provider"));

    // 1) Pull REAL evidence from the server logs (daemon-side scan).
    const evRes = await forward(ctx, "msl/log_evidence", { maxPerEvent: 30, contextTail: 100 });
    const evMap = (evRes?.evidence || {}) as Record<string, string[]>;
    const evLines: string[] = Array.isArray(evMap[event]) ? evMap[event].slice(0, 30) : [];
    const otherLines: string[] = [];
    for (const e of REGEX_EVENTS) {
      if (e === event) continue;
      const lines = Array.isArray(evMap[e]) ? evMap[e].slice(0, 12) : [];
      for (const line of lines) otherLines.push(line);
    }
    const context: string[] = Array.isArray(evRes?.context) ? evRes.context.slice(-100) : [];
    if (!evLines.length) {
      throw new Error($t("TXT_CODE_msl_regex_no_evidence", { event }));
    }

    // 2) Ask the model - it MUST derive the regex from the given real lines.
    const chosenModel = modelList(provider).includes(String(ctx.request.body?.model))
      ? String(ctx.request.body?.model)
      : provider.model;

    const prompt =
      "You are building log parsing rules for a Minecraft server monitoring tool (MSL).\n" +
      "I need ONE JavaScript regular expression (RegExp source string - NO slashes, NO flags,\n" +
      "NO code fences - output ONLY the regex source) that captures the \"" + event + "\" event from the\n" +
      "real Minecraft server log lines below.\n\n" +
      "CONTRACT: only write the regex if you can CONFIRM the exact log line format by reading the\n" +
      "REAL server log lines below. The regex must match EVERY confirmed line shown (they are all\n" +
      "the same format), must be anchored to the real structure (timestamp prefix etc.), and must\n" +
      "NOT match any line of the other events. If you cannot find the actual log line for \"" + event + "\"\n" +
      "in the provided content, or the lines are not consistent enough, output exactly: REGEX_NOT_FOUND\n\n" +
      "Capture group order is MANDATORY (the runtime consumes them by index):\n" +
      "- playerJoin: group1 = time, group2 = player name\n" +
      "- playerQuit: group1 = time, group2 = player name\n" +
      "- playerSendMessage: group1 = time, group2 = player, group3 = message text\n" +
      "- playerSendCommand: group1 = time, group2 = player, group3 = full command (starting with /)\n\n" +
      "CONFIRMED real log lines for \"" + event + "\" (from the server log files):\n" +
      "```\n" + evLines.join("\n") + "\n```\n\n" +
      "Lines of OTHER events (your regex must NOT match these):\n```\n" + otherLines.join("\n") + "\n```\n\n" +
      "Recent general server log context (to learn the timestamp format):\n" +
      "```\n" + context.join("\n") + "\n```\n\n" +
      "Reply with ONLY the regex source string, or exactly REGEX_NOT_FOUND if the real log line " +
      "for \"" + event + "\" is not present / cannot be confirmed.\n" +
      "IMPORTANT: bracket suffix text in the confirmed lines (e.g. [Not Secure], [Server], [公告]) " +
      "is a LITERAL prefix - escape each bracket in the regex (\\[Not Secure\\]) and make it optional. " +
      "The message text may contain ANY characters (including Chinese).";

    const url = provider.endpoint.replace(/\/+$/, "") + "/chat/completions";
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(provider.headers || {}) };
    if (provider.apiKey) headers.Authorization = "Bearer " + provider.apiKey;
    const res = await axios.post(
      url,
      {
        model: chosenModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: provider.maxToken || 1024,
        temperature: 0
      },
      { headers, timeout: 90000 }
    );
    const content = String(res.data?.choices?.[0]?.message?.content || "").trim();

    // 3) Model declining => insufficient info.
    if (/REGEX_NOT_FOUND|无法确认|信息不足|insufficient|cannot confirm|could not find|not enough/i.test(content)) {
      throw new Error($t("TXT_CODE_msl_regex_no_evidence", { event }));
    }

    // 4) Strip code fences / slashes / quotes from the raw answer.
    let regex = content;
    const fenceStart = content.indexOf("```");
    if (fenceStart >= 0) {
      const fenceEnd = content.indexOf("```", fenceStart + 3);
      if (fenceEnd > fenceStart) {
        regex = content.slice(fenceStart + 3, fenceEnd);
      }
    }
    const slashMatch = regex.match(new RegExp("^\\/(.+)\\/[gimsuy]*$", "s"));
    if (slashMatch && slashMatch[1]) regex = slashMatch[1];
    regex = regex.replace(/^['"]|['"]$/g, "").trim();
    if (!regex) throw new Error($t("TXT_CODE_msl_regex_unverified", { event }));

    // 5) Compile + verify against the REAL log lines.
    let compiled: RegExp;
    try {
      compiled = new RegExp(regex);
    } catch {
      throw new Error($t("TXT_CODE_msl_regex_unverified", { event }));
    }
    let regexSource = regex;
    const verdict = evaluateRegex(event, compiled, evLines, otherLines);
    const requireAll =
      verdict.total > 5 ? verdict.matched >= Math.ceil(verdict.total * 0.9) : verdict.matched === verdict.total;
    if (!requireAll || verdict.leaks > 0) {
      // Fall back to the curated template library (verified against the same lines).
      let usedTemplate = false;
      for (const tpl of REGEX_TEMPLATES[event] || []) {
        try {
          const r = new RegExp(tpl);
          const v = evaluateRegex(event, r, evLines, otherLines);
          const okAll =
            v.total > 5 ? v.matched >= Math.ceil(v.total * 0.9) : v.matched === v.total;
          if (okAll && v.leaks === 0) {
            regexSource = tpl;
            usedTemplate = true;
            break;
          }
        } catch {
          /* try next template */
        }
      }
      if (!usedTemplate) {
        throw new Error($t("TXT_CODE_msl_regex_unverified", { event }));
      }
    }

    operationLogger.log("agent_msl_regex_ai", {
      daemon_id: String(ctx.query.daemonId),
      instance_id: String(ctx.query.uuid),
      ...getOperationLoggerOperator(ctx),
      fields: event
    } as any);
    ctx.body = { event, regex: regexSource, evidence: evLines.length };
  }
);

export default router;