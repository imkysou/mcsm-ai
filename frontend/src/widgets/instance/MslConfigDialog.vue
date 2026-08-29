<script setup lang="ts">
/**
 * MSL (MinecraftServerListener) configuration dialog.
 *
 * - Config tab: enable/debug/auto-restart/logRegexs with AI-assisted regex
 *   generation (one event per click, model picked inline - no navigation).
 * - Plugins tab: load/unload/reload plugins at runtime.
 * - Log tab: view .msl_logs/msl.log and send msl console commands.
 */
import { apiService } from "@/services/apiService";
import { agentProviders, type AgentProvider } from "@/services/apis/agent";
import { t } from "@/lang/i18n";
import { message, Button, Switch, Input, Tag, Tabs, Spin, Empty, Modal, Select } from "ant-design-vue";
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  CodeOutlined
} from "@ant-design/icons-vue";
import { onMounted, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  daemonId: string;
  instanceUuid: string;
}>();

const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

interface MslStatus {
  enabled: boolean;
  debug: boolean;
  plugins: string[];
  running: boolean;
  logRegexs?: Record<string, string>;
}

interface MslPluginItem {
  name: string;
  loaded: boolean;
}

const status = ref<MslStatus | null>(null);
const loading = ref(false);
const saving = ref(false);

// Editable form fields (only what the backend accepts)
const form = ref({
  enabled: false,
  debug: false,
  autoRestartEnable: false,
  autoRestartDelay: 3000,
  autoRestartMaxAttempts: 0,
  logRegexs: {
    playerJoin: "",
    playerQuit: "",
    playerSendMessage: "",
    playerSendCommand: ""
  }
});

const plugins = ref<MslPluginItem[]>([]);
const mslLog = ref("");
const activeTab = ref<"status" | "plugins" | "log">("status");

// AI regex generation state
const providers = ref<AgentProvider[]>([]);
const aiProviderId = ref("");
const generatingKey = ref<"playerJoin" | "playerQuit" | "playerSendMessage" | "playerSendCommand" | "">("");
const showModelPicker = ref(false);
const pendingGenerateKey = ref<"playerJoin" | "playerQuit" | "playerSendMessage" | "playerSendCommand">("playerJoin");

async function loadProviders() {
  try {
    const { execute } = agentProviders();
    const res = await execute();
    if (res.value) {
      providers.value = res.value.providers || [];
      if (!aiProviderId.value && res.value.defaultProviderId) aiProviderId.value = res.value.defaultProviderId;
      if (!aiProviderId.value && providers.value.length) aiProviderId.value = providers.value[0].id;
    }
  } catch {
    providers.value = [];
  }
}

/** Ask the user to pick a model provider, then generate the regex. */
function askAiGenerate(key: "playerJoin" | "playerQuit" | "playerSendMessage" | "playerSendCommand") {
  if (generatingKey.value) return;
  if (!providers.value.length) {
    message.warning(t("TXT_CODE_msl_no_provider"));
    return;
  }
  pendingGenerateKey.value = key;
  showModelPicker.value = true;
}

async function doGenerateRegex() {
  const key = pendingGenerateKey.value;
  if (!aiProviderId.value || !key) return;
  showModelPicker.value = false;
  generatingKey.value = key;
  try {
    const res = await apiService.subscribe<any>({
      url: "/api/msl/regex_ai",
      method: "POST",
      params: { daemonId: props.daemonId, uuid: props.instanceUuid },
      data: { event: key, providerId: aiProviderId.value },
      forceRequest: true,
      timeout: 90000
    });
    if (res?.regex) {
      form.value.logRegexs[key] = res.regex;
      message.success(t("TXT_CODE_msl_regex_generated") + " · " + t("TXT_CODE_msl_generate_hint"));
    } else {
      message.error(t("TXT_CODE_msl_regex_failed") + " " + (res?.message || ""));
    }
  } catch (err: any) {
    message.error(t("TXT_CODE_msl_regex_failed") + " " + (err?.message || err));
  } finally {
    generatingKey.value = "";
  }
}

