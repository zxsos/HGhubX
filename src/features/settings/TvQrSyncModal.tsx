import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  api,
  isMobile,
  platform,
  type DiscoveredTv,
  type PairedPeerSummary,
  type SubscriptionPreview,
  type TvBidirectionalSyncResult,
  type TvSyncData,
} from "../../shared/api/api";
import { decodeQrFromFile, decodeQrFromVideo, hasNativeBarcodeDetector, parseTvLanTarget } from "../../shared/lib/qrDecode";
import { registerOverlayBack } from "../../shared/lib/back";
import { useContentPreferences, mergeContentPreferences } from "../../shared/model/contentPreferences";
import { useStore } from "../../shared/model/store";
import { autoLineEnabled } from "../../shared/network/autoLine";
import { tr } from "../../shared/i18n";
import { ICheck, IClose, IRefresh, IScan } from "../../shared/ui/icons";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { Modal, Sheet } from "../../shared/ui/ui";

function notifySourceChanged() {
  window.dispatchEvent(new CustomEvent("hg:line-changed"));
  window.dispatchEvent(new CustomEvent("hg:source-changed"));
}

function defaultPhoneName() {
  if (platform === "ios") return "iPhone";
  if (platform === "android") return "Android 手机";
  if (platform === "harmony") return "HarmonyOS";
  if (platform === "macos") return "Mac";
  if (platform === "windows") return "Windows";
  return "Linux";
}

function formatLastSync(ts?: number | null): string {
  if (!ts) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diff < 60) return tr("刚刚同步");
  if (diff < 3600) return tr("{0} 分钟前", Math.floor(diff / 60));
  if (diff < 86400) return tr("{0} 小时前", Math.floor(diff / 3600));
  return tr("{0} 天前", Math.floor(diff / 86400));
}

function isAuxRearLensLabel(label: string): boolean {
  return /(?:ultra|wide|0\.[56]|macro|tele|depth|mono|\bir\b|tof|bokeh|广角|微距|长焦|景深)/i.test(label);
}

function isFrontCameraLabel(label: string): boolean {
  return /(?:front|user|selfie|facetime|前置)/i.test(label);
}

function pickPreferredRearCameraId(devices: MediaDeviceInfo[]): { mainId: string | null; rearIds: string[] } {
  const videos = devices.filter((d) => d.kind === "videoinput" && d.deviceId);
  const rears = videos.filter((d) => !isFrontCameraLabel(d.label));
  const rearIds = rears.map((d) => d.deviceId);
  if (!rears.length) return { mainId: null, rearIds: videos.map((d) => d.deviceId) };
  const ranked = [...rears].sort((a, b) => {
    const score = (d: MediaDeviceInfo) => {
      let s = 0;
      if (!isAuxRearLensLabel(d.label)) s += 100;
      if (/(?:back|rear|main|environment|后置|主摄)/i.test(d.label)) s += 20;
      if (/\bcamera\s*0\b|camera2\s*0\b/i.test(d.label)) s += 10;
      return s;
    };
    return score(b) - score(a);
  });
  return { mainId: ranked[0]?.deviceId ?? null, rearIds };
}

async function tuneCameraTrack(track: MediaStreamTrack): Promise<void> {
  try {
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const adv: Record<string, unknown> = {};
    if (Array.isArray(caps.focusMode)) {
      if (caps.focusMode.includes("continuous")) adv.focusMode = "continuous";
      else if (caps.focusMode.includes("single-shot")) adv.focusMode = "single-shot";
    }
    if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes("continuous")) {
      adv.exposureMode = "continuous";
    }
    if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes("continuous")) {
      adv.whiteBalanceMode = "continuous";
    }
    if (Object.keys(adv).length > 0 && typeof track.applyConstraints === "function") {
      await track.applyConstraints({ advanced: [adv as MediaTrackConstraintSet] });
    }
  } catch { /* ignore unsupported advanced constraints */ }
}

