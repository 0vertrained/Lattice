import { describe, expect, it } from 'vitest';
import type { Body } from '../core/api/schemas';
import { batteryTone } from '../features/fleet/BatteryGauge';
import { ageText, LATE_MS, recordBeat, tracePath, WINDOW_MS } from '../features/fleet/heartbeats';
import { humanize, toneOf } from '../features/status';
import { bodiesLamp, coreLamp, databaseLamp } from './lamps';
import { availableSections } from './sections';
import type { CoreStatus } from './useCoreStatus';

const body = (status: Body['status']): Body => ({
  id: `body-${status}`,
  display_name: status,
  kind: 'rover',
  status,
  battery: 80,
  location: 'warehouse',
  pose: null,
  capabilities: ['navigate'],
  last_seen: new Date(0).toISOString(),
  adapter_version: 'test',
});
const core = (status: Partial<CoreStatus>): CoreStatus => ({
  reachable: true,
  ready: true,
  epoch: '3f9a1c2e-7b44-4c1e-9d2a-5b8e0f6a1d33',
  restarted: false,
  ...status,
});

describe('status lamps', () => {
  it('reads the core lamp from reachability and the epoch', () => {
    expect(coreLamp(core({ reachable: null }))).toMatchObject({ state: 'off', text: 'Checking' });
    expect(coreLamp(core({ reachable: false, epoch: null }))).toMatchObject({ state: 'stop' });
    expect(coreLamp(core({}))).toEqual({
      name: 'Core',
      state: 'clear',
      text: 'Epoch',
      code: '3f9a1c2e',
    });
    expect(coreLamp(core({ restarted: true }))).toMatchObject({ state: 'hold', code: '3f9a1c2e' });
  });
  it('holds the database lamp in memory mode and stops it when not ready', () => {
    expect(databaseLamp(core({}), true)).toMatchObject({ state: 'clear', text: 'Durable' });
    expect(databaseLamp(core({}), false)).toMatchObject({ state: 'hold', text: 'Memory only' });
    expect(databaseLamp(core({ ready: false }), true)).toMatchObject({ state: 'stop' });
  });
  it('lights the bodies lamp by how many are online, and stops it for a fault', () => {
    expect(bodiesLamp([])).toMatchObject({ state: 'off' });
    expect(bodiesLamp([body('online'), body('online')])).toMatchObject({
      state: 'clear',
      text: '2 of 2 online',
    });
    expect(bodiesLamp([body('online'), body('offline')])).toMatchObject({ state: 'hold' });
    expect(bodiesLamp([body('online'), body('emergency_stopped')])).toMatchObject({
      state: 'stop',
    });
  });
});

describe('heartbeats', () => {
  it('records each new report once and in order', () => {
    let beats = recordBeat([], 1_000);
    beats = recordBeat(beats, 1_000);
    beats = recordBeat(beats, 900);
    beats = recordBeat(beats, Number.NaN);
    beats = recordBeat(beats, 3_000);
    expect(beats).toEqual([1_000, 3_000]);
    for (let t = 4_000; t < 40_000; t += 1_000) beats = recordBeat(beats, t);
    expect(beats.length).toBe(24);
  });
  it('draws beats inside the window and leaves a flat tail to now', () => {
    const now = 100_000;
    const trace = tracePath([now - 2 * WINDOW_MS, now - 10_000, now - 2_000], now, 240);
    expect(trace.live.match(/L/g)?.length).toBe(6);
    expect(trace.tail?.to).toBe(240);
    expect(tracePath([], now, 240)).toEqual({ live: '', tail: null });
    expect(tracePath([now - 5 * WINDOW_MS], now, 240)).toEqual({
      live: '',
      tail: { from: 0, to: 240 },
    });
  });
  it('says how old the last report is', () => {
    expect(ageText(500)).toBe('Just now');
    expect(ageText(LATE_MS)).toBe('10 s ago');
    expect(ageText(125_000)).toBe('2 min 5 s ago');
    expect(ageText(2 * 3_600_000 + 60_000)).toBe('2 h 1 min ago');
  });
});

describe('signal tones', () => {
  it('maps states to warehouse floor colours', () => {
    expect(toneOf('online')).toBe('clear');
    expect(toneOf('running')).toBe('lane');
    expect(toneOf('recovery_required')).toBe('hold');
    expect(toneOf('emergency_stopped')).toBe('stop');
    expect(toneOf('something_new')).toBe('off');
    expect(humanize('recovery_required')).toBe('Recovery required');
  });
  it('colours the battery by charge', () => {
    expect([batteryTone(80), batteryTone(24), batteryTone(9)]).toEqual(['clear', 'hold', 'stop']);
  });
});

describe('sections', () => {
  it('offers durable sections only with a database and devices only to administrators', () => {
    const ids = (durable: boolean, admin: boolean) =>
      availableSections(durable, admin).map((section) => section.id);
    expect(ids(false, false)).toEqual(['fleet', 'missions', 'audit']);
    expect(ids(true, false)).toEqual([
      'fleet',
      'rounds',
      'missions',
      'routes',
      'continuity',
      'audit',
    ]);
    expect(ids(true, true)).toContain('devices');
  });
});
