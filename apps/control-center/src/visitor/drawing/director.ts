import { K, type View } from './layout';

export type Cue = 'first' | 'second';
export interface Step {
  readonly kind: 'fade' | 'pen' | 'sweep' | 'pulse' | 'probe' | 'flash' | 'track';
  readonly start: number;
  readonly end: number;
  /** Elements carrying this `data-k`. */
  readonly key: string;
  /** Pen strokes drawn from their far end, as when the chosen route is traced back. */
  readonly reverse?: boolean;
  /** The visible pen follows this stroke. */
  readonly head?: boolean;
  /** The pen only traces this stroke, which is already drawn. */
  readonly ghost?: boolean;
  readonly index?: number;
}
export interface Script {
  readonly steps: readonly Step[];
  readonly cues: readonly { readonly at: number; readonly cue: Cue }[];
  readonly end: number;
}

const PEN_MS = 1700;
const TRAVEL_MS = 70;
const SWEEP_MS = 1300;
const SEARCH_MS = 1500;
const TRACE_MS = 900;

/** Lanes drawn yellow from the start: the first approved plan, when a later condition changes it. */
export const initiallyFilled = (view: View) =>
  new Set(
    view.lanes.some((lane) => lane.blocked)
      ? view.lanes.flatMap((lane, i) => (lane.planned ? [i] : []))
      : [],
  );

/**
 * The opening: the plan is plotted, the recorded scan sweeps, the planner's search spreads and the
 * chosen route is traced back, then each body runs its recorded path. `continued` skips the walls,
 * which stay on screen when one story's drawing replaces another's.
 */
export function opening(view: View, continued: boolean): Script {
  const steps: Step[] = [];
  const cues: { at: number; cue: Cue }[] = [];
  if (!continued) {
    steps.push({ kind: 'fade', key: 'solid', start: 0, end: 320 });
    steps.push({ kind: 'fade', key: 'grid', start: 0, end: 320 });
  }
  const filled = initiallyFilled(view);
  const strokes = [
    ...view.lanes.map((lane, i) => ({ key: `lane-${i}`, length: lane.size, after: `dim-${i}` })),
    ...view.places.map((place, i) => ({
      key: `place-${i}`,
      length: 2 * Math.PI * place.r + 4 * place.r + 32,
      after: `label-${i}`,
    })),
    ...(view.stairs?.risers.map((_, i) => ({
      key: `riser-${i}`,
      length: 128,
      after: i === 0 ? 'stairs-label' : '',
    })) ?? []),
  ];
  const total = strokes.reduce((sum, stroke) => sum + stroke.length, 0) || 1;
  let t = continued ? 100 : 180;
  for (const stroke of strokes) {
    const span = (stroke.length / total) * PEN_MS;
    steps.push({ kind: 'pen', key: stroke.key, start: t, end: t + span, head: true });
    if (stroke.after)
      steps.push({ kind: 'fade', key: stroke.after, start: t + span, end: t + span + 220 });
    t += span + TRAVEL_MS;
  }
  t += 220;
  if (view.scan) {
    const detect = t + view.scan.detect * SWEEP_MS;
    steps.push({ kind: 'sweep', key: 'scan', start: t, end: t + SWEEP_MS });
    steps.push({ kind: 'fade', key: 'corridor', start: detect, end: detect + 200 });
    steps.push({ kind: 'fade', key: 'barrier', start: detect, end: detect + 260 });
    steps.push({ kind: 'pulse', key: 'stop-pulse', start: detect, end: detect + 800 });
    cues.push({ at: detect, cue: 'first' });
    t += SWEEP_MS + 120;
    steps.push({ kind: 'pen', key: 'blocked', start: t, end: t + 280 });
    t += 400;
  }
  const search = view.search;
  if (search) {
    const perMetre = SEARCH_MS / Math.max(0.001, search.total);
    for (const probe of search.probes) {
      const lane = view.lanes[probe.lane];
      if (!lane) continue;
      const start = t + probe.at * perMetre;
      steps.push({
        kind: 'probe',
        key: `probe-${probe.lane}`,
        index: probe.lane,
        start,
        end: start + lane.length * perMetre,
      });
      if (lane.needs.includes('stairs') && !view.scan) cues.push({ at: start, cue: 'first' });
    }
    for (const closed of search.closed) {
      const start = t + closed.at * perMetre;
      steps.push({ kind: 'flash', key: `closed-${closed.lane}`, start, end: start + 650 });
    }
    view.places.forEach((place, i) => {
      const distance = search.reach.get(place.id);
      if (distance === undefined) return;
      const at = t + distance * perMetre;
      steps.push({ kind: 'pulse', key: `pulse-${i}`, start: at, end: at + 700 });
      steps.push({ kind: 'fade', key: `cost-${i}`, start: at, end: at + 260 });
    });
    t += SEARCH_MS + 260;
    const route = [...search.route].reverse();
    const length = route.reduce((sum, i) => sum + (view.lanes[i]?.size ?? 0), 0) || 1;
    for (const i of route) {
      const span = ((view.lanes[i]?.size ?? 0) / length) * TRACE_MS;
      steps.push({
        kind: 'pen',
        key: filled.has(i) ? `lane-${i}` : `fill-${i}`,
        start: t,
        end: t + span,
        reverse: true,
        head: true,
        ghost: filled.has(i),
      });
      t += span;
    }
    // Any approved lane the trace did not cover still appears before the bodies move.
    view.lanes.forEach((lane, i) => {
      if ((lane.planned || lane.replanned) && !filled.has(i) && !search.route.includes(i))
        steps.push({ kind: 'fade', key: `fill-${i}`, start: t, end: t + 250 });
    });
    if (view.scan) cues.push({ at: t, cue: 'second' });
    t += 250;
  }
  steps.push({ kind: 'fade', key: 'body', start: t, end: t + 250 });
  if (view.story === 'handoff') cues.push({ at: t, cue: 'first' });
  view.tracks.forEach((track, i) => {
    const span = Math.min(2400, Math.max(800, (track.total / K) * 240));
    steps.push({ kind: 'track', key: `track-${i}`, index: i, start: t, end: t + span });
    if (i === 1 && view.story !== 'adaptive' && view.story !== 'single')
      cues.push({ at: t, cue: 'second' });
    view.marks.forEach((mark, m) => {
      if (mark.track !== i) return;
      const at = t + mark.share * span;
      steps.push({ kind: 'fade', key: `mark-${m}`, start: at, end: at + 200 });
      if (view.story === 'single' && mark.kind === 'hold') cues.push({ at, cue: 'first' });
    });
    if (view.story === 'single' && i === 0) cues.push({ at: t + span, cue: 'second' });
    t += span + 120;
  });
  return { steps, cues, end: t + 300 };
}

