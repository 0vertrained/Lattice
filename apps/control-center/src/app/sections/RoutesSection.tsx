import { RoutePlanner } from '../../features/navigation/RoutePlanner';
import type { SectionProps } from '../Shell';

export default function RoutesSection({ bodies, canOperate }: SectionProps) {
  return <RoutePlanner bodies={bodies} canOperate={canOperate} />;
}
