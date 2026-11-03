import type { StoryId } from './drawing/scenes';
import { minutes } from './format';

const stations: readonly { id: StoryId; label: string }[] = [
  { id: 'adaptive', label: 'Blocked aisle' },
  { id: 'capability', label: 'Rover to quadruped' },
  { id: 'handoff', label: 'Two-rover handoff' },
  { id: 'single', label: 'Core restart' },
];

/** The recorded stories as stations on one line; the one on screen is filled. */
export function StoryLine({
  current,
  durations,
  onSelect,
}: {
  readonly current: StoryId;
  /** Recording length per available story; stories without a recording are left off the line. */
  readonly durations: Partial<Record<StoryId, number>>;
  readonly onSelect: (story: StoryId) => void;
}) {
  const shown = stations.filter((station) => durations[station.id] !== undefined);
  if (shown.length < 2) return null;
  return (
    <nav id="stories" className="story-line" aria-label="Recorded stories">
      <ul>
        {shown.map((station) => (
          <li key={station.id}>
            <button
              type="button"
              aria-pressed={current === station.id}
              onClick={() => onSelect(station.id)}
            >
              <span>{station.label}</span>
              <span className="figures" aria-hidden="true">
                {minutes(durations[station.id] ?? 0)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