/** Entering the replay chapter: the plan redraws quickly before the recording takes over. */
export function intro(view: View): Script {
  const steps: Step[] = [
    { kind: 'fade', key: 'solid', start: 0, end: 260 },
    { kind: 'fade', key: 'grid', start: 0, end: 260 },
  ];
  view.places.forEach((_, i) => {
    const start = 120 + i * 130;
    steps.push({ kind: 'pen', key: `place-${i}`, start, end: start + 380, head: true });
    steps.push({ kind: 'fade', key: `label-${i}`, start: start + 380, end: start + 560 });
  });
  const t = 160 + view.places.length * 130 + 380;
  steps.push({ kind: 'fade', key: 'ahead', start: t - 200, end: t + 200 });
  steps.push({ kind: 'fade', key: 'body', start: t, end: t + 220 });
  return { steps, cues: [], end: t + 260 };
}

export interface Living {
  /** Length of one loop in milliseconds. */
  readonly duration: number;
  /** Recording seconds per loop second while the bodies move. */
  readonly speed: number;
  /** Recording time at a point in the loop. */
  readonly at: (ms: number) => number;
}

/**
 * The recorded run as a loop of about `target` ms: motion plays at one speed, and waits (the hold
 * for review, a parked body) shrink to short pauses so each loop shows the whole objective.
 */
export function living(view: View, target = 11_000): Living | null {
  const spans: [number, number][] = [];
  for (const track of view.tracks)
    track.live.forEach((sample, i) => {
      const previous = track.live[i - 1];
      if (previous && Math.hypot(sample.x - previous.x, sample.y - previous.y) > 1)
        spans.push([previous.t, sample.t]);
    });
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] - last[1] < 0.6) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  const moving = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
  const speed = Math.min(12, Math.max(1.5, moving / (target / 1000)));
  // [loop ms, recording s] breakpoints, linear between them.
  const points: [number, number][] = [[0, merged[0]?.[0] ?? 0]];
  let ms = 450;
  points.push([ms, merged[0]?.[0] ?? 0]);
  merged.forEach(([from, to], i) => {
    const previous = merged[i - 1];
    if (previous) {
      ms += Math.min(900, Math.max(260, ((from - previous[1]) / speed) * 1000));
      points.push([ms, from]);
    }
    ms += ((to - from) / speed) * 1000;
    points.push([ms, to]);
  });
  ms += 1400;
  points.push([ms, merged.at(-1)?.[1] ?? 0]);
  const at = (loop: number) => {
    const index = points.findIndex(([m]) => m >= loop);
    if (index <= 0) return points[0]?.[1] ?? 0;
    const [m0, t0] = points[index - 1] as [number, number],
      [m1, t1] = points[index] as [number, number];
    return m1 > m0 ? t0 + ((loop - m0) / (m1 - m0)) * (t1 - t0) : t1;
  };
  return { duration: ms, speed, at };
}