async function loadAll() {
  if (!props.open || !props.daemonId || !props.instanceUuid) return;
  loading.value = true;
  try {
    const params = { daemonId: props.daemonId, uuid: props.instanceUuid };
    const [statusRes, pluginRes, logRes] = await Promise.all([
      apiService.subscribe<any>({ url: "/api/msl/status", params, forceRequest: true, timeout: 15000 }),
      apiService.subscribe<any>({ url: "/api/msl/plugins", params, forceRequest: true, timeout: 15000 }),
      apiService.subscribe<any>({ url: "/api/msl/log", params: { ...params, tail: 120 }, forceRequest: true, timeout: 15000 })
    ]);
    const st: MslStatus = statusRes || { enabled: false, debug: false, plugins: [], running: false };
    status.value = st;
    plugins.value = (pluginRes || []).map((p: any) => ({ name: p.name, loaded: p.loaded }));
    mslLog.value = logRes?.content || "";
    form.value.enabled = Boolean(st.enabled);
    form.value.debug = Boolean(st.debug);
    // fetch full config for logRegexs / autoRestart
    const cfgRes = await apiService.subscribe<any>({ url: "/api/msl/config", params, forceRequest: true, timeout: 15000 });
    const cfg = cfgRes || {};
    form.value.autoRestartEnable = Boolean(cfg.autoRestart?.enable);
    form.value.autoRestartDelay = Number(cfg.autoRestart?.delay) || 3000;
    form.value.autoRestartMaxAttempts = Number(cfg.autoRestart?.maxAttempts) || 0;
    const r = cfg.logRegexs || {};
    form.value.logRegexs = {
      playerJoin: r.playerJoin || "",
      playerQuit: r.playerQuit || "",
      playerSendMessage: r.playerSendMessage || "",
      playerSendCommand: r.playerSendCommand || ""
    };
  } catch (err: any) {
    message.error(t("TXT_CODE_msl_load_failed") + " " + (err?.message || err));
  } finally {
    loading.value = false;
  }
}

watch(() => props.open, (v) => { if (v) { activeTab.value = "status"; loadAll(); loadProviders(); } });
onMounted(() => { if (props.open) { loadAll(); loadProviders(); } });

async function saveConfig() {
  if (!props.daemonId || !props.instanceUuid) return;
  saving.value = true;
  try {
    const config = {
      enabled: form.value.enabled,
      debug: form.value.debug,
      autoRestart: {
        enable: form.value.autoRestartEnable,
        delay: Number(form.value.autoRestartDelay) || 3000,
        maxAttempts: Number(form.value.autoRestartMaxAttempts) || 0
      },
      logRegexs: {
        playerJoin: form.value.logRegexs.playerJoin,
        playerQuit: form.value.logRegexs.playerQuit,
        playerSendMessage: form.value.logRegexs.playerSendMessage,
        playerSendCommand: form.value.logRegexs.playerSendCommand
      }
    };
    const res = await apiService.subscribe<any>({
      url: "/api/msl/config/update",
      method: "POST",
      params: { daemonId: props.daemonId, uuid: props.instanceUuid },
      data: { config },
      forceRequest: true,
      timeout: 20000
    });
    status.value = res || status.value;
    message.success(t("TXT_CODE_msl_saved"));
    await loadAll();
  } catch (err: any) {
    message.error(t("TXT_CODE_msl_save_failed") + " " + (err?.message || err));
  } finally {
    saving.value = false;
  }
}

async function togglePlugin(name: string, load: boolean) {
  try {
    const res = await apiService.subscribe<any>({
      url: load ? "/api/msl/plugin/enable" : "/api/msl/plugin/disable",
      params: { daemonId: props.daemonId, uuid: props.instanceUuid, name },
      forceRequest: true,
      timeout: 20000
    });
    status.value = res || status.value;
    await loadAll();
  } catch (err: any) {
    message.error(t("TXT_CODE_msl_plugin_failed") + " " + (err?.message || err));
  }
}

async function reloadPlugins() {
  try {
    await apiService.subscribe<any>({
      url: "/api/msl/reload",
      params: { daemonId: props.daemonId, uuid: props.instanceUuid },
      forceRequest: true,
      timeout: 20000
    });
    message.success(t("TXT_CODE_msl_plugins_reloaded"));
    await loadAll();
  } catch (err: any) {
    message.error(t("TXT_CODE_msl_plugin_failed") + " " + (err?.message || err));
  }
}

