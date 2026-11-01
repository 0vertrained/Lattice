BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE bodies (
    body_id text PRIMARY KEY
        CHECK (body_id ~ '^[A-Za-z0-9_.:-]{3,64}$'),
    snapshot jsonb NOT NULL,
    status text GENERATED ALWAYS AS (snapshot ->> 'status') STORED,
    last_seen timestamptz NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bodies_status_last_seen_idx ON bodies (status, last_seen DESC);

CREATE TABLE missions (
    mission_id text PRIMARY KEY
        CHECK (mission_id ~ '^[A-Za-z0-9_.:-]{3,64}$'),
    mission jsonb NOT NULL,
    status text GENERATED ALWAYS AS (mission ->> 'status') STORED,
    assigned_body_id text REFERENCES bodies(body_id),
    active_command_id text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE INDEX missions_status_updated_idx ON missions (status, updated_at DESC);
CREATE INDEX missions_body_status_idx ON missions (assigned_body_id, status);

CREATE TABLE commands (
    command_id text PRIMARY KEY
        CHECK (command_id ~ '^[A-Za-z0-9_.:-]{3,64}$'),
    mission_id text NOT NULL REFERENCES missions(mission_id),
    body_id text NOT NULL REFERENCES bodies(body_id),
    sequence bigint NOT NULL CHECK (sequence > 0),
    envelope bytea NOT NULL,
    signature bytea NOT NULL,
    key_id text NOT NULL,
    contract_version text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    delivered_at timestamptz,
    result_at timestamptz,
    UNIQUE (body_id, sequence),
    CHECK (expires_at > issued_at)
);

ALTER TABLE missions
    ADD CONSTRAINT missions_active_command_fk
    FOREIGN KEY (active_command_id) REFERENCES commands(command_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX commands_delivery_idx
    ON commands (body_id, status, sequence)
    WHERE status = 'queued';

CREATE TABLE audit_log (
    audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at timestamptz NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    event_type text NOT NULL,
    object_id text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    previous_hash bytea,
    record_hash bytea NOT NULL
);

CREATE INDEX audit_log_object_time_idx ON audit_log (object_id, occurred_at DESC);
CREATE INDEX audit_log_event_time_idx ON audit_log (event_type, occurred_at DESC);

CREATE TABLE outbox (
    event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject text NOT NULL,
    payload jsonb NOT NULL,
    headers jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE INDEX outbox_unpublished_idx
    ON outbox (created_at)
    WHERE published_at IS NULL;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

COMMIT;