async function acquireCameraStream(preferredDeviceId?: string): Promise<MediaStream> {
  const mediaDevices = navigator.mediaDevices;
  const attempts: MediaTrackConstraints[] = preferredDeviceId
    ? [
        { deviceId: { exact: preferredDeviceId }, width: { ideal: 1920, min: 1280 }, height: { ideal: 1080, min: 720 }, frameRate: { ideal: 30 } },
        { deviceId: { exact: preferredDeviceId }, width: { ideal: 1280, min: 640 }, height: { ideal: 720, min: 480 } },
        { deviceId: { exact: preferredDeviceId } },
      ]
    : [
        { facingMode: { ideal: "environment" }, width: { ideal: 1920, min: 1280 }, height: { ideal: 1080, min: 720 }, frameRate: { ideal: 30 } },
        { facingMode: { ideal: "environment" }, width: { ideal: 1280, min: 960 }, height: { ideal: 720, min: 540 }, frameRate: { ideal: 30 } },
        { facingMode: { ideal: "environment" } },
      ];
  let lastError: unknown;
  for (const video of attempts) {
    try {
      return await mediaDevices.getUserMedia({ video, audio: false });
    } catch (error) {
      lastError = error;
    }
  }
  if (!preferredDeviceId) {
    return await mediaDevices.getUserMedia({ video: true, audio: false });
  }
  throw lastError;
}

type MergedTvItem = {
  key: string;
  name: string;
  ip: string;
  port: number;
  online: boolean;
  pairing: boolean;
  pairId?: string | null;
  lastSyncedAt?: number | null;
};

type SyncDoneBanner = {
  title: string;
  badges: string[];
};

