CREATE TABLE device_credentials (
    credential_id text PRIMARY KEY,
    body_id text NOT NULL,
    label text NOT NULL,
    token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at)
);
CREATE INDEX device_credentials_body_idx ON device_credentials(body_id);
REVOKE ALL ON device_credentials FROM PUBLIC;
