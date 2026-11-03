import { minutes } from '../format';
import { type Cue, living, type Script, type Step } from './director';
import { along, type Point, sampleAt } from './geometry';
import { deg, placed, polyline, type View, wedge } from './layout';

export interface PlayOptions {
  readonly id: string;
  /** Read every frame, so pausing never restarts the drawing. */
  readonly paused: { readonly current: boolean };
  readonly onCue: (cue: Cue) => void;
  /** After the script, keep replaying the recorded run. */
  readonly live: boolean;
}

const clamp = (p: number) => Math.min(1, Math.max(0, p));
const all = (root: Element, selector: string) => [...root.querySelectorAll<SVGElement>(selector)];
const TRAIL = 6;

/** A body glyph at a share of its path, turned to the heading recorded there (bodies can reverse). */
const facing = (track: View['tracks'][number], share: number) => {
  const at = along(track.points, track.lengths, share * track.total);
  return placed(at, -deg(track.poses[at.index]?.yaw ?? 0));
};

/** The beam, its fan and the afterglow on the returns, at map angle `angle` (or hidden). */
function beam(root: SVGSVGElement, view: View, id: string, angle: number | null) {
  const scan = view.scan;
  const group = root.querySelector<SVGGElement>('[data-beam]');
  const glow = root.querySelector<SVGElement>('[data-glow]');
  const clip = root.querySelector<SVGPathElement>(`#${id}-glow path`);
  if (!scan || !group || !glow || !clip) return;
  if (angle === null) {
    group.style.opacity = '0';
    glow.style.opacity = '0';
    return;
  }
  group.style.opacity = '1';
  glow.style.opacity = '1';
  group.setAttribute('transform', `rotate(${-deg(angle)} ${scan.origin.x} ${scan.origin.y})`);
  clip.setAttribute('d', wedge(scan.origin, angle - 0.8, 0.8, scan.reach + 30));
}

/**
 * Runs a script on the drawing, then (in `live` mode) loops the recorded run. The clock only
 * advances while the drawing is on screen and not paused; a long gap, such as a background tab,
 * resumes where it left off. Returns a cleanup that restores the finished, static drawing.
 */
