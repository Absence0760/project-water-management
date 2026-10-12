-- 223_user_restriction_pct — a fixed restriction % for Priority users
-- (engine 1.86.0, issue #523 B3, docs/model.md §2.7c and §2.7i).
--
-- An other water user of class Priority may carry a share of its demand it
-- gives up when restricted: the curtailment table cuts it for its EWR charge
-- by at most that share of its demand, and the drought restriction rule cuts
-- its demand by it while a level is in force. There is no basic-needs floor:
-- a user has no population yet (followups.md § Drought restrictions on the
-- other water users, option d, per user). NULL = none, today's behaviour.
--
-- Existing rows get NULL, so no stored model or result changes meaning. Only
-- a Priority user may have a value above 0; the API refuses it elsewhere
-- (the engine's modelRuleProblems), and the engine ignores it with a warning,
-- so the column carries no kind check (a node can change kind or class in
-- one save). A new column on an existing table: the table-level grants to
-- water_app (001) and its RLS policies already cover it; no foreign key, so
-- no index.

ALTER TABLE node
	ADD COLUMN user_restriction_pct double precision
		CHECK (user_restriction_pct IS NULL OR user_restriction_pct BETWEEN 0 AND 1);

COMMENT ON COLUMN node.user_restriction_pct IS
	'Kind user, priority senior only: the share (0-1) of its demand it gives up when restricted (curtailment table and the drought restriction rule), no basic-needs floor. NULL = none. Engine >= 1.86.0 (223).';
