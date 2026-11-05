import { useEffect, useState } from 'react';

/** Screen readers hear the countdown only at these marks, never every second. */
export const ANNOUNCE_EVERY_S = 10;

export interface FenceState {
  readonly open: boolean;
  /** Whole seconds left, rounded up. */
  readonly remaining: number;
  /** Share of the fence still to run, from 1 when the review was made to 0 when it ends. */
  readonly left: number;
  /** What a screen reader hears; it changes only at ten-second marks and when the fence ends. */
  readonly announcement: string;
}

export function fenceState(from: number, until: number, now: number, what: string): FenceState {
  const open = now >= until;
  const remaining = open ? 0 : Math.ceil((until - now) / 1000);
  const span = until - Math.min(from, until);
  const left = open || span <= 0 ? 0 : Math.min(1, (until - now) / span);
  const mark = Math.ceil(remaining / ANNOUNCE_EVERY_S) * ANNOUNCE_EVERY_S;
  return {
    open,
    remaining,
    left,
    announcement: open
      ? `The execution fence has ended. ${what} can be approved.`
      : `${what} can be approved in ${mark} seconds or less.`,
  };
}

const clock = (time: number) => new Date(time).toLocaleTimeString();

/**
 * The stop fence before an approval opens: a ring that empties until the reviewed not-before
 * time. The count is for sighted operators; the status line speaks at ten-second marks.
 * With reduced motion the ring is hidden and the number stands alone.
 */
export function FenceTimer({
  from,
  until,
  what,
}: {
  /** When the review began; the ring is full then. */
  readonly from: string;
  /** The reviewed not-before time. */
  readonly until: string;
  /** What opens, for example "This handoff". */
  readonly what: string;
}) {
  const end = Date.parse(until);
  const start = Date.parse(from);
  const [now, setNow] = useState(Date.now);
  const state = fenceState(start, end, now, what);
  useEffect(() => {
    if (state.open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [state.open]);
  return (
    <div className="fence" data-open={state.open ? '' : undefined}>
      <svg className="fence-ring" viewBox="0 0 44 44" aria-hidden="true">
        <circle className="fence-track" cx="22" cy="22" r="18" />
        {state.open ? (
          <path className="fence-tick" d="M14 22.5l5.5 5.5L30.5 16" />
        ) : (
          <circle
            className="fence-left"
            cx="22"
            cy="22"
            r="18"
            pathLength={1}
            transform="rotate(-90 22 22)"
            style={{ strokeDashoffset: 1 - state.left }}
          />
        )}
      </svg>
      <p className="fence-text">
        <strong className="figures" aria-hidden="true">
          {state.open ? 'Open' : `${state.remaining} s`}
        </strong>
        <span>
          {state.open
            ? `The execution fence ended at ${clock(end)}. ${what} can be approved.`
            : `Execution fence until ${clock(end)}. ${what} cannot be approved before then.`}
        </span>
      </p>
      <p className="visually-hidden" role="status">
        {state.announcement}
      </p>
    </div>
  );
}
