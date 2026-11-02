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
import { AuditPanel } from '../features/audit/AuditPanel';
import { FleetPanel } from '../features/fleet/FleetPanel';
import { MissionComposer } from '../features/missions/MissionComposer';
import { MissionList } from '../features/missions/MissionList';

const DigitalTwin = lazy(() =>
  import('../features/digital-twin/DigitalTwin').then((module) => ({
    default: module.DigitalTwin,
  })),
);

export function App() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking');
  const [connectionError, setConnectionError] = useState('');

  const bodiesQuery = useBodies(connected);
  const missionsQuery = useMissions(connected);
  const auditQuery = useAudit(connected);
  const reassign = useReassignUnavailable();

  useEffect(() => {
    let active = true;
    apiClient
      .health()
      .then((online) => {
        if (active) setHealth(online ? 'online' : 'offline');
      })
      .catch(() => {
        if (active) setHealth('offline');
      });
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
      setConnected(true);
    } catch (error) {
      apiClient.clearApiKey();
      setConnectionError(error instanceof Error ? error.message : 'Unable to authenticate.');
    }
  }

  function disconnect(): void {
    apiClient.clearApiKey();
    setConnected(false);
    setApiKey('');
    queryClient.removeQueries({ queryKey: queryKeys.bodies });
    queryClient.removeQueries({ queryKey: queryKeys.missions });
    queryClient.removeQueries({ queryKey: queryKeys.audit });
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
          <small>The key remains in memory only and is cleared on reload.</small>
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
            disabled={reassign.isPending}
            onClick={() => reassign.mutate()}
          >
            Reassign unavailable
          </button>
          <button type="button" className="ghost" onClick={disconnect}>
            Disconnect
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

      <div className="dashboard-grid">
        <Suspense
          fallback={
            <section className="panel digital-twin twin-loading">Loading 3D viewport…</section>
          }
        >
          <DigitalTwin bodies={bodies} />
        </Suspense>
        <MissionComposer onCreated={() => missionsQuery.refetch()} />
        <FleetPanel bodies={bodies} loading={bodiesQuery.isLoading} />
        <MissionList missions={missions} bodies={bodies} />
        <AuditPanel records={audit} />
      </div>
    </main>
  );
}
