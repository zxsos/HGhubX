import { useEffect, useState } from "react";
import { api } from "../api/api";

declare global {
  interface Window {
    __HG_DEEP_LINK__?: string;
    __HG_DEEP_LINK_HANDLED__?: string;
  }
}

export function extractDeepLinkTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("hghubx://")) return null;
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    if (host !== "import" && path !== "import") return null;
    const target = (u.searchParams.get("url") || u.searchParams.get("src") || u.searchParams.get("code") || "").trim();
    return target || null;
  } catch {
    return null;
  }
}

export function usePendingDeepLink(): [string | null, () => void] {
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const accept = (raw: string | null | undefined) => {
      if (!raw) return;
      if (window.__HG_DEEP_LINK_HANDLED__ === raw) return;
      const target = extractDeepLinkTarget(raw);
      if (!target) return;
      window.__HG_DEEP_LINK_HANDLED__ = raw;
      delete window.__HG_DEEP_LINK__;
      setPending(target);
    };

    accept(window.__HG_DEEP_LINK__);
    void api.sourceTakeDeepLink().then(accept).catch(() => {});

    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      accept(typeof detail === "string" ? detail : window.__HG_DEEP_LINK__);
      void api.sourceTakeDeepLink().catch(() => {});
    };
    window.addEventListener("hg:deep-link", onEvent);
    return () => window.removeEventListener("hg:deep-link", onEvent);
  }, []);

  return [pending, () => {
    delete window.__HG_DEEP_LINK_HANDLED__;
    setPending(null);
  }];
}
