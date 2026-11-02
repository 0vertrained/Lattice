CREATE TABLE route_plan_proposals (
    route_plan_id text PRIMARY KEY,
    proposal jsonb NOT NULL
);
CREATE INDEX route_plan_proposals_created ON route_plan_proposals ((proposal->>'created_at'));
REVOKE ALL ON route_plan_proposals FROM PUBLIC;
