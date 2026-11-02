-- Evidence images remain on missions. This table stores immutable provenance metadata.
CREATE TABLE observations (
    observation_id text PRIMARY KEY,
    command_id text NOT NULL UNIQUE REFERENCES commands(command_id),
    mission_id text NOT NULL REFERENCES missions(mission_id),
    body_id text NOT NULL REFERENCES bodies(body_id),
    subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 160),
    outcome text NOT NULL CHECK (outcome IN ('detected', 'not_detected')),
    captured_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL,
    observation jsonb NOT NULL,
    CHECK (NOT observation ? 'image_base64'),
    CHECK (observation ->> 'id' = observation_id),
    CHECK (observation ->> 'command_id' = command_id),
    CHECK (observation ->> 'mission_id' = mission_id),
    CHECK (observation ->> 'body_id' = body_id),
    CHECK (observation ->> 'subject_key' = subject_key),
    CHECK (observation ->> 'outcome' = outcome)
);

CREATE INDEX observations_newest_idx ON observations (captured_at DESC, received_at DESC, observation_id DESC);
CREATE INDEX observations_subject_newest_idx ON observations (subject_key, captured_at DESC, received_at DESC, observation_id DESC);
CREATE INDEX observations_positive_idx ON observations (captured_at DESC, received_at DESC, observation_id DESC) WHERE outcome = 'detected';
CREATE INDEX observations_subject_outcome_idx ON observations (subject_key, outcome, captured_at DESC);

-- A result may be replayed but historical observations may never be rewritten.
CREATE FUNCTION reject_observation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'observations are immutable';
END;
$$;
CREATE TRIGGER observations_immutable BEFORE UPDATE OR DELETE ON observations
FOR EACH ROW EXECUTE FUNCTION reject_observation_mutation();