async function toggleDebug() {
  form.value.debug = !form.value.debug;
  try {
    const res = await apiService.subscribe<any>({
      url: "/api/msl/debug",
      params: { daemonId: props.daemonId, uuid: props.instanceUuid, enabled: form.value.debug },
      forceRequest: true,
      timeout: 20000
    });
    status.value = res || status.value;
    await loadAll();
  } catch (err: any) {
    message.error(t("TXT_CODE_msl_debug_failed") + " " + (err?.message || err));
  }
}

async function sendMslCommand() {
  if (!mslCommand.value.trim()) return;
  try {
    await apiService.subscribe<any>({
      url: "/api/msl/command",
      params: { daemonId: props.daemonId, uuid: props.instanceUuid, command: mslCommand.value.trim() },
      forceRequest: true,
      timeout: 15000
    });
    mslCommand.value = "";
    message.success(t("TXT_CODE_msl_command_sent"));
  } catch (err: any) {
    message.error(t("TXT_CODE_msl_cmd_failed") + " " + (err?.message || err));
  }
}

const mslCommand = ref("");

/**
 * Workspace terminal: runs commands directly in this instance directory (the
 * MSL workspace). npm install here installs packages MSL plugins can require
 * via plugin_require (instance-local resolution).
 */
const showWorkspaceTerminal = ref(false);
const termCommand = ref("npm install");
const termOutput = ref("");
const termRunning = ref(false);

const openTerminal = () => {
  termOutput.value = "";
  termCommand.value = "npm install";
  showWorkspaceTerminal.value = true;
};

const runTermCommand = async () => {
  const command = termCommand.value.trim();
  if (!command || termRunning.value) return;
  termRunning.value = true;
  termOutput.value += "> " + command + "\n";
  try {
    const res = await apiService.subscribe<any>({
      url: "/api/msl/shell",
      method: "POST",
      params: { daemonId: props.daemonId, uuid: props.instanceUuid },
      data: { command, timeoutMs: 120000 },
      forceRequest: true,
      timeout: 140000
    });
    if (res?.stdout) termOutput.value += res.stdout + (res.stdout.endsWith("\n") ? "" : "\n");
    if (res?.stderr) termOutput.value += res.stderr + (res.stderr.endsWith("\n") ? "" : "\n");
    termOutput.value += "[exit " + (res?.code ?? "?") + "]\n";
  } catch (err: any) {
    termOutput.value += "Error: " + (err?.message || err) + "\n";
  } finally {
    termRunning.value = false;
  }
};

</script>

