export type SectionId =
  | 'fleet'
  | 'rounds'
  | 'missions'
  | 'routes'
  | 'continuity'
  | 'audit'
  | 'devices';

export interface SectionInfo {
  readonly id: SectionId;
  readonly title: string;
  readonly summary: string;
  /** Rounds, routes and continuity keep their records in PostgreSQL; credentials are for administrators. */
  readonly needs?: 'durable' | 'admin';
}

export const sections: readonly SectionInfo[] = [
  {
    id: 'fleet',
    title: 'Fleet',
    summary: 'Every registered body with its heartbeat, battery and last reported pose.',
  },
  {
    id: 'rounds',
    title: 'Rounds',
    summary:
      'Review a whole inspection objective, approve it once, and decide what happens to held work.',
    needs: 'durable',
  },
  {
    id: 'missions',
    title: 'Missions',
    summary: 'Turn a request into a reviewed command, approve it, and follow it to its evidence.',
  },
  {
    id: 'routes',
    title: 'Routes',
    summary: 'Plan routes by capability, record route conditions and review replans.',
    needs: 'durable',
  },
  {
    id: 'continuity',
    title: 'Continuity',
    summary: 'What the fleet has seen, and reviewed handoffs between bodies.',
    needs: 'durable',
  },
  {
    id: 'audit',
    title: 'Audit',
    summary: 'Recent decisions, who made them and when.',
  },
  {
    id: 'devices',
    title: 'Devices',
    summary: 'The credential each body uses to connect, issued and revoked here.',
    needs: 'admin',
  },
];

export function availableSections(durable: boolean, admin: boolean): readonly SectionInfo[] {
  return sections.filter(
    (section) =>
      section.needs === undefined ||
      (section.needs === 'durable' && durable) ||
      (section.needs === 'admin' && admin),
  );
}
