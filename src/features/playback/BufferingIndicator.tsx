import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Loader } from "../../shared/ui/ios/effects";

const SAMPLE_MS = 500;
const WINDOW_MS = 1600;
const STALL_MS = 2500;

export function formatNetSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0 KB/s";
  if (bytesPerSec >= 1024 * 1024) {
    const mb = bytesPerSec / (1024 * 1024);
    return `${mb.toFixed(mb >= 10 ? 1 : 2).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")} MB/s`;
  }
  if (bytesPerSec >= 1024) return `${Math.round(bytesPerSec / 1024)} KB/s`;
  return `${Math.max(1, Math.round(bytesPerSec))} B/s`;
}

/**
 * Samples live Rust media-proxy receive throughput ONLY while `active` is true
 * (i.e. while a player buffering/loading indicator is visible). Zero background
 * IPC or timers during smooth playback.
 */
export function useMediaSpeed(active: boolean): { bytesPerSec: number | null; stalled: boolean } {
  const [state, setState] = useState<{ bytesPerSec: number | null; stalled: boolean }>({
    bytesPerSec: null,
    stalled: false,
  });

  useEffect(() => {
    if (!active) {
      setState({ bytesPerSec: null, stalled: false });
      return;
    }
    if (typeof window === "undefined" || !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      return;
    }

    let alive = true;
    let inFlight = false;
    let timer = 0;
    const samples: Array<{ t: number; bytes: number }> = [];
    let zeroSince: number | null = null;

    const poll = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      try {
        const bytes = await invoke<number>("media_rx_bytes");
        if (!alive || typeof bytes !== "number" || !Number.isFinite(bytes)) return;
        const now = performance.now();
        samples.push({ t: now, bytes });
        while (samples.length > 2 && now - samples[0].t > WINDOW_MS) {
          samples.shift();
        }
        if (samples.length >= 2) {
          const oldest = samples[0];
          const dtSec = (now - oldest.t) / 1000;
          const delta = Math.max(0, bytes - oldest.bytes);
          const bps = dtSec > 0.05 ? delta / dtSec : 0;
          if (bps <= 0) {
            if (zeroSince === null) zeroSince = now;
          } else {
            zeroSince = null;
          }
          const stalled = zeroSince !== null && now - zeroSince >= STALL_MS;
          setState({ bytesPerSec: bps, stalled });
        }
        timer = window.setTimeout(() => { void poll(); }, SAMPLE_MS);
      } catch {
        // Mocked or browser-only environment without media_rx_bytes: stop polling quietly.
      } finally {
        inFlight = false;
      }
    };

    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [active]);

  return state;
}

export function BufferingIndicator({ className = "" }: { className?: string }) {
  const { bytesPerSec, stalled } = useMediaSpeed(true);
  return (
    <div className={`flex flex-col items-center justify-center gap-2 pointer-events-none ${className}`.trim()}>
      <Loader className="w-9 h-9 spinner" />
      {bytesPerSec !== null && (
        <span
          aria-hidden="true"
          className={`px-2.5 py-0.5 rounded-full text-[11.5px] font-semibold tabular-nums tracking-tight ${stalled ? "text-amber-300" : "text-white/90"}`}
          style={{
            background: "rgba(12,15,22,.62)",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12), 0 2px 8px rgba(0,0,0,.35)",
          }}>
          {formatNetSpeed(bytesPerSec)}
        </span>
      )}
    </div>
  );
}
