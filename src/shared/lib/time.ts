const MIN_VALID_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 10 * 365 * 24 * 3600 * 1000;
const INVALID_TEXT = new Set(["0", "-", "--", "null", "undefined", "nan", "invalid date"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocalDateTime(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function isReasonableMs(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_VALID_TIMESTAMP_MS && ms <= Date.now() + MAX_FUTURE_SKEW_MS;
}

/**
 * Normalize upstream timestamps (Unix seconds/ms, ISO-8601 UTC/offset, YYYY-MM-DD HH:mm:ss,
 * or human relative text) into a consistent local display string. Rejects empty/zero/epoch-0 placeholders.
 */
export function formatTimestamp(raw?: string | number | null): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return "";
    const ms = raw < 1e11 ? raw * 1000 : raw;
    return isReasonableMs(ms) ? formatLocalDateTime(ms) : "";
  }
  const text = String(raw).trim();
  if (!text || INVALID_TEXT.has(text.toLowerCase())) return "";

  if (/^\d{9,13}$/.test(text)) {
    const num = Number(text);
    const ms = text.length <= 10 ? num * 1000 : num;
    return isReasonableMs(ms) ? formatLocalDateTime(ms) : "";
  }

  // ISO-8601 or datetime string with explicit timezone (Z or +/-HH:MM) -> convert to local timezone.
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const normalized = text.replace(/\//g, "-").replace(" ", "T");
    const parsed = Date.parse(normalized);
    return isReasonableMs(parsed) ? formatLocalDateTime(parsed) : "";
  }

  // Plain local datetime without timezone: validate year >= 2000 (rejects 0000-00-00 / 1970-01-01) and normalize.
  const localDateTime = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (localDateTime) {
    const year = Number(localDateTime[1]);
    const month = Number(localDateTime[2]);
    const day = Number(localDateTime[3]);
    const hour = Number(localDateTime[4]);
    const minute = Number(localDateTime[5]);
    if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return "";
    return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`;
  }

  const localDate = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (localDate) {
    const year = Number(localDate[1]);
    const month = Number(localDate[2]);
    const day = Number(localDate[3]);
    if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return "";
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  return text;
}
