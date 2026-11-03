import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { AdaptiveRecording } from './adaptiveTypes';
import type { CapabilityRecording } from './capabilityTypes';
import type { Opened } from './chapters/ChapterShell';
import type { StoryId } from './drawing/scenes';
import type { HandoffRecording } from './handoffTypes';
import { SiteHeader } from './SiteHeader';
import { StoryLine } from './StoryLine';
import { type Recordings, StoryOpening } from './StoryOpening';
import type { Walkthrough } from './types';

// Each story's chapters load with the story, so the opening's stylesheet and script stay small.
const SingleStory = lazy(() => import('./SingleStory'));
const HandoffStory = lazy(() => import('./HandoffStory'));
const CapabilityStory = lazy(() => import('./CapabilityStory'));
const AdaptiveStory = lazy(() => import('./AdaptiveStory'));
const source = 'https://github.com/0vertrained/Lattice';

interface Load<T> {
  readonly data: T | null;
  readonly done: boolean;
}
/** Fetches one recording; `accept` returns null for anything that is not a complete, consistent recording. */
function useRecording<T>(
  file: string,
  accept: (value: unknown) => T | null | Promise<T | null>,
): Load<T> {
  const [state, setState] = useState<Load<T>>({ data: null, done: false });
  useEffect(() => {
    const abort = new AbortController();
    fetch(`${import.meta.env.BASE_URL}demo/${file}`, { signal: abort.signal })
      .then(async (response) => (response.ok ? accept(await response.json()) : null))
      .then((data) => {
        if (!abort.signal.aborted) setState({ data, done: true });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ data: null, done: true });
      });
    return () => abort.abort();
  }, [file, accept]);
  return state;
}
const acceptWalkthrough = (value: unknown) => value as Walkthrough;
const acceptHandoff = (value: unknown) => {
  const recording = value as HandoffRecording | null;
  /* This second recording is optional on older deployments. */
  return recording?.schema === 'lattice.handoff.v1' &&
    recording.handoff &&
    Array.isArray(recording.poses) &&
    recording.poses.length > 0 &&
    Array.isArray(recording.observations) &&
    Number.isFinite(recording.duration_s)
    ? recording
    : null;
};
/* The capability scenario appears only when its completed recording is available. */
const acceptCapability = async (value: unknown): Promise<CapabilityRecording | null> => {
  const { capabilityRecordingSchema } = await import('./capabilityTypes');
  const parsed = capabilityRecordingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
/* Only a complete, consistent adaptive recording is offered as a scenario. */
const acceptAdaptive = async (value: unknown): Promise<AdaptiveRecording | null> => {
  const { adaptiveRecordingSchema } = await import('./adaptiveTypes');
  const parsed = adaptiveRecordingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const storyFromHash = (): StoryId =>
  !window.location.hash || window.location.hash === '#adaptive'
    ? 'adaptive'
    : window.location.hash === '#capability'
      ? 'capability'
      : window.location.hash === '#handoff'
        ? 'handoff'
        : 'single';

export function VisitorApp() {
  const single = useRecording('walkthrough.json', acceptWalkthrough);
  const handoff = useRecording('handoff.json', acceptHandoff);
  const capability = useRecording('capability-route.json', acceptCapability);
  const adaptive = useRecording('adaptive-route.json', acceptAdaptive);
  const run = single.data;
  const [story, setStory] = useState<StoryId>(storyFromHash);
  // Set when the visitor chooses a story, so its chapters open at the right one and take focus.
  // A story shown on first load leaves focus where the browser put it.
  const [opened, setOpened] = useState<Opened | null>(null);
  const loads = { single, handoff, capability, adaptive };
  // A story whose recording is still loading keeps its place; one that failed falls back to the single rover.
  const shown: StoryId = loads[story].data || !loads[story].done ? story : 'single';
  const recordings: Recordings = useMemo(
    () => ({
      single: single.data,
      handoff: handoff.data,
      capability: capability.data,
      adaptive: adaptive.data,
    }),
    [single.data, handoff.data, capability.data, adaptive.data],
  );
  const durations = Object.fromEntries(
    Object.entries(recordings).flatMap(([id, recording]) =>
      recording ? [[id, recording.duration_s]] : [],
    ),
  ) as Partial<Record<StoryId, number>>;
  function select(next: StoryId) {
    setStory(next);
    // The page stays put so the opening can redraw for the chosen story.
    setOpened({ chapter: 0, scroll: false });
  }
  return (
    <div className="visitor-app">
      <a className="skip-link" href="#chapter">
        Skip to walkthrough
      </a>
      <SiteHeader source={source} operator={import.meta.env.VITE_OPERATOR_ENABLED !== 'false'} />
      <main>
        <StoryOpening
          story={shown}
          recordings={recordings}
          source={source}
          onExplore={() => {
            setStory('single');
            setOpened({ chapter: 1, scroll: true });
          }}
        />
        {single.done && !run && (
          <p className="visitor-error" role="alert">
            The recorded mission is unavailable.{' '}
            <a href={`${source}/blob/main/docs/VALIDATION.md`}>Read the validation report.</a>
          </p>
        )}
        {!single.done && <p role="status">Loading the recorded inspection round…</p>}
        {run && (
          <>
            <StoryLine current={shown} durations={durations} onSelect={select} />
            {shown === 'adaptive' ? (
              adaptive.data ? (
                <Suspense fallback={<p role="status">Loading the recorded adaptive route…</p>}>
                  <AdaptiveStory run={adaptive.data} opened={opened} />
                </Suspense>
              ) : (
                <p role="status">Loading the recorded adaptive route…</p>
              )
            ) : shown === 'capability' ? (
              capability.data ? (
                <Suspense fallback={<p role="status">Loading the recorded capability route…</p>}>
                  <CapabilityStory run={capability.data} opened={opened} />
                </Suspense>
              ) : (
                <p role="status">Loading the recorded capability route…</p>
              )
            ) : shown === 'handoff' ? (
              handoff.data ? (
                <Suspense
                  fallback={<p role="status">Loading the recorded two-rover continuation…</p>}
                >
                  <HandoffStory run={handoff.data} opened={opened} />
                </Suspense>
              ) : (
                <p role="status">Loading the recorded two-rover continuation…</p>
              )
            ) : (
              <Suspense fallback={<p role="status">Loading the recorded inspection round…</p>}>
                <SingleStory run={run} source={source} opened={opened} />
              </Suspense>
            )}
            <section className="visitor-bottom">
              <p>Built by Rami Martinez</p>
              <h2>From model output to an observable robot outcome.</h2>
              <p>Explore the implementation, measured failures and the decisions behind them.</p>
              <a className="button" href="https://0vertrained.github.io/#lattice">
                Read the portfolio case study
              </a>
            </section>
          </>
        )}
      </main>
      <footer className="visitor-footer">
        <span>Lattice, built on ROS 2 Jazzy, Gazebo Harmonic, Rust and Python.</span>
        <span>Recorded evidence. No tracking.</span>
      </footer>
    </div>
  );
}
