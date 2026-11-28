import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import App from "./App";
import SourceOnboarding from "./startup/SourceOnboarding";
import { api, isMobile, platform, type SubscriptionPreview, type SubscriptionSiteInput } from "../shared/api/api";
import SubscriptionPicker from "../features/settings/SubscriptionPicker";
import { exitApp } from "../shared/lib/appLifecycle";
import { runBack, subscribeNativeBack, syncOhosBackIntercept, useHasBackConsumer } from "../shared/lib/back";
import { useEdgeSwipeBack } from "../shared/ui/hooks/useEdgeSwipeBack";
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
  const [subscription, setSubscription] = useState<SubscriptionPreview | null>(null);

  if (!target) return null;
  const close = () => {
    setSubscription(null);
    setError("");
    clear();
  };
  const confirmImport = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.sourceResolveImport(target, true);
      if (res.kind === "subscription") {
        setSubscription(res.preview);
        return;
      }
      window.dispatchEvent(new CustomEvent("hg:line-changed"));
      window.dispatchEvent(new CustomEvent("hg:source-changed"));
      toast(tr("已导入 {0} v{1}", res.summary.name, res.summary.version), "ok");
      close();
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
    } finally {
      setBusy(false);
    }
  };
  const confirmSubscription = async (items: SubscriptionSiteInput[]) => {
    if (busy || !items.length) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.sourceImportSubscription(items, true);
      if (!res.imported.length) {
        // 全部失败：留在订阅清单并展示失败原因，便于调整勾选后重试。
        setError(res.failed.length > 0
          ? tr("{0} 个站点导入失败：{1}", res.failed.length, res.failed.map((f) => `${f.name}（${f.error}）`).join("；"))
          : tr("失败"));
        return;
      }
      window.dispatchEvent(new CustomEvent("hg:line-changed"));
      window.dispatchEvent(new CustomEvent("hg:source-changed"));
      toast(
        res.failed.length > 0
          ? tr("已导入 {0} 个视频源（{1} 个失败）", res.imported.length, res.failed.length)
          : tr("已导入 {0} 个视频源", res.imported.length),
        res.failed.length > 0 ? "info" : "ok",
      );
      close();
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={() => { if (!busy) close(); }} label={tr("导入视频源")} width={subscription ? 480 : 420}>
      <div className="p-4 space-y-3">
        {subscription ? (
          <>
            {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
            <SubscriptionPicker
              preview={subscription}
              busy={busy}
              onCancel={() => { setSubscription(null); setError(""); }}
              onConfirm={confirmSubscription}
            />
          </>
        ) : (
          <>
            <div className="text-[15px] font-bold text-on">{tr("导入视频源")}</div>
            <div className="p-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on font-mono break-all max-h-28 overflow-y-auto">
              {target}
            </div>
            {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
            <div className="flex gap-2">
              <Button disabled={busy} onClick={close} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on pressable">{tr("取消")}</Button>
              <Button disabled={busy} onClick={() => void confirmImport()} className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[13px] font-semibold text-on-primary pressable disabled:opacity-50">
                {busy ? tr("导入中…") : tr("导入")}
              </Button>
            </div>
          </>
        )}
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

  const hasBackConsumer = useHasBackConsumer();
  const settingsLayerRef = useRef<HTMLDivElement>(null);
  const closePreSourceSettings = useCallback(() => {
    setSettingsOpen(false);
    refreshSourceState();
  }, [refreshSourceState]);
  useEdgeSwipeBack(settingsLayerRef, isMobile && !readyForApp && settingsOpen, closePreSourceSettings);

  const preSourceBackRef = useRef<() => void>(() => {});
  preSourceBackRef.current = () => {
    if (runBack()) return;
    if (settingsOpen) {
      closePreSourceSettings();
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
    const unsubNative = subscribeNativeBack(platform, () => preSourceBackRef.current());
    return () => {
      window.removeEventListener("keydown", onKey);
      unsubNative();
    };
  }, [sourceState, readyForApp]);

  useEffect(() => {
    if (sourceState === null || readyForApp) return;
    syncOhosBackIntercept(platform, hasBackConsumer || settingsOpen);
  }, [sourceState, readyForApp, hasBackConsumer, settingsOpen]);

  if (sourceState === null) return null;
  if (sourceState !== "unsupported" && !sourceState.activeSourceId) {
    return (
      <div className={`fixed inset-0 bg-bg plat-${platform}`} style={preSourceShellStyle()}>
        <div
          className={`absolute inset-0 ${settingsOpen ? "ios-layer-hidden" : ""}`}
          aria-hidden={settingsOpen || undefined}
          inert={settingsOpen || undefined}
        >
          <SourceOnboarding
            state={sourceState}
            onChanged={refreshSourceState}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
        {settingsOpen && (
          <div ref={settingsLayerRef} className="absolute inset-0 bg-bg z-10">
            <Suspense fallback={null}>
              <Settings wide={wide} onBack={closePreSourceSettings} />
            </Suspense>
          </div>
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
