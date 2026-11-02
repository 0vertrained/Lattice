CREATE TABLE route_condition_observations (
    observation_id text PRIMARY KEY,
    event_id text NOT NULL UNIQUE,
    revision bigint NOT NULL UNIQUE CHECK (revision > 0),
    observation jsonb NOT NULL
);
CREATE TABLE route_replan_proposals (
    replan_id text PRIMARY KEY,
    proposal jsonb NOT NULL
);
