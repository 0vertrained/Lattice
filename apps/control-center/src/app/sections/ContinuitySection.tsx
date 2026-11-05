import '../../features/handoff/continuity.css';
import { HandoffPanel } from '../../features/handoff/HandoffPanel';
import { ObservationMemory } from '../../features/memory/ObservationMemory';
import type { SectionProps } from '../Shell';

export default function ContinuitySection({ bodies, missions, canOperate }: SectionProps) {
  return (
    <div className="continuity-grid">
      <ObservationMemory bodies={bodies} />
      <HandoffPanel bodies={bodies} missions={missions} canOperate={canOperate} />
    </div>
  );
}
