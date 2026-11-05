/** Signal colours as a warehouse reads them: green done, yellow on the route, orange held, red stopped. */
export type Tone = 'clear' | 'lane' | 'hold' | 'stop' | 'off';

const tones: Readonly<Record<string, Tone>> = {
  online: 'clear',
  offline: 'off',
  docked: 'off',
  charging: 'off',
  faulted: 'stop',
  emergency_stopped: 'stop',
  queued: 'off',
  assigned: 'lane',
  running: 'lane',
  succeeded: 'clear',
  failed: 'stop',
  cancelled: 'off',
  interrupted: 'hold',
  recovery_required: 'hold',
  pending: 'off',
  active: 'lane',
  completed: 'clear',
  invalidated: 'off',
  approving: 'lane',
  approved: 'clear',
  expired: 'off',
  blocked: 'stop',
  clear: 'clear',
  ready: 'clear',
  excluded: 'off',
};

export const toneOf = (status: string): Tone => tones[status] ?? 'off';

/** "recovery_required" reads "Recovery required". */
export function humanize(status: string): string {
  const text = status.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function StatusChip({
  status,
  label,
}: {
  readonly status: string;
  readonly label?: string;
}) {
  return (
    <span className="status-pill" data-tone={toneOf(status)}>
      {label ?? humanize(status)}
    </span>
  );
}
