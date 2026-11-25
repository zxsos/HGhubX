import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { fmt } from "../../shared/api/api";
import { Button } from "../../shared/ui/ios/controls";
import { IUserF } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import type { AuthorItem } from "./authorDirectory";

const HOLD_MS = 600;
const MOVE_PX = 10;

/** Author pill: tap opens the profile, deliberate hold follows or unfollows. */
export function AuthorChip({ author, followed, busy = false, showFollowers = true, highlight = true, onOpen, onToggleFollow }: {
  author: AuthorItem; followed: boolean; busy?: boolean; showFollowers?: boolean; highlight?: boolean;
  onOpen: () => void; onToggleFollow: (author: AuthorItem) => void;
}) {
  const [pressing, setPressing] = useState(false);
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const longPressed = useRef(false);
  const suppressClick = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const cancelHold = useCallback(() => {
    clearTimer();
    origin.current = null;
    setPressing(false);
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (busy) return;
    clearTimer();
    longPressed.current = false;
    suppressClick.current = false;
    origin.current = { x: event.clientX, y: event.clientY };
    setPressing(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      longPressed.current = true;
      suppressClick.current = true;
      origin.current = null;
      setPressing(false);
      navigator.vibrate?.(8);
      onToggleFollow(author);
    }, HOLD_MS);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (longPressed.current || !origin.current) return;
    if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > MOVE_PX) cancelHold();
  };
  const pointerUp = () => {
    clearTimer();
    origin.current = null;
    setPressing(false);
  };
  const pointerCancel = () => {
    cancelHold();
    longPressed.current = false;
    suppressClick.current = false;
  };
  const click = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onOpen();
  };

  return <Button type="button"
    aria-label={followed ? tr("长按取消关注作者：{0}", author.name) : tr("长按关注作者：{0}", author.name)}
    data-author-id={author.id} data-following={highlight && followed ? "true" : undefined} data-pressing={pressing ? "true" : undefined}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel}
    onPointerLeave={cancelHold} onClick={click} onContextMenu={event => event.preventDefault()}
    className="ios-filter-pill tag-pin-pill max-w-full min-w-0 gap-1.5 text-left">
    <span className="min-w-0 whitespace-normal break-words text-on/95">{author.name}</span>
    {showFollowers && author.followers > 0 && <span aria-label={tr("{0} 粉丝", fmt(author.followers))} className="shrink-0 inline-flex items-center gap-0.5 text-[11.5px] font-medium text-dim tabular-nums"><IUserF size={11} className="text-primary/85" />{fmt(author.followers)}</span>}
  </Button>;
}
