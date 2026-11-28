const MIN_VALID_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
/** 允许少量设备与服务端时钟偏移（5 分钟），拒绝排期/置顶占位或错标时区导致的未来时间。 */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const INVALID_TEXT = new Set(["0", "-", "--", "null", "undefined", "nan", "invalid date"]);
const FUTURE_RELATIVE_RE = /^(?:\d+\s*(?:秒|分钟?|小时|天|周|个?月|年)后|in\s+\d+\s*(?:sec(?:ond)?s?|min(?:ute)?s?|hours?|days?|weeks?|months?|years?))$/i;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocalDateTime(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function isReasonableMs(ms: number, nowMs: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_VALID_TIMESTAMP_MS && ms <= nowMs + MAX_FUTURE_SKEW_MS;
}

function parseValidatedLocalDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number | null {
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
    || date.getSeconds() !== second
  ) return null;
  return date.getTime();
}

/**
 * Normalize upstream timestamps (Unix seconds/ms, ISO-8601 UTC/offset, YYYY-MM-DD HH:mm:ss,
 * Chinese date strings, or human relative text) into a consistent local display string.
 * Rejects empty/zero/epoch-0 placeholders and future timestamps beyond clock-skew tolerance.
 */
export function formatTimestamp(raw?: string | number | null, nowMs: number = Date.now()): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return "";
    const ms = raw < 1e11 ? raw * 1000 : raw;
    return isReasonableMs(ms, nowMs) ? formatLocalDateTime(ms) : "";
  }
  const text = String(raw).trim();
  if (!text || INVALID_TEXT.has(text.toLowerCase()) || FUTURE_RELATIVE_RE.test(text)) return "";

  if (/^\d{9,13}$/.test(text)) {
    const num = Number(text);
    const ms = text.length <= 10 ? num * 1000 : num;
    return isReasonableMs(ms, nowMs) ? formatLocalDateTime(ms) : "";
  }

  // ISO-8601 or datetime string with explicit timezone (Z or +/-HH:MM, optional space before offset) -> local timezone.
  const tzMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})$/i.exec(text);
  if (tzMatch) {
    const [, y, mo, d, h, mi, s = "00", rawTz] = tzMatch;
    const tz = rawTz.toUpperCase() === "Z" ? "Z" : (rawTz.includes(":") ? rawTz : `${rawTz.slice(0, 3)}:${rawTz.slice(3)}`);
    const parsed = Date.parse(`${y}-${pad2(Number(mo))}-${pad2(Number(d))}T${pad2(Number(h))}:${mi}:${s}${tz}`);
    return isReasonableMs(parsed, nowMs) ? formatLocalDateTime(parsed) : "";
  }

  // Plain local datetime without timezone (YYYY-MM-DD HH:mm[:ss] or YYYY年MM月DD日 HH:mm[:ss]).
  const localDateTime = /^(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ]|(\d{4})年(\d{1,2})月(\d{1,2})日\s*)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(text);
  if (localDateTime) {
    const year = Number(localDateTime[1] ?? localDateTime[4]);
    const month = Number(localDateTime[2] ?? localDateTime[5]);
    const day = Number(localDateTime[3] ?? localDateTime[6]);
    const hour = Number(localDateTime[7]);
    const minute = Number(localDateTime[8]);
    const second = Number(localDateTime[9] ?? "0");
    const ms = parseValidatedLocalDate(year, month, day, hour, minute, second);
    if (ms === null || !isReasonableMs(ms, nowMs)) return "";
    return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`;
  }

  // Plain local date without time (YYYY-MM-DD or YYYY年MM月DD日).
  const localDate = /^(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})|(\d{4})年(\d{1,2})月(\d{1,2})日)$/.exec(text);
  if (localDate) {
    const year = Number(localDate[1] ?? localDate[4]);
    const month = Number(localDate[2] ?? localDate[5]);
    const day = Number(localDate[3] ?? localDate[6]);
    const ms = parseValidatedLocalDate(year, month, day);
    if (ms === null || !isReasonableMs(ms, nowMs)) return "";
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  // Any other absolute date string (e.g. RFC-2822 / "YYYY-MM-DD HH:mm:ss UTC") must still respect the past/future window.
  if (/\b\d{4}\b/.test(text)) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return isReasonableMs(parsed, nowMs) ? formatLocalDateTime(parsed) : "";
  }

  return text;
}