export default function TvQrSyncModal({
  open,
  onClose,
  onSuccess,
  onSubscription,
  initialView = "scan",
}: {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  /** 扫到订阅清单时交给调用方展示订阅选择器；未提供时提示到「视频源」导入。 */
  onSubscription?: (preview: SubscriptionPreview) => void;
  initialView?: "scan" | "hub";
}) {
  const { favs, postFavs, history, preferHevc, mergePeerLibrary, toast } = useStore();
  const { preferences } = useContentPreferences();

  const [view, setView] = useState<"scan" | "hub">(initialView);
  const [pairedPeers, setPairedPeers] = useState<PairedPeerSummary[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredTv[]>([]);
  const [discovering, setDiscovering] = useState(false);

  const [cameraState, setCameraState] = useState<"starting" | "ready" | "error">("starting");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [codeTarget, setCodeTarget] = useState<{ name: string; ip: string; port: number } | null>(null);
  const [pinCode, setPinCode] = useState("");
  const [status, setStatus] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [doneBanner, setDoneBanner] = useState<SyncDoneBanner | null>(null);
  const [error, setError] = useState("");
  const [busyPairId, setBusyPairId] = useState<string | null>(null);
  const [rearCameraIds, setRearCameraIds] = useState<string[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | undefined>(undefined);
  const [focusPulse, setFocusPulse] = useState<{ x: number; y: number } | null>(null);
  const focusTimerRef = useRef(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const decodingRef = useRef(false);
  const lineBaseRef = useRef("");
  const hasActiveSourceRef = useRef(false);
  const autoCloseRef = useRef(0);
  const busyRef = useRef(false);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    setDiscovering(true);
    try {
      const [peers, found] = await Promise.all([
        api.tvPeerList().catch(() => [] as PairedPeerSummary[]),
        api.tvPeerDiscover().catch(() => [] as DiscoveredTv[]),
      ]);
      setPairedPeers(peers);
      setDiscovered(found);
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      window.clearTimeout(autoCloseRef.current);
      window.clearTimeout(focusTimerRef.current);
      stopCamera();
      setManualOpen(false);
      setManualText("");
      setCodeTarget(null);
      setPinCode("");
      setStatus("idle");
      setDoneBanner(null);
      setError("");
      setBusyPairId(null);
      setRearCameraIds([]);
      setSelectedCameraId(undefined);
      setFocusPulse(null);
      busyRef.current = false;
      return;
    }
    setView(initialView);
    void refreshDevices();
    void api.sourceState().then((s) => {
      hasActiveSourceRef.current = s.sources.some((x) => x.active);
    }).catch(() => {});
    void api.lineState().then((l) => {
      lineBaseRef.current = l.base || "";
    }).catch(() => {
      lineBaseRef.current = "";
    });
  }, [open, initialView, refreshDevices, stopCamera]);

  const scanBackRef = useRef({ manualOpen, codeTarget, onClose });
  scanBackRef.current = { manualOpen, codeTarget, onClose };
  useEffect(() => {
    if (!open || view !== "scan") return undefined;
    const handleBack = (): boolean => {
      if (busyRef.current) return true;
      const cur = scanBackRef.current;
      if (cur.manualOpen) {
        setManualOpen(false);
        setError("");
        return true;
      }
      if (cur.codeTarget) {
        setCodeTarget(null);
        setPinCode("");
        setError("");
        return true;
      }
      cur.onClose();
      return true;
    };
    const removeOverlayBack = registerOverlayBack(handleBack);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) handleBack();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      removeOverlayBack();
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, view]);

  const buildSyncPayload = useCallback((): TvSyncData => ({
    favs,
    postFavs,
    history: history.map((h) => ({ id: h.id, ep: h.ep, t: h.t, dur: h.dur, at: h.at })),
    contentPreferences: {
      blockedTags: preferences.blockedTags,
      pinnedTags: preferences.pinnedTags,
      paused: preferences.paused,
      hideUntagged: preferences.hideUntagged,
    },
    preferHevc,
    autoLine: autoLineEnabled(),
    lineBase: lineBaseRef.current || null,
  }), [favs, postFavs, history, preferences, preferHevc]);

  const finishBidirectionalSync = useCallback((res: TvBidirectionalSyncResult, autoClose: boolean) => {
    const merged = mergePeerLibrary({
      favs: res.tvSync.favs,
      postFavs: res.tvSync.postFavs,
      history: res.tvSync.history,
    });
    if (res.tvSync.contentPreferences) {
      mergeContentPreferences(res.tvSync.contentPreferences);
    }
    if (res.importedSourceFromTv) {
      notifySourceChanged();
    }

    const pushed = res.pushedFavs + res.pushedPostFavs + res.pushedHistory;
    const pulled = merged.addedFavs + merged.addedPostFavs + merged.updatedHistory;
    const badges: string[] = [];
    if (res.importedSourceFromTv) badges.push(res.importedSourceFromTv.name);
    else if (res.sourceName) badges.push(res.sourceName);
    if (pushed > 0) badges.push(tr("↑ 推 {0} 项", pushed));
    if (pulled > 0) badges.push(tr("↓ 取 {0} 项", pulled));

    const title = res.legacySourceOnly
      ? tr("已配置视频源，旧版电视暂不支持同步其他数据")
      : tr("已与 {0} 同步", res.tvName);
    setDoneBanner({ title, badges });
    setStatus("done");
    toast(badges.length ? `${title} · ${badges.join(" · ")}` : title, res.legacySourceOnly ? "info" : "ok");
    onSuccess?.();
    void refreshDevices();

    if (autoClose) {
      window.clearTimeout(autoCloseRef.current);
      autoCloseRef.current = window.setTimeout(() => onClose(), 1050);
    }
  }, [mergePeerLibrary, toast, onSuccess, refreshDevices, onClose]);

  const handleDecodedRaw = useCallback(async (rawText: string) => {
    const raw = rawText.trim();
    if (!raw || busyRef.current) return;
    busyRef.current = true;
    stopCamera();
    setManualOpen(false);
    setCodeTarget(null);
    setError("");
    setStatus("syncing");

    try {
      const target = parseTvLanTarget(raw);
      if (target) {
        const res = await api.tvPeerPairQr(
          target.url,
          defaultPhoneName(),
          hasActiveSourceRef.current,
          buildSyncPayload(),
        );
        finishBidirectionalSync(res, true);
      } else {
        const res = await api.sourceResolveImport(raw, true);
        if (res.kind === "subscription") {
          if (!onSubscription) throw new Error(tr("这是订阅清单，请在「视频源」中导入"));
          setStatus("idle");
          onSubscription(res.preview);
          onClose();
          return;
        }
        const summary = res.summary;
        notifySourceChanged();
        setDoneBanner({ title: tr("已导入 {0} v{1}", summary.name, summary.version), badges: [] });
        setStatus("done");
        toast(tr("已导入 {0} v{1}", summary.name, summary.version), "ok");
        onSuccess?.();
        window.clearTimeout(autoCloseRef.current);
        autoCloseRef.current = window.setTimeout(() => onClose(), 900);
      }
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
    } finally {
      busyRef.current = false;
    }
  }, [stopCamera, buildSyncPayload, finishBidirectionalSync, toast, onSuccess, onSubscription, onClose]);

  const syncWithPairedTv = useCallback(async (tv: MergedTvItem) => {
    if (!tv.pairId || busyRef.current) return;
    busyRef.current = true;
    setBusyPairId(tv.pairId);
    setError("");
    if (view === "scan") {
      stopCamera();
      setStatus("syncing");
    }
    try {
      const res = await api.tvPeerSync(
        tv.pairId,
        tv.online ? tv.ip : null,
        tv.online ? tv.port : null,
        hasActiveSourceRef.current,
        buildSyncPayload(),
      );
      finishBidirectionalSync(res, view === "scan");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e || tr("失败"));
      setError(msg);
      if (view === "scan") setStatus("error");
      else toast(msg, "info");
      void refreshDevices();
    } finally {
      setBusyPairId(null);
      busyRef.current = false;
    }
  }, [view, stopCamera, buildSyncPayload, finishBidirectionalSync, toast, refreshDevices]);

  const submitPinPair = useCallback(async () => {
    if (!codeTarget || pinCode.trim().length !== 4 || busyRef.current) return;
    busyRef.current = true;
    setError("");
    if (view === "scan") {
      stopCamera();
      setStatus("syncing");
    }
    try {
      const res = await api.tvPeerPairCode(
        codeTarget.ip,
        codeTarget.port,
        pinCode.trim(),
        defaultPhoneName(),
        hasActiveSourceRef.current,
        buildSyncPayload(),
      );
      setCodeTarget(null);
      setPinCode("");
      finishBidirectionalSync(res, view === "scan");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e || tr("失败"));
      setError(msg);
      if (view === "scan") setStatus("idle");
    } finally {
      busyRef.current = false;
    }
  }, [codeTarget, pinCode, view, stopCamera, buildSyncPayload, finishBidirectionalSync]);

  const removePairedTv = async (pairId: string) => {
    if (busyRef.current) return;
    setBusyPairId(pairId);
    try {
      const next = await api.tvPeerRemove(pairId);
      setPairedPeers(next);
      toast(tr("已解除配对"), "info");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "info");
    } finally {
      setBusyPairId(null);
    }
  };

  // Camera viewfinder loop when in full-screen "scan" mode and idle
  useEffect(() => {
    if (!open || view !== "scan" || manualOpen || codeTarget || status !== "idle") {
      stopCamera();
      return;
    }
    let alive = true;
    let timer = 0;
    setCameraState("starting");

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (alive) setCameraState("error");
        return;
      }
      try {
        let stream = await acquireCameraStream(selectedCameraId);
        if (!alive) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        let track = stream.getVideoTracks()[0];
        if (track) await tuneCameraTrack(track);

        if (navigator.mediaDevices.enumerateDevices) {
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            if (!alive) {
              stream.getTracks().forEach((t) => t.stop());
              return;
            }
            const { mainId, rearIds } = pickPreferredRearCameraId(devices);
            setRearCameraIds(rearIds);
            const activeId = track?.getSettings?.().deviceId;
            const activeHeight = track?.getSettings?.().height ?? 0;
            const activeLabel = track?.label ?? "";
            if (!selectedCameraId && mainId && mainId !== activeId && (activeHeight < 720 || isAuxRearLensLabel(activeLabel))) {
              try {
                const better = await acquireCameraStream(mainId);
                if (!alive) {
                  better.getTracks().forEach((t) => t.stop());
                  stream.getTracks().forEach((t) => t.stop());
                  return;
                }
                stream.getTracks().forEach((t) => t.stop());
                stream = better;
                track = stream.getVideoTracks()[0];
                if (track) await tuneCameraTrack(track);
                setSelectedCameraId(mainId);
              } catch { /* keep initial stream */ }
            }
          } catch { /* ignore device enumeration error */ }
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        if (alive) setCameraState("ready");

        const intervalMs = hasNativeBarcodeDetector() ? 180 : 260;
        const tick = async () => {
          if (!alive) return;
          if (!decodingRef.current && videoRef.current) {
            decodingRef.current = true;
            try {
              if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
              const val = await decodeQrFromVideo(videoRef.current, canvasRef.current);
              if (val && alive) {
                void handleDecodedRaw(val);
                return;
              }
            } catch { /* retry next frame */ }
            finally {
              decodingRef.current = false;
            }
          }
          if (alive) timer = window.setTimeout(() => void tick(), intervalMs);
        };
        timer = window.setTimeout(() => void tick(), 200);
      } catch {
        if (alive) setCameraState("error");
      }
    };

    void start();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      stopCamera();
    };
  }, [open, view, manualOpen, codeTarget, status, selectedCameraId, handleDecodedRaw, stopCamera]);

  const cycleRearCamera = () => {
    if (rearCameraIds.length < 2) return;
    const activeId = streamRef.current?.getVideoTracks()[0]?.getSettings?.().deviceId ?? selectedCameraId;
    const idx = activeId ? rearCameraIds.indexOf(activeId) : 0;
    const nextId = rearCameraIds[(idx + 1) % rearCameraIds.length];
    if (nextId) setSelectedCameraId(nextId);
  };

  const triggerTapFocus = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (cameraState !== "ready" || status !== "idle" || manualOpen || codeTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setFocusPulse({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(() => setFocusPulse(null), 550);
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== "function") return;
    const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
    if (!Array.isArray(caps.focusMode)) return;
    if (caps.focusMode.includes("single-shot")) {
      void track.applyConstraints({ advanced: [{ focusMode: "single-shot" } as MediaTrackConstraintSet] })
        .then(() => {
          if (caps.focusMode?.includes("continuous")) {
            window.setTimeout(() => {
              void track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
            }, 350);
          }
        })
        .catch(() => {});
    } else if (caps.focusMode.includes("continuous")) {
      void track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
    }
  };

  const onFilePick = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try {
      const val = await decodeQrFromFile(file);
      if (!val) {
        toast(tr("未在图片中识别到二维码"), "info");
        return;
      }
      await handleDecodedRaw(val);
    } catch {
      toast(tr("未在图片中识别到二维码"), "info");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const mergedTvs = useMemo<MergedTvItem[]>(() => {
    const out: MergedTvItem[] = [];
    const matchedPairIds = new Set<string>();
    for (const d of discovered) {
      if (d.pairId) matchedPairIds.add(d.pairId);
      out.push({
        key: `disc:${d.deviceId}`,
        name: d.name,
        ip: d.ip,
        port: d.port,
        online: true,
        pairing: d.pairing,
        pairId: d.pairId,
        lastSyncedAt: d.lastSyncedAt,
      });
    }
    for (const p of pairedPeers) {
      if (matchedPairIds.has(p.pairId)) continue;
      out.push({
        key: `pair:${p.pairId}`,
        name: p.name,
        ip: p.lastIp,
        port: p.lastPort,
        online: false,
        pairing: false,
        pairId: p.pairId,
        lastSyncedAt: p.lastSyncedAt,
      });
    }
    return out;
  }, [discovered, pairedPeers]);

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      className="hidden"
      onChange={(e) => void onFilePick(e.target.files?.[0])}
    />
  );

  if (!open) return null;

  if (view === "scan") {
    const scanOverlay = (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tr("扫一扫")}
        className="fixed inset-0 z-[290] bg-black text-white flex flex-col select-none"
      >
        {fileInput}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-200 ${cameraState === "ready" && status === "idle" && !manualOpen && !codeTarget ? "opacity-100" : "opacity-25"}`}
        />

        {/* Top bar */}
        <div
          className="relative z-10 flex items-center justify-between gap-3 px-4 pb-3"
          style={{ paddingTop: "max(14px, var(--native-sat, env(safe-area-inset-top, 0px)))" }}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label={tr("关闭")}
            className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-md border border-white/15 flex items-center justify-center text-white pressable"
          >
            <IClose size={19} />
          </button>

          <div className="flex items-center gap-2">
            {rearCameraIds.length > 1 && (
              <button
                type="button"
                onClick={cycleRearCamera}
                className="h-9 px-3 rounded-full bg-black/50 backdrop-blur-md border border-white/15 text-[12px] font-medium text-white pressable"
              >
                {tr("切镜头")}
              </button>
            )}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="h-9 px-3.5 rounded-full bg-black/50 backdrop-blur-md border border-white/15 text-[13px] font-medium text-white pressable"
            >
              {tr("相册")}
            </button>
            <button
              type="button"
              onClick={() => { setError(""); setCodeTarget(null); setManualOpen((v) => !v); }}
              className="h-9 px-3.5 rounded-full bg-black/50 backdrop-blur-md border border-white/15 text-[13px] font-medium text-white pressable"
            >
              {tr("手动")}
            </button>
          </div>
        </div>

        {/* Center viewport */}
        <div className="relative z-10 flex-1 flex items-center justify-center px-6" onClick={triggerTapFocus}>
          {focusPulse && (
            <span
              aria-hidden
              className="pointer-events-none absolute w-14 h-14 -ml-7 -mt-7 rounded-full border-2 border-primary/90 animate-ping"
              style={{ left: focusPulse.x, top: focusPulse.y }}
            />
          )}
          {status === "syncing" && (
            <div className="w-full max-w-[300px] rounded-2xl bg-black/75 backdrop-blur-xl border border-white/15 p-6 flex flex-col items-center gap-3 text-center">
              <Loader />
              <div className="text-[14px] font-medium text-white">{tr("正在连接并同步…")}</div>
            </div>
          )}

          {status === "done" && doneBanner && (
            <div className="w-full max-w-[320px] rounded-2xl bg-black/80 backdrop-blur-xl border border-mint/40 p-6 flex flex-col items-center gap-3 text-center">
              <div className="w-11 h-11 rounded-full bg-mint/20 border border-mint/50 flex items-center justify-center text-mint">
                <ICheck size={22} />
              </div>
              <div className="text-[15px] font-bold text-white">{doneBanner.title}</div>
              {doneBanner.badges.length > 0 && (
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  {doneBanner.badges.map((b, i) => (
                    <span key={i} className="text-[12px] px-2.5 py-0.5 rounded-full bg-white/10 text-white/90">{b}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {status === "error" && (
            <div className="w-full max-w-[320px] rounded-2xl bg-black/80 backdrop-blur-xl border border-danger/40 p-5 flex flex-col items-center gap-3 text-center">
              <p role="alert" className="text-[13px] text-danger break-words">{error}</p>
              <button
                type="button"
                onClick={() => { setError(""); setStatus("idle"); }}
                className="h-9 px-5 rounded-full brand-grad text-[13px] font-semibold text-on-primary pressable"
              >
                {tr("重试")}
              </button>
            </div>
          )}

          {status === "idle" && manualOpen && (
            <div className="w-full max-w-[340px] rounded-2xl bg-black/80 backdrop-blur-xl border border-white/15 p-4 space-y-3">
              <input
                aria-label={tr("导入视频源")}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                className="w-full h-10 px-3 rounded-xl bg-white/10 text-[13px] text-white font-mono outline-none placeholder:text-white/45"
                autoFocus
              />
              {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setError(""); setManualOpen(false); }}
                  className="h-9 px-4 rounded-xl bg-white/10 text-[13px] text-white pressable"
                >
                  {tr("取消")}
                </button>
                <button
                  type="button"
                  disabled={!manualText.trim()}
                  onClick={() => void handleDecodedRaw(manualText)}
                  className="flex-1 h-9 rounded-xl brand-grad text-[13px] font-semibold text-on-primary pressable disabled:opacity-50"
                >
                  {tr("确认")}
                </button>
              </div>
            </div>
          )}

          {status === "idle" && !manualOpen && codeTarget && (
            <div className="w-full max-w-[320px] rounded-2xl bg-black/80 backdrop-blur-xl border border-white/15 p-5 space-y-3 text-center">
              <div className="text-[15px] font-bold text-white">{codeTarget.name}</div>
              <input
                inputMode="numeric"
                maxLength={4}
                value={pinCode}
                onChange={(e) => setPinCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder={tr("输入电视上的 4 位配对码")}
                className="w-full h-11 px-3 rounded-xl bg-white/10 text-center text-[20px] font-mono tracking-[0.35em] text-white outline-none placeholder:text-[13px] placeholder:tracking-normal placeholder:text-white/45"
                autoFocus
              />
              {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setError(""); setPinCode(""); setCodeTarget(null); }}
                  className="h-9 px-4 rounded-xl bg-white/10 text-[13px] text-white pressable"
                >
                  {tr("取消")}
                </button>
                <button
                  type="button"
                  disabled={pinCode.length !== 4}
                  onClick={() => void submitPinPair()}
                  className="flex-1 h-9 rounded-xl brand-grad text-[13px] font-semibold text-on-primary pressable disabled:opacity-50"
                >
                  {tr("配对并同步")}
                </button>
              </div>
            </div>
          )}

          {status === "idle" && !manualOpen && !codeTarget && (
            cameraState === "error" ? (
              <div className="w-full max-w-[300px] rounded-2xl bg-white/5 border border-white/10 p-5 text-center space-y-2">
                <IScan size={28} className="mx-auto text-primary/80" />
                <p className="text-[13px] text-white/75">{tr("相机未就绪，可直接点击下方电视或从相册识别")}</p>
              </div>
            ) : (
              <div className="relative w-[248px] h-[248px] max-w-[70vw] max-h-[70vw]">
                <span aria-hidden className="absolute left-0 top-0 w-7 h-7 border-t-[3px] border-l-[3px] border-primary rounded-tl-xl" />
                <span aria-hidden className="absolute right-0 top-0 w-7 h-7 border-t-[3px] border-r-[3px] border-primary rounded-tr-xl" />
                <span aria-hidden className="absolute left-0 bottom-0 w-7 h-7 border-b-[3px] border-l-[3px] border-primary rounded-bl-xl" />
                <span aria-hidden className="absolute right-0 bottom-0 w-7 h-7 border-b-[3px] border-r-[3px] border-primary rounded-br-xl" />
                <span aria-hidden className="absolute inset-x-4 top-1/2 h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent opacity-80" />
              </div>
            )
          )}
        </div>

        {/* Bottom LAN discovery tray */}
        <div
          className="relative z-10 mx-auto w-full max-w-[480px] px-4 pt-2"
          style={{ paddingBottom: "max(16px, var(--native-sab, env(safe-area-inset-bottom, 0px)))" }}
        >
          <div className="rounded-2xl bg-black/70 backdrop-blur-xl border border-white/12 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold text-white/80">{tr("同局域网电视")}</span>
              <button
                type="button"
                disabled={discovering}
                onClick={() => void refreshDevices()}
                aria-label={tr("刷新")}
                className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/85 pressable disabled:opacity-50"
              >
                <IRefresh size={13} className={discovering ? "animate-spin" : ""} />
              </button>
            </div>

            {mergedTvs.length === 0 ? (
              <div className="text-[12px] text-white/55 py-1">
                {discovering ? tr("正在搜索同 Wi-Fi 电视…") : tr("暂未发现可配对电视，请对准电视二维码")}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[144px] overflow-y-auto">
                {mergedTvs.map((tv) => (
                  <div key={tv.key} className="flex items-center justify-between gap-2 rounded-xl bg-white/8 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-white truncate">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${tv.online ? "bg-mint" : "bg-white/30"}`} />
                        <span className="truncate">{tv.name}</span>
                      </div>
                      <div className="text-[11px] text-white/55 truncate">
                        {tv.ip}{tv.lastSyncedAt ? ` · ${formatLastSync(tv.lastSyncedAt)}` : ""}
                      </div>
                    </div>

                    {tv.pairId ? (
                      <button
                        type="button"
                        disabled={Boolean(busyPairId)}
                        onClick={() => void syncWithPairedTv(tv)}
                        className="shrink-0 h-8 px-3.5 rounded-full brand-grad text-[12px] font-semibold text-on-primary pressable disabled:opacity-50"
                      >
                        {busyPairId === tv.pairId ? tr("同步中") : tr("双向同步")}
                      </button>
                    ) : tv.pairing ? (
                      <button
                        type="button"
                        onClick={() => { setError(""); setPinCode(""); setCodeTarget({ name: tv.name, ip: tv.ip, port: tv.port }); }}
                        className="shrink-0 h-8 px-3.5 rounded-full bg-white/15 border border-white/20 text-[12px] font-semibold text-white pressable"
                      >
                        {tr("配对")}
                      </button>
                    ) : (
                      <span className="shrink-0 text-[11px] text-white/50">{tr("请在 TV 打开扫码页")}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
    const portalRoot = typeof document !== "undefined" ? (document.getElementById("root") ?? document.body) : null;
    return portalRoot ? createPortal(scanOverlay, portalRoot) : scanOverlay;
  }

  // "hub" view: Paired & discovered TVs inside Settings Sheet/Modal
  const hubBody = (
    <div className="flex flex-col min-h-0 max-h-[82dvh]">
      {fileInput}
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3.5 border-b border-s3">
        <div className="flex items-center gap-2 min-w-0">
          <IScan size={16} className="text-primary shrink-0" />
          <h2 className="text-[16px] font-bold text-on truncate">{tr("连接 TV")}</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <Button onClick={() => void refreshDevices()} aria-label={tr("刷新")} className="ios-icon-button">
            <IRefresh size={16} className={discovering ? "animate-spin" : ""} />
          </Button>
          <Button onClick={onClose} aria-label={tr("关闭")} className="ios-icon-button"><IClose size={18} /></Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 scroll-y p-4 space-y-3">
        {codeTarget && (
          <Surface className="rounded-(--r-md) bg-s2 p-3.5 space-y-2.5">
            <div className="text-[13px] font-semibold text-on">{tr("输入 {0} 上的 4 位配对码", codeTarget.name)}</div>
            <input
              inputMode="numeric"
              maxLength={4}
              value={pinCode}
              onChange={(e) => setPinCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="0000"
              className="w-full h-10 px-3 rounded-(--r-sm) bg-s3 text-center text-[18px] font-mono tracking-[0.35em] text-on outline-none"
              autoFocus
            />
            {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
            <div className="flex items-center gap-2">
              <Button onClick={() => { setCodeTarget(null); setPinCode(""); setError(""); }} className="h-9 px-3.5 rounded-(--r-ctl) bg-s3 text-[13px] text-on pressable">{tr("取消")}</Button>
              <Button disabled={pinCode.length !== 4 || Boolean(busyPairId)} onClick={() => void submitPinPair()} className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[13px] font-semibold text-on-primary pressable disabled:opacity-50">{tr("配对并同步")}</Button>
            </div>
          </Surface>
        )}

        {!mergedTvs.length ? (
          <Surface className="rounded-(--r-md) bg-s2 p-5 text-center text-[13px] text-mut">
            {discovering ? tr("正在搜索同 Wi-Fi 电视…") : tr("暂未发现可配对电视")}
          </Surface>
        ) : (
          <div className="space-y-2">
            {mergedTvs.map((tv) => (
              <Surface key={tv.key} className="rounded-(--r-md) bg-s2 p-3.5 flex items-center justify-between gap-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[14px] font-semibold text-on truncate">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${tv.online ? "bg-mint" : "bg-dim"}`} />
                    <span className="truncate">{tv.name}</span>
                  </div>
                  <div className="text-[12px] text-mut truncate">
                    {tv.ip}{tv.lastSyncedAt ? ` · ${formatLastSync(tv.lastSyncedAt)}` : ""}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {tv.pairId ? (
                    <>
                      <Button
                        disabled={Boolean(busyPairId)}
                        onClick={() => void syncWithPairedTv(tv)}
                        className="h-8 px-3 rounded-(--r-ctl) brand-grad text-[12px] font-semibold text-on-primary pressable disabled:opacity-50"
                      >
                        {busyPairId === tv.pairId ? tr("同步中") : tr("双向同步")}
                      </Button>
                      <Button
                        disabled={Boolean(busyPairId)}
                        onClick={() => void removePairedTv(tv.pairId!)}
                        className="h-8 px-2.5 rounded-(--r-ctl) bg-s3 text-[12px] text-danger pressable"
                      >
                        {tr("解除")}
                      </Button>
                    </>
                  ) : tv.pairing ? (
                    <Button
                      onClick={() => { setError(""); setPinCode(""); setCodeTarget({ name: tv.name, ip: tv.ip, port: tv.port }); }}
                      className="h-8 px-3 rounded-(--r-ctl) bg-primary text-[12px] font-semibold text-on-primary pressable"
                    >
                      {tr("配对")}
                    </Button>
                  ) : (
                    <span className="text-[12px] text-mut">{tr("未开启配对")}</span>
                  )}
                </div>
              </Surface>
            ))}
          </div>
        )}

        <Button
          onClick={() => { setError(""); setCodeTarget(null); setView("scan"); }}
          className="w-full h-10 rounded-(--r-ctl) brand-grad text-[14px] font-semibold text-on-primary pressable inline-flex items-center justify-center gap-1.5"
        >
          <IScan size={15} /> {tr("扫码添加或同步")}
        </Button>
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={open} onClose={onClose} label={tr("连接 TV")}>{hubBody}</Sheet>
    : <Modal open={open} onClose={onClose} label={tr("连接 TV")} width={460}>{hubBody}</Modal>;
}
