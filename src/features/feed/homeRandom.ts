import { STORAGE_KEYS } from "../../shared/storage/storage";

const MAX_STORED_SCOPES = 40;
const MAX_RECENT_IDS = 180;

export const HOME_RANDOM_PAGE_POOL = 120;
export const PINNED_RANDOM_PAGE_POOL = 40;

const recentBySource = new Map<string, number[]>();

/** 无偏随机整数 [0, bound)。优先用 Web Crypto，避免低熵伪随机重复。 */
export function randomIndex(bound: number): number {
  if (bound <= 1) return 0;
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const limit = Math.floor(0x100000000 / bound) * bound;
    const buf = new Uint32Array(1);
    while (true) {
      cryptoObj.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % bound;
    }
  }
  return Math.floor(Math.random() * bound);
}

/** Fisher-Yates 洗牌 */
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 生成去重随机页码队列，跨多页均匀采样并尽量避免连续两轮抽中同一首页。 */
export function buildRandomPageDeck(
  totalPages: number,
  options?: { maxPoolPages?: number; excludeFirst?: number; exclude?: ReadonlySet<number> },
): number[] {
  const maxPool = options?.maxPoolPages ?? HOME_RANDOM_PAGE_POOL;
  const cap = Math.max(1, Math.min(Math.floor(totalPages), maxPool));
  const excluded = options?.exclude;
  const pages: number[] = [];
  for (let p = 1; p <= cap; p++) {
    if (!excluded?.has(p)) pages.push(p);
  }
  const deck = shuffle(pages);
  if (options?.excludeFirst && deck.length > 1 && deck[0] === options.excludeFirst) {
    const swapAt = 1 + randomIndex(deck.length - 1);
    [deck[0], deck[swapAt]] = [deck[swapAt], deck[0]];
  }
  return deck;
}

/** 优先展示近期未出现过的视频，均单独洗牌，避免刷新撞脸也不丢内容。 */
export function rankUnseenFirst<T extends { id: number }>(
  items: readonly T[],
  recentIds: ReadonlySet<number>,
): T[] {
  if (!recentIds.size) return shuffle(items);
  const fresh: T[] = [];
  const seen: T[] = [];
  for (const item of items) {
    if (recentIds.has(item.id)) seen.push(item);
    else fresh.push(item);
  }
  return [...shuffle(fresh), ...shuffle(seen)];
}

export function getRecentHomeIds(sourceKey: string): Set<number> {
  return new Set(recentBySource.get(sourceKey) ?? []);
}

export function rememberRecentHomeIds(sourceKey: string, ids: readonly number[]): void {
  if (!ids.length) return;
  const prev = recentBySource.get(sourceKey) ?? [];
  const next = prev.filter((id) => !ids.includes(id));
  next.push(...ids);
  if (next.length > MAX_RECENT_IDS) {
    next.splice(0, next.length - MAX_RECENT_IDS);
  }
  recentBySource.set(sourceKey, next);
}

type PageMapRead =
  | { ok: true; map: Record<string, number> }
  | { ok: false };

function readPageMap(): PageMapRead {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.homePages);
    if (raw === null) return { ok: true, map: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 1) {
        out[k] = Math.floor(v);
      }
    }
    return { ok: true, map: out };
  } catch {
    return { ok: false };
  }
}

export function readKnownPages(scopeKey: string): number {
  const res = readPageMap();
  return res.ok ? (res.map[scopeKey] ?? 0) : 0;
}

export function writeKnownPages(scopeKey: string, pages: number): void {
  const normalized = Math.floor(pages);
  if (!Number.isFinite(normalized) || normalized < 1) return;
  try {
    const res = readPageMap();
    /* 读取失败或已有内容损坏时保留原值，避免静默清空或覆盖不可读存储 */
    if (!res.ok) return;
    const map = res.map;
    if (map[scopeKey] === normalized) return;
    delete map[scopeKey];
    map[scopeKey] = normalized;
    const keys = Object.keys(map);
    if (keys.length > MAX_STORED_SCOPES) {
      for (const oldKey of keys.slice(0, keys.length - MAX_STORED_SCOPES)) {
        delete map[oldKey];
      }
    }
    localStorage.setItem(STORAGE_KEYS.homePages, JSON.stringify(map));
  } catch {
    /* 存储受限时静默忽略 */
  }
}