export function play(root: SVGSVGElement, view: View, script: Script, options: PlayOptions) {
  const nodes = new Map<string, SVGElement[]>();
  const get = (key: string) => {
    let list = nodes.get(key);
    if (!list) {
      list = all(root, `[data-k="${key}"]`);
      nodes.set(key, list);
    }
    return list;
  };
  const sweep = root.querySelector<SVGPathElement>(`#${options.id}-sweep path`);
  const sweepFull = sweep?.getAttribute('d') ?? '';
  const glyphs = all(root, '[data-glyph]');
  const head = root.querySelector<SVGGElement>('[data-head]');
  const fronts = new Map(
    all(root, '[data-front]').map((node) => [Number(node.dataset.front), node] as const),
  );

  // The pen's path: each stroke it draws, and straight pen-up moves between close strokes.
  const strokes = script.steps
    .filter((step) => step.kind === 'pen' && step.head)
    .map((step) => {
      const path = get(step.key)[0] as SVGGeometryElement | undefined;
      const length = path?.getTotalLength() ?? 0;
      const point = (p: number): Point => {
        const at = path?.getPointAtLength(length * (step.reverse ? 1 - p : p));
        return { x: at?.x ?? 0, y: at?.y ?? 0 };
      };
      return { step, point, from: point(0), to: point(1) };
    })
    .sort((a, b) => a.step.start - b.step.start);
  const pen = (clock: number): Point | null => {
    for (let i = 0; i < strokes.length; i++) {
      const stroke = strokes[i];
      if (!stroke) continue;
      const { step } = stroke;
      if (clock >= step.start && clock <= step.end)
        return stroke.point(clamp((clock - step.start) / (step.end - step.start || 1)));
      const next = strokes[i + 1];
      if (next && clock > step.end && clock < next.step.start && next.step.start - step.end < 600) {
        const s = (clock - step.end) / (next.step.start - step.end);
        const e = s * s * (3 - 2 * s);
        return {
          x: stroke.to.x + (next.from.x - stroke.to.x) * e,
          y: stroke.to.y + (next.from.y - stroke.to.y) * e,
        };
      }
    }
    return null;
  };

  const apply = (step: Step, p: number) => {
    const list = get(step.key);
    switch (step.kind) {
      case 'fade':
        for (const node of list) node.style.opacity = String(p);
        break;
      case 'pen':
        if (!step.ghost)
          for (const node of list)
            node.style.strokeDashoffset = String(step.reverse ? p - 1 : 1 - p);
        break;
      case 'probe': {
        for (const node of list) {
          node.style.opacity = p > 0 ? '1' : '0';
          node.style.strokeDashoffset = String(1 - p);
        }
        const lane = view.lanes[step.index ?? -1];
        const front = fronts.get(step.index ?? -1);
        if (lane && front) {
          front.style.opacity = p > 0 && p < 1 ? '1' : '0';
          front.setAttribute('cx', String(lane.a.x + (lane.c.x - lane.a.x) * p));
          front.setAttribute('cy', String(lane.a.y + (lane.c.y - lane.a.y) * p));
        }
        break;
      }
      case 'pulse':
        for (const node of list) {
          node.style.opacity = p > 0 && p < 1 ? String(1 - p) : '0';
          node.style.transform = `scale(${0.3 + p * 1.7})`;
        }
        break;
      case 'flash':
        for (const node of list)
          node.style.opacity = p > 0 && p < 1 ? String(Math.sin(p * Math.PI)) : '0';
        break;
      case 'sweep':
        if (sweep && view.scan) {
          sweep.setAttribute(
            'd',
            p >= 1 ? sweepFull : wedge(view.scan.origin, view.scan.start, p * 2 * Math.PI),
          );
          beam(root, view, options.id, p > 0 && p < 1 ? view.scan.start + p * 2 * Math.PI : null);
        }
        break;
      case 'track': {
        for (const node of list) node.style.strokeDashoffset = String(1 - p);
        const track = view.tracks[step.index ?? -1];
        if (track) glyphs[step.index ?? -1]?.setAttribute('transform', facing(track, p));
        break;
      }
    }
  };

  const restore = () => {
    delete root.dataset.plotting;
    delete root.dataset.living;
    for (const list of nodes.values())
      for (const node of list)
        for (const property of ['opacity', 'stroke-dashoffset', 'transform'])
          node.style.removeProperty(property);
    for (const node of [
      ...fronts.values(),
      ...all(root, '[data-pulse-mark]'),
      ...all(root, '[data-clock]'),
    ])
      node.style.removeProperty('opacity');
    for (const trail of all(root, '[data-trail]')) trail.setAttribute('d', '');
    head?.style.removeProperty('opacity');
    sweep?.setAttribute('d', sweepFull);
    beam(root, view, options.id, null);
    view.tracks.forEach((track, i) => {
      glyphs[i]?.setAttribute('transform', facing(track, 1));
    });
  };

  // The recorded run as a loop, once the script has finished.
  const loop = options.live ? living(view) : null;
  const trails = view.tracks.map((_, i) => all(root, `[data-trail^="${i}-"]`));
  const clock = root.querySelector<SVGTextElement>('[data-clock-time]');
  const clockLabel = root.querySelector<SVGTextElement>('[data-clock-speed]');
  const markPulses = all(root, '[data-pulse-mark]');
  let previous = Number.NEGATIVE_INFINITY;
  let scanAt: number | null = null;
  const pulses = new Map<SVGElement, number>();
  const stop = view.marks.find((mark) => mark.kind === 'stop' && mark.track === 0);
  const live = (elapsed: number, now: number) => {
    if (!loop) return;
    const t = loop.at(elapsed % loop.duration);
    if (t < previous) previous = Number.NEGATIVE_INFINITY;
    view.tracks.forEach((track, i) => {
      const pose = sampleAt(track.live, t);
      if (!pose) return;
      glyphs[i]?.setAttribute('transform', placed(pose, -deg(pose.yaw)));
      // A fading trail over the last moments of motion, oldest segment faintest.
      const window = 1.8 * loop.speed;
      const recent = [
        ...track.live.filter((sample) => sample.t > t - window && sample.t < t),
        pose,
      ];
      const pieces = trails[i] ?? [];
      pieces.forEach((piece, j) => {
        const from = t - window + (j * window) / TRAIL,
          to = t - window + ((j + 1) * window) / TRAIL;
        const first = recent.findIndex((sample) => sample.t >= from);
        const part = recent.filter((sample) => sample.t >= from && sample.t <= to);
        // Start each piece where the previous one ended, so the trail has no gaps.
        const joint = first > 0 ? recent[first - 1] : undefined;
        if (joint) part.unshift(joint);
        piece.setAttribute('d', part.length > 1 ? polyline(part) : '');
      });
    });
    view.marks.forEach((mark, m) => {
      const node = markPulses[m];
      if (node && previous < mark.t && mark.t <= t) pulses.set(node, now);
    });
    if (stop && view.scan && previous < stop.t && stop.t <= t) scanAt = now;
    previous = t;
    for (const [node, start] of pulses) {
      const p = (now - start) / 700;
      node.style.opacity = p < 1 ? String(1 - p) : '0';
      node.style.transform = `scale(${0.4 + p * 1.6})`;
      if (p >= 1) pulses.delete(node);
    }
    if (scanAt !== null && view.scan) {
      const p = (now - scanAt) / 1100;
      beam(root, view, options.id, p < 1 ? view.scan.start + p * 2 * Math.PI : null);
      if (p >= 1) scanAt = null;
    }
    if (clock) clock.textContent = minutes(t);
  };

  root.dataset.plotting = '';
  for (const step of script.steps) apply(step, 0);
  const fired = new Set<number>();
  let elapsed = 0,
    last = performance.now(),
    visible = true,
    frame = 0,
    looping = false;
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
  });
  observer.observe(root);
  const tick = (now: number) => {
    // A cue whose moment arrives while scrolled away still fires, so headline text never stays hidden.
    if (visible && !options.paused.current) elapsed += Math.min(50, now - last);
    last = now;
    if (!looping) {
      for (const step of script.steps)
        apply(step, clamp((elapsed - step.start) / (step.end - step.start || 1)));
      script.cues.forEach((cue, i) => {
        if (!fired.has(i) && elapsed >= cue.at) {
          fired.add(i);
          options.onCue(cue.cue);
        }
      });
      const point = pen(elapsed);
      if (head) {
        head.style.opacity = point ? '1' : '0';
        if (point) head.setAttribute('transform', `translate(${point.x} ${point.y})`);
      }
      if (elapsed >= script.end) {
        for (const cue of script.cues) options.onCue(cue.cue);
        restore();
        if (!loop) return;
        looping = true;
        root.dataset.living = '';
        for (const node of all(root, '[data-clock]')) node.style.opacity = '1';
        if (clockLabel) clockLabel.textContent = `Recorded run at ${Math.round(loop.speed)}×`;
        elapsed = 0;
      }
    } else if (visible && !options.paused.current) live(elapsed, now);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    restore();
  };
}

/** Retracts everything drawn on top of the walls, then calls `done`. */
export function erase(root: SVGSVGElement, done: () => void) {
  const pens = all(root, '[data-pen]');
  const fades = all(root, '[data-k]').filter(
    (node) => !node.hasAttribute('data-pen') && !['solid', 'grid'].includes(node.dataset.k ?? ''),
  );
  const glyphs = all(root, '[data-glyph], [data-trail], [data-clock]');
  root.dataset.plotting = '';
  const start = performance.now();
  let frame = 0;
  const tick = (now: number) => {
    const p = clamp((now - start) / 380);
    const e = p * p;
    for (const node of pens) node.style.strokeDashoffset = String(e);
    for (const node of [...fades, ...glyphs]) node.style.opacity = String(1 - clamp(p * 1.6));
    if (p < 1) frame = requestAnimationFrame(tick);
    else done();
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    delete root.dataset.plotting;
    for (const node of [...pens, ...fades, ...glyphs]) {
      node.style.removeProperty('opacity');
      node.style.removeProperty('stroke-dashoffset');
    }
  };
}