<template>
  <Modal
    :open="props.open"
    :title="t('TXT_CODE_msl_title')"
    width="720px"
    :footer="null"
    :mask-closable="false"
    @cancel="emit('update:open', false)"
  >
    <Spin :spinning="loading">
      <Tabs v-model:active-key="activeTab" size="small">
        <!-- Config -->
        <Tabs.TabPane key="status" :tab="t('TXT_CODE_msl_tab_config')">
          <div class="msl-status-bar">
            <Tag :color="status?.running ? 'green' : 'default'">{{ status?.running ? t('TXT_CODE_msl_mc_running') : t('TXT_CODE_msl_mc_stopped') }}</Tag>
            <Tag :color="status?.enabled ? 'blue' : 'default'">{{ status?.enabled ? t('TXT_CODE_msl_enabled') : t('TXT_CODE_msl_disabled') }}</Tag>
            <Tag :color="status?.debug ? 'orange' : 'default'">{{ status?.debug ? t('TXT_CODE_msl_debug_on') : t('TXT_CODE_msl_debug_off') }}</Tag>
            <Tag>{{ t('TXT_CODE_msl_plugins_count') }} {{ status?.plugins?.length || 0 }}</Tag>
          </div>

          <div class="msl-field">
            <div class="msl-field-label">
              <span>{{ t("TXT_CODE_msl_enable") }}</span>
              <small>{{ t("TXT_CODE_msl_enable_desc") }}</small>
            </div>
            <Switch v-model:checked="form.enabled" />
          </div>

          <div class="msl-field">
            <div class="msl-field-label">
              <span>{{ t("TXT_CODE_msl_debug") }}</span>
              <small>{{ t("TXT_CODE_msl_debug_desc") }}</small>
            </div>
            <Switch :checked="form.debug" @change="toggleDebug" />
          </div>

          <div class="msl-section-title">{{ t("TXT_CODE_msl_autorestart_title") }}</div>
          <div class="msl-field">
            <div class="msl-field-label">
              <span>{{ t("TXT_CODE_msl_autorestart_enable") }}</span>
              <small>{{ t("TXT_CODE_msl_autorestart_enable_desc") }}</small>
            </div>
            <Switch v-model:checked="form.autoRestartEnable" />
          </div>
          <div class="msl-grid">
            <div>
              <label>{{ t("TXT_CODE_msl_autorestart_delay") }}</label>
              <Input v-model:value="form.autoRestartDelay" type="number" :disabled="!form.autoRestartEnable" />
            </div>
            <div>
              <label>{{ t("TXT_CODE_msl_autorestart_max") }}</label>
              <Input v-model:value="form.autoRestartMaxAttempts" type="number" :disabled="!form.autoRestartEnable" />
            </div>
          </div>

          <div class="msl-section-title">
            {{ t("TXT_CODE_msl_regex_title") }}
            <small class="msl-section-sub">{{ t("TXT_CODE_msl_regex_generate_desc") }}</small>
          </div>
          <div class="msl-regex-grid">
            <div v-for="(_, key) in form.logRegexs" :key="key" class="msl-regex-item">
              <label class="regex-label">
                {{ key }}
                <a-tooltip :title="t('TXT_CODE_msl_regex_generate')">
                  <a-button
                    size="small"
                    type="text"
                    class="ai-btn"
                    :loading="generatingKey === key"
                    @click="askAiGenerate(key as any)"
                  >
                    <template #icon><RobotOutlined /></template>
                    {{ t("TXT_CODE_msl_regex_generate") }}
                  </a-button>
                </a-tooltip>
              </label>
              <Input.TextArea v-model:value="form.logRegexs[key]" :rows="2" placeholder="regex" />
            </div>
          </div>

          <div class="msl-actions">
            <Button v-if="props.daemonId && props.instanceUuid" @click="openTerminal">
              <CodeOutlined /> {{ t("TXT_CODE_msl_open_terminal") }}
            </Button>
            <Button @click="emit('update:open', false)">{{ t("TXT_CODE_msl_close") }}</Button>
            <Button type="primary" :loading="saving" @click="saveConfig">
              <CheckCircleOutlined /> {{ t("TXT_CODE_msl_save") }}
            </Button>
          </div>
        </Tabs.TabPane>

        <!-- Plugins -->
        <Tabs.TabPane key="plugins" :tab="t('TXT_CODE_msl_tab_plugins')">
          <div class="msl-status-bar">
            <Button size="small" type="primary" ghost @click="reloadPlugins">
              <ReloadOutlined /> {{ t("TXT_CODE_msl_reload_all") }}
            </Button>
          </div>
          <div v-if="plugins.length" class="plugin-list">
            <div v-for="p in plugins" :key="p.name" class="plugin-item">
              <div class="plugin-name">
                {{ p.name }}
                <Tag :color="p.loaded ? 'green' : 'default'" size="small">{{ p.loaded ? t('TXT_CODE_msl_loaded') : t('TXT_CODE_msl_unloaded') }}</Tag>
              </div>
              <div class="plugin-actions">
                <Button v-if="!p.loaded" size="small" type="primary" ghost @click="togglePlugin(p.name, true)">
                  <PlayCircleOutlined /> {{ t("TXT_CODE_msl_load") }}
                </Button>
                <Button v-else size="small" danger ghost @click="togglePlugin(p.name, false)">
                  <PauseCircleOutlined /> {{ t("TXT_CODE_msl_unload") }}
                </Button>
              </div>
            </div>
          </div>
          <Empty v-else :description="t('TXT_CODE_msl_no_plugins')" />
        </Tabs.TabPane>

        <!-- Log -->
        <Tabs.TabPane key="log" :tab="t('TXT_CODE_msl_tab_log')">
          <div class="msl-status-bar">
            <Button size="small" @click="loadAll">
              <ReloadOutlined /> {{ t("TXT_CODE_msl_refresh") }}
            </Button>
          </div>
          <pre class="msl-log">{{ mslLog || t('TXT_CODE_msl_no_log') }}</pre>
          <div class="msl-command-row">
            <Input v-model:value="mslCommand" :placeholder="t('TXT_CODE_msl_cmd_placeholder')" @press-enter="sendMslCommand" />
            <Button @click="sendMslCommand"><PlayCircleOutlined /></Button>
          </div>
        </Tabs.TabPane>
      </Tabs>
    </Spin>

    <!-- Workspace terminal (MSL directory) -->
    <Modal
      :open="showWorkspaceTerminal"
      :title="t('TXT_CODE_msl_workspace_terminal')"
      width="640px"
      :footer="null"
      :destroy-on-close="false"
      @cancel="showWorkspaceTerminal = false"
    >
      <div class="msl-terminal">
        <div class="msl-terminal-row">
          <Input
            v-model:value="termCommand"
            :disabled="termRunning"
            :placeholder="t('TXT_CODE_msl_terminal_placeholder')"
            @press-enter="runTermCommand"
          />
          <Button type="primary" :loading="termRunning" @click="runTermCommand">
            <PlayCircleOutlined /> {{ t("TXT_CODE_msl_terminal_run") }}
          </Button>
        </div>
        <pre class="msl-terminal-output">{{ termOutput || t("TXT_CODE_msl_terminal_empty") }}</pre>
      </div>
    </Modal>

    <!-- Model picker for AI regex generation -->
    <Modal
      :open="showModelPicker"
      :title="t('TXT_CODE_msl_pick_model')"
      width="420px"
      :footer="null"
      :destroy-on-close="true"
      @cancel="showModelPicker = false"
    >
      <div class="model-picker">
        <Select v-model:value="aiProviderId" style="width: 100%">
          <Select.Option v-for="p in providers" :key="p.id" :value="p.id">
            {{ p.label }} ({{ p.model }})
          </Select.Option>
        </Select>
        <div class="model-picker-actions">
          <Button @click="showModelPicker = false">{{ t("TXT_CODE_agent_cancel") }}</Button>
          <Button type="primary" @click="doGenerateRegex">
            <ThunderboltOutlined /> {{ t("TXT_CODE_msl_regex_generate") }}
          </Button>
        </div>
      </div>
    </Modal>
  </Modal>
