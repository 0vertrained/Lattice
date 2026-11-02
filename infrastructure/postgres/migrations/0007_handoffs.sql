CREATE TABLE handoff_proposals (
    handoff_id text PRIMARY KEY,
    round_id text NOT NULL REFERENCES inspection_rounds(round_id),
    proposal jsonb NOT NULL
);
CREATE INDEX handoff_proposals_round ON handoff_proposals(round_id);
CREATE TABLE body_execution_fences (
    body_id text PRIMARY KEY REFERENCES bodies(body_id),
    fenced_until timestamptz NOT NULL
);
REVOKE ALL ON handoff_proposals, body_execution_fences FROM PUBLIC;
