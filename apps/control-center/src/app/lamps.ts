import type { Body } from '../core/api/schemas';
import type { CoreStatus } from './useCoreStatus';

export type LampState = 'clear' | 'hold' | 'stop' | 'off';

export interface Lamp {
  readonly name: string;
  readonly state: LampState;
  readonly text: string;
  /** A machine string shown in the mono face after the text, such as the core epoch. */
  readonly code?: string;
}

const short = (epoch: string) => epoch.slice(0, 8);

export function coreLamp(status: CoreStatus): Lamp {
  if (status.reachable === null) return { name: 'Core', state: 'off', text: 'Checking' };
  if (!status.reachable || status.epoch === null)
    return { name: 'Core', state: 'stop', text: 'Unreachable' };
  if (status.restarted)
    return { name: 'Core', state: 'hold', text: 'Restarted, epoch', code: short(status.epoch) };
  return { name: 'Core', state: 'clear', text: 'Epoch', code: short(status.epoch) };
}

export function databaseLamp(status: CoreStatus, durable: boolean): Lamp {
  if (status.reachable === null) return { name: 'Database', state: 'off', text: 'Checking' };
  if (!durable) return { name: 'Database', state: 'hold', text: 'Memory only' };
  if (status.reachable && status.ready)
    return { name: 'Database', state: 'clear', text: 'Durable' };
  return { name: 'Database', state: 'stop', text: 'Unavailable' };
}

export function bodiesLamp(bodies: readonly Body[]): Lamp {
  if (bodies.length === 0) return { name: 'Bodies', state: 'off', text: 'None registered' };
  const online = bodies.filter((body) => body.status === 'online').length;
  const stopped = bodies.some(
    (body) => body.status === 'faulted' || body.status === 'emergency_stopped',
  );
  const text = `${online} of ${bodies.length} online`;
  if (stopped) return { name: 'Bodies', state: 'stop', text };
  return { name: 'Bodies', state: online === bodies.length ? 'clear' : 'hold', text };
}
