import type { ReactNode } from 'react';

export interface SheetStep {
  readonly title: string;
  readonly command?: unknown;
  /** A sentence under the title, for steps described rather than given as a command. */
  readonly text?: ReactNode;
  /** The last column: a failure policy, an assignment or a status. */
  readonly detail: ReactNode;
  /** Marks the step whose failure the round is allowed to continue past. */
  readonly continues?: boolean;
  /** A step already completed, kept on the sheet as a record. */
  readonly done?: boolean;
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
  columns = ['Step', 'Operation and command', 'If it fails'],
  steps,
  block,
  notes = [],
}: {
  readonly caption: string;
  readonly columns?: readonly [string, string, string];
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
            {columns.map((column) => (
              <th scope="col" key={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {steps.map((step, index) => (
            <tr
              key={step.title}
              data-continues={step.continues ? '' : undefined}
              data-done={step.done ? '' : undefined}
            >
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
                {step.text && <p>{step.text}</p>}
                {step.command !== undefined && (
                  <code>{JSON.stringify(step.command, null, 1).replace(/\n\s*/g, ' ')}</code>
                )}
              </td>
              <td>{step.detail}</td>
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

/** Capability identifiers a segment requires, as the planner names them. */
export function Capabilities({ list }: { readonly list: readonly string[] }) {
  return (
    <>
      Requires{' '}
      {list.map((capability, index) => (
        <span key={capability}>
          {index ? ' and ' : ''}
          <code>{capability}</code>
        </span>
      ))}
    </>
  );
}