</template>

<style scoped>
.msl-status-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.msl-field { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--card-border-color, #ffffff0f); }
.msl-field-label span { display: block; font-weight: 600; font-size: 13px; }
.msl-field-label small { color: var(--color-gray-7, #8896ad); font-size: 11px; line-height: 1.5; display: block; margin-top: 2px; }
.msl-section-title { font-size: 12px; font-weight: 700; color: var(--color-gray-7, #8896ad); text-transform: uppercase; letter-spacing: 0.5px; margin: 16px 0 8px; }
.msl-section-sub { text-transform: none; font-weight: 400; letter-spacing: 0; display: block; margin-top: 4px; }
.msl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px; }
.msl-grid label { display: block; font-size: 11px; color: var(--color-gray-7, #8896ad); margin-bottom: 4px; }
.msl-regex-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.msl-regex-item label { display: block; font-size: 11px; color: var(--color-gray-7, #8896ad); margin-bottom: 4px; }
.regex-label { display: flex; justify-content: space-between; align-items: center; }
.ai-btn { color: var(--color-blue-6, #1668dc); font-size: 11px; }
.msl-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.plugin-list { display: flex; flex-direction: column; gap: 8px; }
.plugin-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-radius: 10px; background: var(--color-gray-2, #ffffff0a); }
.plugin-name { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.plugin-actions { display: flex; gap: 6px; }
.msl-log { font-size: 11px; line-height: 1.5; background: var(--color-gray-2, #0b1220); border-radius: 8px; padding: 12px; max-height: 380px; overflow: auto; white-space: pre-wrap; }
.msl-command-row { display: flex; gap: 8px; margin-top: 10px; }
.model-picker { display: flex; flex-direction: column; gap: 16px; }
.msl-terminal-row { display: flex; gap: 8px; margin-bottom: 10px; }
.msl-terminal-output {
  font-size: 11.5px; line-height: 1.55; background: var(--color-gray-2, #0b1220);
  border: 1px solid var(--card-border-color, #ffffff0f); border-radius: 8px;
  padding: 12px; max-height: 380px; overflow: auto; white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-color);
}
.model-picker-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>