export type SuperResolutionVariant = "fsr" | "cas" | "detail";

/** The hidden prototype switch: ?sr=1, ?sr=fsr, ?sr=cas, or ?sr=detail. */
export function superResolutionRequested() {
  if (typeof window === "undefined") return false;
  const value = new URLSearchParams(window.location.search).get("sr");
  return value === "1" || value === "fsr" || value === "cas" || value === "detail";
}

export function superResolutionVariant(): SuperResolutionVariant {
  if (typeof window === "undefined") return "fsr";
  const value = new URLSearchParams(window.location.search).get("sr");
  if (value === "cas") return "cas";
  if (value === "detail") return "detail";
  return "fsr";
}
