import { useAudit } from '../../core/api/queries';
import { AuditPanel } from '../../features/audit/AuditPanel';

export default function AuditSection() {
  const audit = useAudit(true);
  return <AuditPanel records={audit.data ?? []} />;
}
