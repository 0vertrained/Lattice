/** The trace shows the last 30 seconds of heartbeats. */
export const WINDOW_MS = 30_000;
/** The core marks a body offline after 10 seconds without a heartbeat by default; the trace flattens then too. */
export const LATE_MS = 10_000;
const KEEP = 24;

/** Adds the latest reported heartbeat time unless it is already the newest one seen; keeps a short history. */
export function recordBeat(beats: readonly number[], lastSeen: number): readonly number[] {
  if (!Number.isFinite(lastSeen) || beats.at(-1) === lastSeen) return beats;
  if (beats.length > 0 && lastSeen < (beats.at(-1) ?? 0)) return beats;
  return [...beats, lastSeen].slice(-KEEP);
}

/** How old the newest report is, never negative when the core's clock runs slightly ahead. */
export const ageOf = (lastSeen: number, now: number) => Math.max(0, now - lastSeen);

export function ageText(ms: number): string {
  if (ms < 2_000) return 'Just now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min ago`;
}

const BASE = 30;
/**
 * An oscilloscope-style path: flat at the baseline, with a beat drawn wherever a heartbeat arrived.
 * `live` ends at the newest beat; the flat line from there to now is drawn separately, dashed when late.
 */
export function tracePath(
  beats: readonly number[],
  now: number,
  width: number,
): { readonly live: string; readonly tail: { readonly from: number; readonly to: number } | null } {
  const scale = width / WINDOW_MS;
  const xs = beats.map((t) => width - (now - t) * scale).filter((x) => x > -8 && x <= width + 0.5);
  if (xs.length === 0) return { live: '', tail: beats.length > 0 ? { from: 0, to: width } : null };
  let d = `M0 ${BASE}`;
  for (const x of xs) {
    const r = (n: number) => Math.round(n * 10) / 10;
    d += `H${r(x - 4)}L${r(x - 2)} ${BASE - 18}L${r(x + 1)} ${BASE + 7}L${r(x + 3)} ${BASE}`;
  }
  const last = Math.min(width, (xs.at(-1) ?? 0) + 3);
  return { live: d, tail: last < width ? { from: last, to: width } : null };
}
