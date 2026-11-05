import { AUDIT_PAGE, useAudit } from '../../core/api/queries';
import { useSectionActive } from '../../core/sectionActivity';
import { AuditPanel } from '../../features/audit/AuditPanel';

export default function AuditSection() {
  const audit = useAudit(useSectionActive());
  return (
    <AuditPanel
      records={audit.data ?? []}
      page={AUDIT_PAGE}
      loading={audit.isPending && audit.fetchStatus === 'fetching'}
      failure={audit.error}
    />
  );
}
