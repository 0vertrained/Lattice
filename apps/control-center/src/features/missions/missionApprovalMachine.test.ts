import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { missionApprovalMachine } from './missionApprovalMachine';

describe('mission approval workflow', () => {
  it('requires review before authorization', () => {
    const actor = createActor(missionApprovalMachine).start();
    actor.send({ type: 'AUTHORIZE' });
    expect(actor.getSnapshot().value).toBe('editing');

    actor.send({ type: 'REVIEW' });
    expect(actor.getSnapshot().value).toBe('reviewing');

    actor.send({ type: 'AUTHORIZE' });
    expect(actor.getSnapshot().value).toBe('submitting');
  });

  it('can recover from a failed submission', () => {
    const actor = createActor(missionApprovalMachine).start();
    actor.send({ type: 'REVIEW' });
    actor.send({ type: 'AUTHORIZE' });
    actor.send({ type: 'FAILURE' });
    expect(actor.getSnapshot().value).toBe('failed');

    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().value).toBe('reviewing');
  });
});
