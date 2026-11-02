CREATE TABLE proposals (
    proposal_id text PRIMARY KEY,
    proposal jsonb NOT NULL
);
CREATE TABLE body_sequences (
    body_id text PRIMARY KEY REFERENCES bodies(body_id),
    sequence bigint NOT NULL CHECK (sequence > 0)
);
ALTER TABLE commands ADD COLUMN signed_command jsonb;
ALTER TABLE audit_log ADD COLUMN position bigserial UNIQUE;
ALTER TABLE audit_log ADD COLUMN record jsonb;
CREATE TABLE core_identity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    public_key text NOT NULL
);
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
