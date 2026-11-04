import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useBodies, useMissions } from '../core/api/queries';
import type { Body, Mission } from '../core/api/schemas';
import type { AuthConfig } from '../core/auth/oidc';
import { useRounds } from '../features/missions/rounds';
import { LatticeMark } from '../ink/LatticeMark';
import { ThemeToggle } from '../ink/ThemeToggle';
import type { Identity } from './App';
import { bodiesLamp, coreLamp, databaseLamp } from './lamps';
import { StatusLamps } from './StatusLamps';
import { availableSections, type SectionId } from './sections';
import { FleetSection } from './sections/FleetSection';
import { useCoreStatus } from './useCoreStatus';
import { useSection } from './useSection';

// Only the fleet ships with the console; each other section loads the first time it is opened.
const RoundsSection = lazy(() => import('./sections/RoundsSection'));
const MissionsSection = lazy(() => import('./sections/MissionsSection'));
const RoutesSection = lazy(() => import('./sections/RoutesSection'));
const ContinuitySection = lazy(() => import('./sections/ContinuitySection'));
const AuditSection = lazy(() => import('./sections/AuditSection'));
const DevicesSection = lazy(() => import('./sections/DevicesSection'));

export interface SectionProps {
  readonly bodies: readonly Body[];
  readonly bodiesLoading: boolean;
  readonly missions: readonly Mission[];
  readonly canOperate: boolean;
}

function SectionContent({ id, ...props }: SectionProps & { readonly id: SectionId }) {
  switch (id) {
    case 'fleet':
      return <FleetSection {...props} />;
    case 'rounds':
      return <RoundsSection {...props} />;
    case 'missions':
      return <MissionsSection {...props} />;
    case 'routes':
      return <RoutesSection {...props} />;
    case 'continuity':
      return <ContinuitySection {...props} />;
    case 'audit':
      return <AuditSection />;
    case 'devices':
      return <DevicesSection />;
  }
}

const roleNames = { admin: 'Administrator', operator: 'Operator', viewer: 'Viewer' } as const;

export function Shell({
  mode,
  durable,
  identity,
  onSignOut,
}: {
  readonly mode: AuthConfig['mode'];
  readonly durable: boolean;
  readonly identity: Identity;
  readonly onSignOut: () => void;
}) {
  const admin = identity.roles.includes('admin');
  const canOperate = admin || identity.roles.includes('operator');
  const available = availableSections(durable, admin);
  const { current, moved } = useSection(available.map((section) => section.id));
  // Opened sections stay mounted while hidden, so a review in progress survives a look elsewhere.
  const [opened, setOpened] = useState<ReadonlySet<SectionId>>(() => new Set([current]));
  // The open section renders in the same pass that opens it, so focus can move to its heading.
  const shown = opened.has(current) ? opened : new Set([...opened, current]);
  useEffect(() => {
    setOpened((sections) => (sections.has(current) ? sections : new Set([...sections, current])));
  }, [current]);
  const headings = useRef(new Map<SectionId, HTMLHeadingElement>());
  useEffect(() => {
    if (moved === 0) return;
    window.scrollTo({ top: 0 });
    headings.current.get(current)?.focus();
  }, [moved, current]);

  const bodiesQuery = useBodies(true);
  const missionsQuery = useMissions(true);
  const rounds = useRounds(durable, 5_000);
  const core = useCoreStatus(true);
  const bodies = bodiesQuery.data ?? [];
  const missions = missionsQuery.data ?? [];
  const counts = useMemo(
    () => ({
      online: bodies.filter((body) => body.status === 'online').length,
      active: missions.filter((mission) =>
        ['assigned', 'running', 'interrupted'].includes(mission.status),
      ).length,
      held: (rounds.data ?? []).filter((round) => round.status === 'recovery_required').length,
    }),
    [bodies, missions, rounds.data],
  );
  const failure = bodiesQuery.error ?? missionsQuery.error;
  const role = admin ? roleNames.admin : canOperate ? roleNames.operator : roleNames.viewer;
  const props: SectionProps = {
    bodies,
    bodiesLoading: bodiesQuery.isLoading,
    missions,
    canOperate,
  };

  return (
    <div className="console">
      <a className="skip-link" href="#console-main">
        Skip to the open section
      </a>
      <header className="console-header">
        <div className="brand">
          <LatticeMark />
          <span>Lattice</span>
        </div>
        <StatusLamps lamps={[coreLamp(core), databaseLamp(core, durable), bodiesLamp(bodies)]} />
        <div className="console-account">
          <span className="account-role">{mode === 'oidc' ? role : 'Development key'}</span>
          <ThemeToggle />
          <button type="button" className="button quiet" onClick={onSignOut}>
            {mode === 'oidc' ? 'Sign out' : 'Disconnect'}
          </button>
        </div>
      </header>
      <div className="console-body">
        <nav className="rail" aria-label="Console sections">
          <ul>
            {available.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  aria-current={section.id === current ? 'page' : undefined}
                >
                  {section.title}
                  {section.id === 'fleet' && bodies.length > 0 && (
                    <small className="rail-count">
                      <span aria-hidden="true">
                        {counts.online}/{bodies.length}
                      </span>
                      <span className="visually-hidden">
                        , {counts.online} of {bodies.length} bodies online
                      </span>
                    </small>
                  )}
                  {section.id === 'rounds' && counts.held > 0 && (
                    <small className="rail-count rail-held">
                      <span className="visually-hidden">, </span>
                      {counts.held} held
                    </small>
                  )}
                  {section.id === 'missions' && counts.active > 0 && (
                    <small className="rail-count">
                      <span className="visually-hidden">, </span>
                      {counts.active} active
                    </small>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main id="console-main" className="console-main">
          {failure && (
            <p className="console-alert" role="alert">
              {failure instanceof Error ? failure.message : 'The fleet could not be refreshed.'}
            </p>
          )}
          {available.map(
            (section) =>
              shown.has(section.id) && (
                <section
                  key={section.id}
                  className={`console-section section-${section.id}`}
                  aria-labelledby={`section-${section.id}`}
                  hidden={section.id !== current}
                >
                  <header className="section-head">
                    <h1
                      id={`section-${section.id}`}
                      tabIndex={-1}
                      ref={(node) => {
                        if (node) headings.current.set(section.id, node);
                        else headings.current.delete(section.id);
                      }}
                    >
                      {section.title}
                    </h1>
                    <p>{section.summary}</p>
                  </header>
                  <Suspense
                    fallback={
                      <p className="section-loading" role="status">
                        Loading {section.title.toLowerCase()}…
                      </p>
                    }
                  >
                    <SectionContent id={section.id} {...props} />
                  </Suspense>
                </section>
              ),
          )}
        </main>
      </div>
    </div>
  );
}
