import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { addPluginListener } from "@tauri-apps/api/core";
import App from "./App";
import SourceOnboarding from "./startup/SourceOnboarding";
import { api, isMobile, platform } from "../shared/api/api";
import { exitApp } from "../shared/lib/appLifecycle";
import { runBack } from "../shared/lib/back";
import { usePendingDeepLink } from "../shared/lib/deepLink";
import { AppProvider, useStore } from "../shared/model/store";
import { initAutoLine } from "../shared/network/autoLine";
import { tr, useLocale } from "../shared/i18n";
import { Button } from "../shared/ui/ios/controls";
import { Modal, ToastHost } from "../shared/ui/ui";

const Settings = lazy(() => import("../features/settings/Settings"));

const supportsCssMax = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("top", "max(1px, 2px)");
function preSourceShellStyle(): CSSProperties | undefined {
  if (!isMobile) return undefined;
  const minBottom = platform === "android" ? "24px" : "16px";
  return (supportsCssMax
    ? {
        "--sat": "max(var(--native-sat, 0px), env(safe-area-inset-top, 0px), 12px)",
        "--sab": `max(var(--native-sab, 0px), env(safe-area-inset-bottom, 0px), ${minBottom})`,
        "--sal": "max(var(--native-sal, 0px), env(safe-area-inset-left, 0px))",
        "--sar": "max(var(--native-sar, 0px), env(safe-area-inset-right, 0px))",
      }
    : {
        "--sat": "var(--native-sat, 12px)",
        "--sab": `var(--native-sab, ${minBottom})`,
        "--sal": "var(--native-sal, 0px)",
        "--sar": "var(--native-sar, 0px)",
      }) as CSSProperties;
}

function DeepLinkImportPrompt({ onImported }: { onImported: () => void }) {
  const { toast } = useStore();
  const [target, clear] = usePendingDeepLink();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!target) return null;
  const confirmImport = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const s = await api.sourceImport(target, true);
      window.dispatchEvent(new CustomEvent("hg:line-changed"));
      window.dispatchEvent(new CustomEvent("hg:source-changed"));
      toast(tr("已导入 {0} v{1}", s.name, s.version), "ok");
      clear();
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={() => { if (!busy) clear(); }} label={tr("导入视频源")} width={420}>
      <div className="p-4 space-y-3">
        <div className="text-[15px] font-bold text-on">{tr("导入视频源")}</div>
        <div className="p-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on font-mono break-all max-h-28 overflow-y-auto">
          {target}
        </div>
        {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
        <div className="flex gap-2">
          <Button disabled={busy} onClick={clear} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on pressable">{tr("取消")}</Button>
          <Button disabled={busy} onClick={() => void confirmImport()} className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[13px] font-semibold text-on-primary pressable disabled:opacity-50">
            {busy ? tr("导入中…") : tr("导入")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SourceGate() {
  useLocale();
  const { sourceState, activeSource, refreshSourceState } = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wide, setWide] = useState(() => window.innerWidth >= 860);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 860);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const readyForApp =
    sourceState === "unsupported" ||
    (sourceState !== null && Boolean(sourceState.activeSourceId));

  useEffect(() => {
    if (readyForApp) {
      setSettingsOpen(false);
      if (sourceState === "unsupported" || activeSource?.capabilities.lines) {
        initAutoLine();
      }
    }
  }, [readyForApp, sourceState, activeSource?.capabilities.lines]);

  const preSourceBackRef = useRef<() => void>(() => {});
  preSourceBackRef.current = () => {
    if (runBack()) return;
    if (settingsOpen) {
      setSettingsOpen(false);
      refreshSourceState();
      return;
    }
    if (platform === "android") {
      exitApp().catch(() => {});
    }
  };

  useEffect(() => {
    if (sourceState === null || readyForApp) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key === "Escape") preSourceBackRef.current();
    };
    window.addEventListener("keydown", onKey);
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    if (platform === "android") {
      addPluginListener("app", "back-button", () => preSourceBackRef.current())
        .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
        .catch(() => {});
    }
    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      handle?.unregister().catch(() => {});
    };
  }, [sourceState, readyForApp]);

  if (sourceState === null) return null;
  if (sourceState !== "unsupported" && !sourceState.activeSourceId) {
    return (
      <div className={`fixed inset-0 bg-bg plat-${platform}`} style={preSourceShellStyle()}>
        {settingsOpen ? (
          <Suspense fallback={null}>
            <Settings wide={wide} onBack={() => { setSettingsOpen(false); refreshSourceState(); }} />
          </Suspense>
        ) : (
          <SourceOnboarding
            state={sourceState}
            onChanged={refreshSourceState}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
        <DeepLinkImportPrompt onImported={refreshSourceState} />
        <ToastHost />
      </div>
    );
  }
  return (
    <>
      <App />
      <DeepLinkImportPrompt onImported={refreshSourceState} />
    </>
  );
}

/** Account restore, line probes and content requests begin only after agreement and source activation. */
export default function AcceptedApp() {
  return <AppProvider><SourceGate /></AppProvider>;
}
