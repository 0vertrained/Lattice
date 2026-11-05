import { useId } from 'react';
import type { Lamp, LampState } from './lamps';

/** An indicator lamp: a bezel around a lens that is lit in a signal colour, hatched when held, or dark. */
export function LampGlyph({ state }: { readonly state: LampState }) {
  // A pattern id usable inside url(); React's ids carry punctuation.
  const hatch = `lamp${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg className={`lamp-glyph lamp-${state}`} viewBox="0 0 16 16" aria-hidden="true">
      {state === 'hold' && (
        <defs>
          <pattern
            id={hatch}
            width="2.5"
            height="2.5"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect className="lamp-hatch" width="1.4" height="2.5" />
          </pattern>
        </defs>
      )}
      <circle className="lamp-bezel" cx="8" cy="8" r="7" />
      <circle
        className="lamp-lens"
        cx="8"
        cy="8"
        r="4.5"
        fill={state === 'hold' ? `url(#${hatch})` : undefined}
      />
      {(state === 'clear' || state === 'stop') && (
        <path className="lamp-glint" d="M5.4 6.4a3 3 0 0 1 2.2-2" />
      )}
    </svg>
  );
}

export function StatusLamps({ lamps }: { readonly lamps: readonly Lamp[] }) {
  return (
    <ul className="lamps" aria-label="Core status">
      {lamps.map((lamp) => (
        <li key={lamp.name} data-state={lamp.state}>
          <LampGlyph state={lamp.state} />
          <span className="lamp-name">{lamp.name}</span>
          <span className="lamp-text">
            {lamp.text}
            {lamp.code !== undefined && <code>{lamp.code}</code>}
          </span>
        </li>
      ))}
    </ul>
  );
}
