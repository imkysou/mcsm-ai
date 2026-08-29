/**
 * Agent service facade.
 *
 * Kept for backward compatibility with the initial Agent prototype. New
 * functionality lives in `./agent/*` (engine, config store, sessions,
 * approvals, snapshots, tools, shell security, search, prompts).
 */

import engine from "./agent/engine";
import configStore from "./agent/config_store";
import SessionStore from "./agent/sessions";
import ApprovalStore from "./agent/approvals";
import SnapshotStore from "./agent/snapshots";
import { detectMode } from "./agent/prompt";
import type { AgentRunConfig as AgentRun, ProviderConfig as AgentModel } from "./agent/types";

export type { AgentRunConfig as AgentRunType, ProviderConfig as AgentModelType } from "./agent/types";

export { engine, configStore, SessionStore, ApprovalStore, SnapshotStore, detectMode };

/**
 * Legacy one-shot runner used by the old frontend. Streams events through the
 * optional emit callback.
 */
export async function runAgent(r: {
  workspace: string;
  prompt: string;
  model?: AgentModel & { providerId?: string };
  approve?: boolean;
  daemonId?: string;
  instanceUuid?: string;
  emit?: (event: string, data: unknown) => void;
}) {
  const providerId = r.model?.providerId || configStore.defaultProviderId();
  if (!providerId) {
    // Fallback: auto-register an ephemeral provider from the legacy inline model
    if (!r.model?.endpoint || !r.model?.model) throw new Error("Model endpoint and model are required");
    const p = configStore.add({
      label: r.model.model,
      endpoint: r.model.endpoint,
      model: r.model.model,
      apiKey: r.model.apiKey,
      headers: r.model.headers,
      reasoning: r.model.reasoning,
      reasoningMode: r.model.reasoningMode,
      ctx: r.model.ctx,
      maxToken: r.model.maxToken,
      searchEndpoint: r.model.searchEndpoint,
      searchApiKey: r.model.searchApiKey
    });
    configStore.setDefault(p.id);
    return engine.run(
      {
        workspace: r.workspace,
        prompt: r.prompt,
        providerId: p.id,
        approved: r.approve === true,
        daemonId: r.daemonId,
        instanceUuid: r.instanceUuid,
        mode: detectMode(r.prompt)
      },
      r.emit || (() => {})
    );
  }
  return engine.run(
    {
      workspace: r.workspace,
      prompt: r.prompt,
      providerId,
      approved: r.approve === true,
      daemonId: r.daemonId,
      instanceUuid: r.instanceUuid,
      mode: detectMode(r.prompt)
    },
    r.emit || (() => {})
  );
}