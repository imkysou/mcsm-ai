import { initI18n } from "@/lang/i18n";
import { initLayoutConfig } from "./services/layout";
import { useAppStateStore } from "./stores/useAppStateStore";
import { setAppLoadingError, setLoadingTitle } from "./tools/dom";

function handleLoadingError(error: any) {
  console.error("Init app error:", error);
  const errorMessage = String(error?.message || error);
  if (errorMessage.toLowerCase().includes("request failed with status code 500")) {
    setAppLoadingError((window as any).loadingI18n("errorBackend"));
    return;
  }
  setAppLoadingError(errorMessage);
}

async function initApp() {
  try {
    const { state, updatePanelStatus } = useAppStateStore();
    setLoadingTitle((window as any).loadingI18n("initialize"));
    await updatePanelStatus();
    setLoadingTitle((window as any).loadingI18n("language"));
    await initI18n(state.language);
    setLoadingTitle((window as any).loadingI18n("layout"));
    await initLayoutConfig();
    setLoadingTitle((window as any).loadingI18n("download"));
    const module = await import("./mount");
    setLoadingTitle((window as any).loadingI18n("render"));
    await module.mountApp();
  } catch (error: any) {
    handleLoadingError(error);
  }
}

initApp();
