import type { ReactNode } from 'react';

export interface SheetStep {
  readonly title: string;
  readonly command: unknown;
  /** What the reviewed plan does if this step fails. */
  readonly policy: string;
  /** Marks the step whose failure the round is allowed to continue past. */
  readonly continues?: boolean;
  /** Number of the sheet note that applies to this step. */
  readonly note?: number;
}

/** Engineering title block: labelled cells ruled with hairlines. A `wide` cell spans the block. */
export function TitleBlock({
  cells,
}: {
  readonly cells: readonly (readonly [string, ReactNode, 'wide'?])[];
}) {
  return (
    <dl className="title-block">
      {cells.map(([term, value, wide]) => (
        <div key={term} className={wide}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The reviewed round as a route sheet: each step, its command and its failure policy. */
export function RouteSheet({
  caption,
  steps,
  block,
  notes = [],
}: {
  readonly caption: string;
  readonly steps: readonly SheetStep[];
  readonly block: readonly (readonly [string, ReactNode, 'wide'?])[];
  readonly notes?: readonly ReactNode[];
}) {
  return (
    <div className="plate sheet">
      <table className="route-sheet">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Operation and command</th>
            <th scope="col">If it fails</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step, index) => (
            <tr key={step.title} data-continues={step.continues ? '' : undefined}>
              <td className="figures">{index + 1}</td>
              <td>
                <strong>
                  {step.title}
                  {step.note && (
                    <a href={`#sheet-note-${step.note}`} className="note-mark">
                      <span className="visually-hidden">see note </span>
                      {step.note}
                    </a>
                  )}
                </strong>
                <code>{JSON.stringify(step.command, null, 1).replace(/\n\s*/g, ' ')}</code>
              </td>
              <td>{step.policy}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <TitleBlock cells={block} />
      {notes.length > 0 && (
        <ol className="sheet-notes">
          {notes.map((note, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: notes are fixed copy; the index is the note's number.
            <li key={index} id={`sheet-note-${index + 1}`}>
              {note}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
