<!-- Local node tools: auto target the local machine (no node selection). -->
<script setup lang="ts">
import { useAppRouters } from "@/hooks/useAppRouters";
import { GLOBAL_INSTANCE_UUID } from "@/config/const";
import { useRoute } from "vue-router";
import { resolveLocalNodeId } from "@/tools/nodes";
import { t } from "@/lang/i18n";
import { onMounted } from "vue";

const { toPage } = useAppRouters();
const route = useRoute();

onMounted(async () => {
  const tool = String(route.meta?.tool || "terminal");
  const daemonId = await resolveLocalNodeId();
  if (tool === "image") {
    toPage({ path: "/node/image", query: { daemonId } });
    return;
  }
  const path = tool === "files" ? "/instances/terminal/files" : "/instances/terminal";
  toPage({
    path,
    query: { daemonId, instanceId: GLOBAL_INSTANCE_UUID }
  });
});
</script>

<template>
  <div class="flex-center h-100 w-100" style="min-height: 60vh">
    <span>{{ t("TXT_CODE_7190d3cf") }}...</span>
  </div>
</template>
