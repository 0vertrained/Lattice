import type { ReactNode } from 'react';
import { TitleBlock } from './RouteSheet';

// Recorded camera frames are 320 × 240; detection boxes are [x, y, width, height] in frame pixels.
const W = 320;
const H = 240;
const GAP = 24;

/** A dimension line with oblique ticks, broken in the middle for its value. */
function Dimension({
  from,
  to,
  at,
  vertical = false,
  text,
  className,
}: {
  readonly from: number;
  readonly to: number;
  readonly at: number;
  readonly vertical?: boolean;
  readonly text: string;
  readonly className: string;
}) {
  const mid = (from + to) / 2;
  const half = Math.min(GAP, (to - from) / 2 - 4);
  const p = (u: number, v: number) => (vertical ? `${v} ${u}` : `${u} ${v}`);
  const tick = (u: number) => (vertical ? `M${at - 4} ${u + 4}l8 -8` : `M${u - 4} ${at + 4}l8 -8`);
  return (
    <g className={className}>
      <path
        d={`M${p(from, at)}L${p(mid - half, at)}M${p(mid + half, at)}L${p(to, at)}${tick(from)}${tick(to)}`}
      />
      <text
        x={vertical ? at : mid}
        y={vertical ? mid : at}
        dy="0.35em"
        transform={vertical ? `rotate(-90 ${at} ${mid})` : undefined}
      >
        {text}
      </text>
    </g>
  );
}

/** Extension lines from a frame edge out to a dimension line, dashed where they cross the image. */
function Extension({ d, over }: { readonly d: string; readonly over?: string }) {
  return (
    <>
      {over && <path className="dim-over" d={over} />}
      <path className="dim-ext" d={d} />
    </>
  );
}

/**
 * A recorded camera image as a plate: the frame and any detection box dimensioned in pixels, and a
 * title block with where it came from. The image already carries the detector's own box and label.
 */
export function EvidencePlate({
  src,
  alt,
  title,
  status,
  found,
  box,
  label,
  block,
  children,
}: {
  readonly src: string;
  readonly alt: string;
  readonly title: string;
  readonly status: string;
  readonly found: boolean;
  readonly box?: readonly number[] | undefined;
  /** A second label beside the status, such as which body took the image. */
  readonly label?: string;
  readonly block: readonly (readonly [string, ReactNode, 'wide'?])[];
  readonly children?: ReactNode;
}) {
  const [x = 0, y = 0, w = 0, h = 0] = box ?? [];
  return (
    <figure className="plate evidence">
      <div className="shot">
        <div>
          <img src={src} width={W} height={H} alt={alt} />
          <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            <Extension d={`M0 ${H + 3}v13M${W} ${H + 3}v13M-3 0h-13M-3 ${H}h-13`} />
            <Dimension className="dim-frame" from={0} to={W} at={H + 12} text={`${W} px`} />
            <Dimension className="dim-frame" from={0} to={H} at={-12} vertical text={`${H} px`} />
            {box && (
              <>
                <Extension
                  over={`M${x} ${y - 2}V0M${x + w} ${y - 2}V0M${x + w + 2} ${y}H${W}M${x + w + 2} ${y + h}H${W}`}
                  d={`M${x} -3v-13M${x + w} -3v-13M${W + 3} ${y}h13M${W + 3} ${y + h}h13`}
                />
                <Dimension className="dim-box" from={x} to={x + w} at={-12} text={`${w} px`} />
                <Dimension
                  className="dim-box"
                  from={y}
                  to={y + h}
                  at={W + 12}
                  vertical
                  text={`${h} px`}
                />
              </>
            )}
          </svg>
        </div>
      </div>
      <figcaption>
        <div className="camera-label">
          <span className={found ? 'success' : 'anomaly'}>{status}</span>
          {label && <span>{label}</span>}
        </div>
        <h3>{title}</h3>
        <TitleBlock cells={block} />
        {children}
      </figcaption>
    </figure>
  );
}
