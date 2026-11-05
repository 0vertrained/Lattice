import '../../features/missions/missions.css';
import { useReassignUnavailable } from '../../core/api/queries';
import { MissionComposer } from '../../features/missions/MissionComposer';
import { MissionList } from '../../features/missions/MissionList';
import type { SectionProps } from '../Shell';

export default function MissionsSection({ bodies, missions, canOperate }: SectionProps) {
  const reassign = useReassignUnavailable();
  return (
    <div className="missions-layout">
      <div className="missions-side">
        {canOperate ? (
          <MissionComposer />
        ) : (
          <section className="panel viewer-note" aria-labelledby="viewer-note-title">
            <h2 id="viewer-note-title">Observe the fleet</h2>
            <p>
              Your account can follow missions and their evidence. An operator approves what the
              fleet does.
            </p>
          </section>
        )}
        {canOperate && (
          <section className="panel reassign" aria-labelledby="reassign-title">
            <h2 id="reassign-title">Unavailable bodies</h2>
            <p>
              Missions assigned to a body that has gone offline wait for it. Reassign them to a
              ready body with the same capabilities.
            </p>
            <button
              type="button"
              className="button"
              disabled={reassign.isPending}
              onClick={() => reassign.mutate()}
            >
              Reassign unavailable
            </button>
            {reassign.error && (
              <p className="notice error" role="alert">
                {reassign.error.message}
              </p>
            )}
          </section>
        )}
      </div>
      <MissionList missions={missions} bodies={bodies} canOperate={canOperate} />
    </div>
  );
}
