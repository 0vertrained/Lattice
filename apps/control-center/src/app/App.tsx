import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../core/api/apiClient';
import {
  queryKeys,
  useAudit,
  useBodies,
  useMissions,
  useReassignUnavailable,
} from '../core/api/queries';
import type { AuthConfig } from '../core/auth/oidc';
import { AuditPanel } from '../features/audit/AuditPanel';
import { DevicePanel } from '../features/devices/DevicePanel';
import { FleetPanel } from '../features/fleet/FleetPanel';
import { HandoffPanel } from '../features/handoff/HandoffPanel';
import { ObservationMemory } from '../features/memory/ObservationMemory';
import { InspectionRound } from '../features/missions/InspectionRound';
import { MissionComposer } from '../features/missions/MissionComposer';
import { MissionList } from '../features/missions/MissionList';

const DigitalTwin = lazy(() =>
  import('../features/digital-twin/DigitalTwin').then((module) => ({
    default: module.DigitalTwin,
  })),
);
const RoutePlanner = lazy(() =>
  import('../features/navigation/RoutePlanner').then((module) => ({
    default: module.RoutePlanner,
  })),
);

export function App() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [auth, setAuth] = useState<AuthConfig | null>(null);
  const [identity, setIdentity] = useState<{
    subject: string;
    roles: string[];
    mode: string;
  } | null>(null);
  const canOperate = identity?.roles.some((r) => r === 'operator' || r === 'admin') ?? false;
  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking');
  const [connectionError, setConnectionError] = useState('');

  const bodiesQuery = useBodies(connected);
  const missionsQuery = useMissions(connected);
  const auditQuery = useAudit(connected);
  const reassign = useReassignUnavailable();

  useEffect(() => {
    let active = true;
    async function initialize(): Promise<void> {
      try {
        const response = await fetch('/api/v1/auth/config', { cache: 'no-store' });
        if (!response.ok) throw new Error('Control plane is unavailable.');
        const config = (await response.json()) as AuthConfig;
        if (!active) return;
        setAuth(config);
        setHealth('online');
        if (
          config.mode === 'oidc' &&
          (await (await import('../core/auth/oidc')).initialize(config))
        ) {
          const user = await apiClient.identity();
          if (active) {
            setIdentity(user);
            setConnected(true);
          }
        }
      } catch (error) {
        if (active) {
          setHealth('offline');
          setConnectionError(error instanceof Error ? error.message : 'Sign-in failed.');
        }
      }
    }
    void initialize();
    return () => {
      active = false;
    };
  }, []);

  const bodies = bodiesQuery.data ?? [];
  const missions = missionsQuery.data ?? [];
  const audit = auditQuery.data ?? [];

  const metrics = useMemo(
    () => ({
      online: bodies.filter((body) => body.status === 'online').length,
      active: missions.filter((mission) =>
        ['assigned', 'running', 'interrupted'].includes(mission.status),
      ).length,
      completed: missions.filter((mission) => mission.status === 'succeeded').length,
    }),
    [bodies, missions],
  );

  async function connect(): Promise<void> {
    setConnectionError('');
    if (apiKey.trim().length < 32) {
      setConnectionError('The development API key must contain at least 32 characters.');
      return;
    }
    apiClient.setApiKey(apiKey);
    try {
      await Promise.all([apiClient.listBodies(), apiClient.listMissions()]);
      setIdentity(await apiClient.identity());
      setConnected(true);
    } catch (error) {
      apiClient.clearApiKey();
      setConnectionError(error instanceof Error ? error.message : 'Unable to authenticate.');
    }
  }

  function disconnect(): void {
    apiClient.clearApiKey();
    setConnected(false);
    setIdentity(null);
    if (auth?.mode === 'oidc')
      void import('../core/auth/oidc').then((m) => m.signOut()).catch(() => location.reload());
    setApiKey('');
    queryClient.removeQueries({ queryKey: queryKeys.bodies });
    queryClient.removeQueries({ queryKey: queryKeys.missions });
    queryClient.removeQueries({ queryKey: queryKeys.audit });
    queryClient.removeQueries({ queryKey: ['devices'] });
    queryClient.removeQueries({ queryKey: ['rounds'] });
    queryClient.removeQueries({ queryKey: ['observations'] });
    queryClient.removeQueries({ queryKey: ['last-seen'] });
    queryClient.removeQueries({ queryKey: ['observation-evidence'] });
    queryClient.removeQueries({ queryKey: ['handoffs'] });
    queryClient.removeQueries({ queryKey: ['navigation-map'] });
    queryClient.removeQueries({ queryKey: ['route-plans'] });
    queryClient.removeQueries({ queryKey: ['route-transfer-options'] });
  }

  if (!connected) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="brand-mark" aria-hidden="true">
            L
          </div>
          <p className="eyebrow">Embodiment control plane</p>
          <h1>LATTICE</h1>
          <p>One intelligence. Many bodies.</p>
          <div className={`core-health ${health}`}>
            <span /> Core {health}
          </div>
          {auth?.mode === 'development' && (
            <>
              <label>
                Development API key
                <input
                  type="password"
                  value={apiKey}
                  minLength={32}
                  autoComplete="off"
                  onChange={(event) => setApiKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void connect();
                  }}
                />
              </label>
              <button type="button" onClick={() => void connect()}>
                Connect to local core
              </button>
              <small>Local development mode. The key is cleared on reload.</small>
            </>
          )}
          {auth?.mode === 'oidc' && (
            <>
              <p>
                Sign in through your organization’s identity provider. Your role determines what you
                can view and approve.
              </p>
              <button
                type="button"
                onClick={() => {
                  void import('../core/auth/oidc')
                    .then((m) => m.signIn())
                    .catch((e) =>
                      setConnectionError(e instanceof Error ? e.message : 'Sign-in failed.'),
                    );
                }}
              >
                Sign in
              </button>
            </>
          )}
          <a href="./">Explore the guided warehouse demo</a>
          {connectionError !== '' && (
            <p className="form-error" role="alert">
              {connectionError}
            </p>
          )}
        </section>
      </main>
    );
  }

  const globalError = bodiesQuery.error ?? missionsQuery.error ?? auditQuery.error;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-row">
          <div className="brand-mark small" aria-hidden="true">
            L
          </div>
          <div>
            <h1>LATTICE</h1>
            <p>One intelligence. Many bodies.</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`core-health ${globalError ? 'offline' : 'online'}`}>
            <span /> {globalError ? 'Core unavailable' : 'Core online'}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={reassign.isPending || !canOperate}
            onClick={() => reassign.mutate()}
          >
            Reassign unavailable
          </button>
          <button type="button" className="ghost" onClick={disconnect}>
            {auth?.mode === 'oidc' ? 'Sign out' : 'Disconnect'}
          </button>
        </div>
      </header>

      {globalError !== null && globalError !== undefined && (
        <p className="global-error" role="alert">
          {globalError instanceof Error ? globalError.message : 'Unable to refresh fleet state.'}
        </p>
      )}

      <div className="demo-context">
        <strong>Warehouse simulation</strong>
        <span>Propose → review → approve → navigate → inspect</span>
        <span>Local CPU models · ROS 2 Jazzy · Gazebo</span>
      </div>
      <section className="metrics" aria-label="Lattice metrics">
        <article>
          <span>Registered bodies</span>
          <strong>{bodies.length}</strong>
        </article>
        <article>
          <span>Online bodies</span>
          <strong>{metrics.online}</strong>
        </article>
        <article>
          <span>Active missions</span>
          <strong>{metrics.active}</strong>
        </article>
        <article>
          <span>Completed</span>
          <strong>{metrics.completed}</strong>
        </article>
      </section>

      {auth?.durable && <InspectionRound canOperate={canOperate} />}
      {auth?.durable && (
        <Suspense fallback={<section className="panel">Loading capability route planner…</section>}>
          <RoutePlanner bodies={bodies} canOperate={canOperate} />
        </Suspense>
      )}
      {auth?.durable && (
        <div className="continuity-grid">
          <ObservationMemory bodies={bodies} />
          <HandoffPanel bodies={bodies} missions={missions} canOperate={canOperate} />
        </div>
      )}
      <div className="dashboard-grid">
        <Suspense
          fallback={
            <section className="panel digital-twin twin-loading">Loading 3D viewport…</section>
          }
        >
          <DigitalTwin bodies={bodies} />
        </Suspense>
        {canOperate ? (
          <MissionComposer onCreated={() => missionsQuery.refetch()} />
        ) : (
          <section className="panel">
            <p className="eyebrow">Viewer access</p>
            <h2>Observe the fleet</h2>
            <p>Your account can inspect missions and evidence. An operator approves execution.</p>
          </section>
        )}
        <FleetPanel bodies={bodies} loading={bodiesQuery.isLoading} />
        <MissionList missions={missions} bodies={bodies} canOperate={canOperate} />
        <AuditPanel records={audit} />
        {identity?.roles.includes('admin') && <DevicePanel />}
      </div>
    </main>
  );
}
