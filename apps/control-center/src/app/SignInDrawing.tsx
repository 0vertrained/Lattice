import { useEffect, useState } from 'react';
import { LatticeDrawing } from '../visitor/drawing/LatticeDrawing';
import { type Scene, singleScene } from '../visitor/drawing/scenes';
import type { Walkthrough } from '../visitor/types';

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The tour's plotted warehouse, from the same recorded walkthrough, so the console reads as one product. */
export default function SignInDrawing() {
  const [scene, setScene] = useState<Scene | null>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`${import.meta.env.BASE_URL}demo/walkthrough.json`, { signal: abort.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as Walkthrough) : null))
      .then((run) => {
        // Without a complete recording the plate stays blank; sign-in never depends on it.
        if (!abort.signal.aborted && Array.isArray(run?.poses) && run.poses.length > 1)
          setScene(singleScene(run));
      })
      .catch(() => {});
    return () => abort.abort();
  }, []);
  return (
    <figure className="plate signin-plate">
      <div className="drawing-frame">
        {scene && (
          <LatticeDrawing
            scene={scene}
            label="The warehouse map plotted from the recorded walkthrough, with the rover running its recorded inspection round"
            mode="plot"
            paused={paused}
            live
          />
        )}
      </div>
      <figcaption>
        <span>Recorded walkthrough, not a live feed.</span>
        {scene && !still() && (
          <button type="button" className="text-button" onClick={() => setPaused(!paused)}>
            {paused ? 'Resume motion' : 'Pause motion'}
          </button>
        )}
      </figcaption>
    </figure>
  );
}
