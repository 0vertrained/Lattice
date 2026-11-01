import { setup } from 'xstate';

export const missionApprovalMachine = setup({
  types: {
    events: {} as
      | { type: 'REVIEW' }
      | { type: 'EDIT' }
      | { type: 'AUTHORIZE' }
      | { type: 'SUCCESS' }
      | { type: 'FAILURE' }
      | { type: 'RESET' }
      | { type: 'RETRY' },
  },
}).createMachine({
  id: 'missionApproval',
  initial: 'editing',
  states: {
    editing: {
      on: { REVIEW: 'reviewing' },
    },
    reviewing: {
      on: {
        EDIT: 'editing',
        AUTHORIZE: 'submitting',
      },
    },
    submitting: {
      on: {
        SUCCESS: 'succeeded',
        FAILURE: 'failed',
      },
    },
    succeeded: {
      on: { RESET: 'editing' },
    },
    failed: {
      on: {
        RETRY: 'reviewing',
        EDIT: 'editing',
      },
    },
  },
});
