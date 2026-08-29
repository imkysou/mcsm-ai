import { t } from "@/lang/i18n";
import { overviewInfo } from "@/services/apis";

/**
 * Resolve the local (this machine) node id without asking the user.
 * Uses the overview localDaemonId flag (embedded single-process mode) and
 * falls back to the first available node.
 */
export async function resolveLocalNodeId(): Promise<string> {
  try {
    const { execute } = overviewInfo();
    const res = await execute({ forceRequest: true } as any);
    const data: any = res.value;
    const remote: any[] = (data && data.remote) || [];
    const local = remote.find((r) => r.uuid === data?.localDaemonId);
    if (local && local.available !== false) return local.uuid;
    const first = remote.find((r) => r.available !== false);
    if (first && first.uuid) return first.uuid;
    if (remote.length && remote[0].uuid) return remote[0].uuid;
    return "";
  } catch {
    return "";
  }
}

/** Resolve the local node object (uuid + info) for flows that keep the node object. */
export async function resolveLocalNode(): Promise<any | null> {
  try {
    const { execute } = overviewInfo();
    const res = await execute({ forceRequest: true } as any);
    const data: any = res.value;
    const remote: any[] = (data && data.remote) || [];
    const local = remote.find((r) => r.uuid === data?.localDaemonId);
    if (local && local.available !== false) return { uuid: local.uuid, ...local };
    const first = remote.find((r) => r.available !== false);
    if (first) return { uuid: first.uuid, ...first };
    if (remote.length) return { uuid: remote[0].uuid, ...remote[0] };
    return null;
  } catch {
    return null;
  }
}


export function computeNodeName(ip: string, available: boolean, remark?: string) {
  if (!ip) return t("TXT_CODE_aa373641");
  const online = available ? "" : t("TXT_CODE_836addb9");
  return remark ? `${remark} - ${ip} ${online}` : `${ip} ${online}`;
}
