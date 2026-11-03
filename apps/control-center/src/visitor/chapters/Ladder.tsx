import type { CSSProperties } from 'react';

export interface Rung {
  readonly name: string;
  /** Conditions in series, each true (closed) or false (open) at the moment shown. */
  readonly contacts: readonly { readonly label: string; readonly closed: boolean }[];
  readonly coil: string;
  /** Orange hatching marks a coil that holds work for review. */
  readonly hold?: boolean;
}

const contactSymbol = (
  <svg viewBox="0 0 40 28" aria-hidden="true">
    <rect x="13" y="3" width="14" height="22" />
    <path d="M13 2v24M27 2v24" />
  </svg>
);
const coilSymbol = (
  <svg viewBox="0 0 40 28" aria-hidden="true">
    <rect x="11" y="3" width="18" height="22" />
    <path
      className="hatch"
      d="M11 9l6-6M11 15l12-12M11 21l18-18M13 25l16-16M19 25l10-10M25 25l4-4"
    />
    <path d="M16 3a15 15 0 0 0 0 22M24 3a15 15 0 0 1 0 22" />
  </svg>
);

/**
 * An interlock as a ladder diagram: power flows from the left rail through each closed contact and
 * energises the coil only when every condition in its rung holds. Live wire is drawn green and heavy.
 */
export function Ladder({
  rungs,
  label,
}: {
  readonly rungs: readonly Rung[];
  readonly label: string;
}) {
  return (
    <ol
      className="ladder"
      aria-label={label}
      style={{ '--cols': Math.max(...rungs.map((rung) => rung.contacts.length)) } as CSSProperties}
    >
      {rungs.map((rung, r) => {
        const live = rung.contacts.map((_, i) => rung.contacts.slice(0, i).every((c) => c.closed));
        const on = rung.contacts.every((c) => c.closed);
        return (
          <li key={rung.name}>
            <p className="rung-name">
              <span className="figures">{r + 1}</span> {rung.name}
            </p>
            <ul data-on={on ? '' : undefined}>
              {rung.contacts.map((contact, i) => (
                <li
                  key={contact.label}
                  className="contact"
                  style={{ '--i': i } as CSSProperties}
                  data-in={live[i] ? '' : undefined}
                  data-out={live[i] && contact.closed ? '' : undefined}
                  data-closed={contact.closed ? '' : undefined}
                >
                  {contactSymbol}
                  {contact.label}
                  <span className="visually-hidden">{contact.closed ? ': true' : ': false'}</span>
                </li>
              ))}
              <li
                className="coil"
                style={{ '--i': rung.contacts.length } as CSSProperties}
                data-in={on ? '' : undefined}
                data-out={on ? '' : undefined}
                data-hold={rung.hold ? '' : undefined}
              >
                {coilSymbol}
                {rung.coil}
                <span className="visually-hidden">{on ? ': on' : ': off'}</span>
              </li>
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
