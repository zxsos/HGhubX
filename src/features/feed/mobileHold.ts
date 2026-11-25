export const HOLD_DELAY_MS = 260;
/** 统一连续长按调速滑轨：去掉 1× 停顿档，左半屏起手 0.5×、右半屏起手 2×，不松手跨区直拖零停顿切换。 */
export const HOLD_SPEED_STEPS = [0.5, 0.75, 1.5, 2, 3, 4, 6] as const;
export const HOLD_SLOW_START = 0.5;
export const HOLD_FAST_START = 2;
/** 跨中线切入减速/加速区的首档落点，保证从加速区直拖入减速区（及反向）无 1× 停顿且不残留高档余量。 */
export const HOLD_SLOW_EDGE = 0.75;
export const HOLD_FAST_EDGE = 1.5;
/** 每累计横向滑动 52px 换一档（增量累计，来回滑可升可降）。 */
export const HOLD_STEP_DISTANCE = 52;
/** 中线两侧防抖迟滞（±12px），避免手指停在中线微抖反复翻区。 */
export const HOLD_ZONE_HYSTERESIS = 12;
export type HoldZone = "fast" | "slow" | "menu";
export type HoldMenuBounds = { left: number; top: number; size: number };
export type HoldRotation = 0 | 90;
export type HoldRect = { left: number; top: number; width: number; height: number };

/** Invert the player's clockwise CSS rotation. Native landscape is already in
 * player coordinates and uses rotation=0. Use this for both gestures and guides.
 */
export function getHoldPoint(clientX: number, clientY: number, rect: HoldRect, rotation: HoldRotation = 0) {
  return rotation === 90
    ? { x: clientY - rect.top, y: rect.left + rect.width - clientX, width: rect.height, height: rect.width }
    : { x: clientX - rect.left, y: clientY - rect.top, width: rect.width, height: rect.height };
}
/** 一次长按内的换挡状态：当前档位 + 增量滑动余量。 */
export type HoldSpeed = { rate: number; lastX: number; travel: number };

export function createHoldSpeed(x: number, initialRate: number = HOLD_FAST_START): HoldSpeed {
  const rate = HOLD_SPEED_STEPS.includes(initialRate as typeof HOLD_SPEED_STEPS[number])
    ? initialRate
    : HOLD_FAST_START;
  return { rate, lastX: x, travel: 0 };
}

/** 累计横向增量并在跨过屏幕中线时无感跨区切入减速/加速；档位变化时震动一次并返回新档位，否则返回 null。 */
export function shiftHoldSpeed(s: HoldSpeed, x: number, width = 0): number | null {
  if (!Number.isFinite(x)) return null;
  const prevX = s.lastX;
  const dx = x - prevX;
  s.lastX = x;

  const w = dimension(width);
  if (w > 0) {
    const mid = w * 0.5;
    const slowLine = mid - HOLD_ZONE_HYSTERESIS;
    const fastLine = mid + HOLD_ZONE_HYSTERESIS;

    if (prevX > slowLine && x <= slowLine && s.rate > 1) {
      const extraLeft = slowLine - x;
      const next = extraLeft >= HOLD_STEP_DISTANCE ? HOLD_SLOW_START : HOLD_SLOW_EDGE;
      s.travel = extraLeft >= HOLD_STEP_DISTANCE ? 0 : -extraLeft;
      s.rate = next;
      try { navigator.vibrate?.(15); } catch { /* ignore */ }
      return next;
    }

    if (prevX < fastLine && x >= fastLine && s.rate < 1) {
      const extraRight = x - fastLine;
      const fastIdx = HOLD_SPEED_STEPS.indexOf(HOLD_FAST_EDGE);
      const bonusSteps = Math.trunc(extraRight / HOLD_STEP_DISTANCE);
      const next = HOLD_SPEED_STEPS[Math.min(HOLD_SPEED_STEPS.length - 1, fastIdx + bonusSteps)];
      s.travel = extraRight - bonusSteps * HOLD_STEP_DISTANCE;
      s.rate = next;
      try { navigator.vibrate?.(15); } catch { /* ignore */ }
      return next;
    }
  }

  s.travel += dx;
  const steps = Math.trunc(s.travel / HOLD_STEP_DISTANCE);
  if (!steps) return null;
  s.travel -= steps * HOLD_STEP_DISTANCE;
  const i = HOLD_SPEED_STEPS.indexOf(s.rate as typeof HOLD_SPEED_STEPS[number]);
  const base = i === -1 ? HOLD_SPEED_STEPS.indexOf(HOLD_FAST_START) : i;
  const next = HOLD_SPEED_STEPS[Math.min(HOLD_SPEED_STEPS.length - 1, Math.max(0, base + steps))];
  if (next === s.rate) { s.travel = 0; return null; }
  s.rate = next;
  try { navigator.vibrate?.(15); } catch { /* ignore */ }
  return next;
}

const dimension = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;

/** CSS-pixel square shared by hit testing and the first-visit guide. */
export function getHoldMenuBounds(width: number, height: number): HoldMenuBounds {
  const w = dimension(width), h = dimension(height);
  const short = Math.min(w, h);
  const size = Math.min(short, 112, Math.max(80, short * 0.26));
  return { left: (w - size) / 2, top: (h - size) / 2, size };
}

/** x/y are in player coordinates (after getHoldPoint), including in landscape.
 * Right half starts at 2x and left half starts at 0.5x; horizontal slide shifts seamlessly across 0.5x..6x.
 */
export function getHoldZone(x: number, y: number, width: number, height: number): HoldZone {
  const w = dimension(width), h = dimension(height);
  if (!w || !h || !Number.isFinite(x) || !Number.isFinite(y)) return "menu";
  return x >= w * 0.5 ? "fast" : "slow";
}
