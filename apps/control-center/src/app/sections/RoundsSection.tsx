import '../../features/missions/missions.css';
import { InspectionRound } from '../../features/missions/InspectionRound';
import type { SectionProps } from '../Shell';

export default function RoundsSection({ canOperate }: SectionProps) {
  return <InspectionRound canOperate={canOperate} />;
}
