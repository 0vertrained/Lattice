CREATE TABLE inspection_rounds (round_id text PRIMARY KEY, round jsonb NOT NULL);
REVOKE ALL ON inspection_rounds FROM PUBLIC;
