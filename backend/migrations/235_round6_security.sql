-- 235_round6_security — the round 6 security review of #523
-- (reviews/security-rls-523-round6.md, not committed): the fixes it asked
-- for in 231 and 232, each from its latest definition. 231–234 stay as they are.
--
--  1. The dominance rule counts every holder who takes water, not only the
--     farms (app_run_use_shown, from 232). 232 weighed summary.farms alone,
--     so in a catchment of 5 or more even farms and one large other water
--     user (a mine, a town, an industrial or private abstractor) the rule
--     passed, and natural flow less the outflow was mostly that user's take.
--     And with every farm at zero supply there were no parts at all, so the
--     rule passed whatever the users took. Now the parts are summary.farms
--     and summary.users (avgSuppliedM3Day each), a node's holder decided as
--     before (020's key: the lowest linked user, else the node; an
--     application's new node, farm or user, its owner's).
--     k is unchanged: 5 or more *farm* holders. k counts the people a
--     farmer is hidden among (the farms of the catchment, FARMER_K, 020);
--     an other water user is no one's neighbour there, and a mine or a town
--     doesn't make a catchment of four farms safe to show. The users count
--     only in the dominance rule, where their take is part of the use.
--     No parts above 0, farms and users both (nobody takes water), still
--     shows: natural flow less the outflow is then no holder's use (dam
--     evaporation and land cover only).
--
--  2. allocation_select and allocation_holder_select, from 231, uncorrelated.
--     231 called app_reads_allocation_units(project_id) once per row: a SQL
--     definer wrapping a plpgsql invoker, none of them inlinable, ~40 % slower
--     than 162's policy at the 5,000-row cap. Now the policy asks for the
--     projects whose allocations the current user reads, once per query:
--       project_id IN (SELECT p.id FROM project p WHERE app_reads_allocation_units(p.id))
--     Who reads what is exactly as before: the subquery reads `project`
--     under the user's own RLS (project_select: a viewer or above), and
--     every reader app_user_reads_allocation_units admits is one (the
--     authority's members are confirmed delegates holding editor, 229; the
--     rest are viewers or above by its own test). A farmer, below viewer,
--     reads no project row here and never did read through this policy; their
--     own farms' rows stay allocation_select_farmer's (038). The holder
--     policy likewise, and its farmer branch (038) as an uncorrelated
--     IN over allocation (allocation's own policies apply inside, as before).
--     G6's guarantee is untouched: the one rule decides, its first line is the
--     authority's (authority-reads.db.test.ts).

-- ---------------------------------------------------------------------------
-- 1. app_run_use_shown, from 232 (its latest): the users' take among the parts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_run_use_shown(p_run uuid) RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	WITH r AS (
		SELECT m.project_id, m.summary, s.owner_user_id
		FROM model_run m LEFT JOIN scenario s ON s.id = m.scenario_id AND s.project_id = m.project_id
		WHERE m.id = p_run
	), holder AS (
		-- Each node and its holder key (020's rule): the lowest linked user, or the node itself.
		SELECT n.id::text AS node_id, n.kind, coalesce(
			(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
			'node:' || n.id::text
		) AS key
		FROM node n JOIN r ON n.project_id = r.project_id
	), takes AS (
		-- Who takes water in the run: the farms and the other water users (235).
		SELECT t FROM r CROSS JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(r.summary->'farms') = 'array' THEN r.summary->'farms' ELSE '[]'::jsonb END) t
		UNION ALL
		SELECT t FROM r CROSS JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(r.summary->'users') = 'array' THEN r.summary->'users' ELSE '[]'::jsonb END) t
	), parts AS (
		-- The run's supply per holder: a node the project no longer has (an application's new one) is its owner's.
		SELECT coalesce(h.key, r.owner_user_id::text, 'node:' || (x.t->>'nodeId')) AS key,
			sum(greatest(coalesce((x.t->>'avgSuppliedM3Day')::float8, 0), 0)) AS v
		FROM takes x
		CROSS JOIN r
		LEFT JOIN holder h ON h.node_id = x.t->>'nodeId'
		GROUP BY 1
	)
	SELECT EXISTS (SELECT 1 FROM r)
		-- k: 5 or more farm holders, counted from nobody's point of view (app_share_series' count since 025). Users don't count (235).
		AND (SELECT count(DISTINCT key) FROM holder WHERE kind = 'farm') >= 5
		-- dominance: over the run's supply per holder, farms and other water users (235).
		AND app_use_parts_shown(ARRAY(SELECT v FROM parts))
	$$;
COMMENT ON FUNCTION app_run_use_shown(uuid) IS
	'Whether a run''s use (outflow, observed flow, EWR shortfall, catchment volumes) may be shown to someone kept from each farm: 5 or more farm holders (k; other water users don''t count) and the dominance rule over the run''s supply per holder, farms and other water users alike (none above 80 %, no two above 90 %; provisional, #92) (232, 235, #523 G8). Internal: invoker''s rights, closed to PUBLIC and water_app; every caller is SECURITY DEFINER.';

-- ---------------------------------------------------------------------------
-- 2. The allocation policies, from 231 (their latest): once per query
-- ---------------------------------------------------------------------------
DROP POLICY allocation_select ON allocation;
CREATE POLICY allocation_select ON allocation FOR SELECT
	USING (project_id IN (SELECT p.id FROM project p WHERE app_reads_allocation_units(p.id)));

-- A farmer: an allocation on their own farm (allocation's own policies apply inside the subquery), as in 038.
DROP POLICY allocation_holder_select ON allocation_holder;
CREATE POLICY allocation_holder_select ON allocation_holder FOR SELECT
	USING (
		project_id IN (SELECT p.id FROM project p WHERE app_reads_allocation_holders(p.id))
		OR allocation_id IN (SELECT a.id FROM allocation a WHERE a.node_id IN (SELECT app_farm_nodes(a.project_id)))
	);
