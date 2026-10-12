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
--
--  3. The DWS mark is checked by the database (run_series_published_mark).
--     The policies and app_share_series take run_series.meta `publishedBy:
--     'DWS'` as given, and only storeRun writes it, from a provenance check
--     in SQL (runs/execute.ts). Defence in depth: a BEFORE INSERT and
--     UPDATE OF meta trigger strips `publishedBy` and `station` unless the
--     row is the outlet's observed flow (node_id NULL, observed_flow or
--     observed_flow_other), of a run that is no scenario run (from_scenario),
--     and the run's input of that kind (run_input_series, by its label's
--     kind) is an outlet series a DWS feed for that very river-gauge station
--     wrote whole (feed_days covering every reading: runs/publishedRecords.ts'
--     check, read from the live series). storeRun now stores the run's
--     inputs before its series so the check can see them. The gap-filled
--     exclusion (a `<key>_fill` sibling) stays the app's: the sibling may be
--     in a later insert.

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

-- ---------------------------------------------------------------------------
-- 3. The DWS mark, checked
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the check reads the run's inputs and the feed whoever
-- inserts (it only ever removes keys from the row being written).
CREATE FUNCTION run_series_published_mark() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_kind text;
	BEGIN
		IF NOT (NEW.meta ? 'publishedBy' OR NEW.meta ? 'station') THEN
			RETURN NEW;
		END IF;
		-- The record a key holds, by the engine's label (OBSERVED_SERIES_LABEL).
		v_kind := CASE NEW.meta->>'label' WHEN 'Observed flow' THEN 'flow_observed_m3s' WHEN 'Observed flow (logger)' THEN 'flow_logger_m3s' END;
		IF NEW.node_id IS NULL
			AND NEW.key IN ('observed_flow', 'observed_flow_other')
			AND NEW.meta->>'publishedBy' = 'DWS'
			-- A DWS river gauge (feeds/config.ts DWS_RIVER_GAUGE).
			AND coalesce(NEW.meta->>'station', '') ~ '^[A-Z][0-9]H[0-9]{3}$'
			AND v_kind IS NOT NULL
			AND EXISTS (
				SELECT 1
				FROM model_run m
				JOIN run_input_series i ON i.run_id = m.id AND i.project_id = m.project_id AND i.kind = v_kind
				JOIN time_series t ON t.id = i.series_id AND t.project_id = m.project_id
				JOIN data_feed f ON f.id = t.feed_id AND f.project_id = t.project_id
				WHERE m.id = NEW.run_id AND m.project_id = NEW.project_id AND NOT m.from_scenario
				  AND t.site_node_id IS NULL AND t.kind::text = v_kind
				  AND f.source = 'dws' AND f.config->>'station' = NEW.meta->>'station'
				  -- Every reading the feed's (runs/execute.ts loadLiveInput's dws_station).
				  AND t.feed_days IS NOT NULL
				  AND EXISTS (SELECT 1 FROM unnest(t."values") v WHERE v IS NOT NULL)
				  AND NOT EXISTS (
					SELECT 1 FROM unnest(t."values") WITH ORDINALITY u(v, o)
					WHERE u.v IS NOT NULL AND NOT t.feed_days @> (t.start_date + (u.o - 1)::int)
				  )
			)
		THEN
			RETURN NEW;
		END IF;
		NEW.meta := NEW.meta - 'publishedBy' - 'station';
		RETURN NEW;
	END
	$$;
COMMENT ON FUNCTION run_series_published_mark() IS
	'Strips run_series.meta publishedBy/station unless the row is the outlet''s observed flow of a run that is no scenario run, whose input of that kind is an outlet series a DWS feed for that river-gauge station wrote whole (235, #523 G8; runs/publishedRecords.ts). Defence in depth behind storeRun.';
CREATE TRIGGER run_series_published_mark BEFORE INSERT OR UPDATE OF meta ON run_series
	FOR EACH ROW EXECUTE FUNCTION run_series_published_mark();
