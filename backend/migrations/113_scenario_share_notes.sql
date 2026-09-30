-- 113_scenario_share_notes — share links to one application, and comments on
-- it for public participation (roadmap WP-3.15, issue #71 "comments / NGO
-- access"; docs/data-model.md § Share links, § Notes; docs/security.md
-- § Share links, § Notes; docs/api.md § Share, § Notes; docs/scenarios.md
-- § Sharing and comments).
--
-- Expand-only. Every function and policy changed here starts from its latest
-- definition, named at each.
--
--  1. assert_same_project (022): a `%scenario_id` column resolves against
--     scenario.
--
--  2. share_link: a link may now name one target, `target_kind` + `target_id`
--     (both or neither). NULL keeps WP-2.3's catchment link exactly as it was.
--     'scenario' is the only kind yet; evidence packs add 'pack' the same way
--     once `evidence_pack` exists (docs/followups.md). The target is checked
--     to be the link's own project (share_link_target_check), is fixed once
--     made (water_app's UPDATE grant is revoked_at / revoked_by only, 025),
--     and has an index for the "links to this scenario" list.
--       * Who makes, lists and revokes one (share_link_select / _insert /
--         _update, from 025): the project owner, every link (as before);
--         an editor, a link to a scenario they read (an assessor, a submitted
--         application); a contributor, a link to their own application, and
--         lists and revokes only the links they made. A targeted link is made
--         only on a submitted or decided application (origin 'applicant'): a
--         draft is still changing, and isn't the application the public
--         comments on; a team scenario's ops name the real farms by id with
--         their values (no applicant projection hides them), so it is never
--         shared this way.
--       * app_share_view and app_share_series (081, 025) answer only an
--         untargeted link: a scenario link opens its scenario and nothing else.
--       * app_share_scenario(p_hash): the public read of a scenario link, a
--         redacted projection built from an allowlist (as app_share_view
--         rebuilds catchment_view), answering only while the scenario is
--         submitted or decided (a withdrawn one reads as a dead link until it
--         is submitted again):
--           - the scenario: its id and project id (so a signed-in member can
--             comment from the page; an id grants nothing), name,
--             description, status and decision, its ops
--             and hash, its own nodes (so the page can tell a proposal from a
--             baseline assumption, engine classifyOp), and the op names of its
--             own nodes only (every other node is anonymous, as in the
--             applicant projection, scenarios/applicant.ts);
--           - its base run and its newest 5 runs of the current ops on the
--             current base, each through app_share_run_projection: dates,
--             engine version, EWR days not met, and each EWR site's Reserve
--             compliance (a gauge's name; never the outlet's, which may be a
--             farm). Volumes (flows, farm totals, a site's deficit) only when
--             the catchment has at least 5 farm holders, app_share_series' k
--             (below it they would reveal a small catchment's farms' use),
--             and, on a run, only when its every op was a proposal: a
--             baseline assumption on another unit (its demand to 0) would
--             make baseline minus application that unit's figures. No farm
--             row, name or id, no allocation, no member list;
--           - each run's stamp and its digest (app_run_digest_body), and each
--             candidate run's class per op, so the API shows the newest run
--             whose stamp verifies, and results only when the backend stored
--             them (077, docs/security.md § Run stamps): a row written past
--             the API can't displace the stored run or relabel its changes;
--           - the comments posted with `public_participation` visibility,
--             with their authors' display names: the one thing a public
--             comment is (docs/roadmap/step-3-licensing.md § 7).
--     app_run_digest (077) keeps its check and its digest; the digest itself
--     moves into app_run_digest_body so the definer read can use it. Neither
--     helper is callable by water_app.
--
--  3. note: a note may be about a scenario (`scenario_id`, cascade, covering
--     index, same-project trigger), one target at most (note_one_target from
--     037, now with scenario_id). Three more visibilities, for scenario notes
--     only: `assessors`, `parties` and `public_participation`. Who reads and
--     writes each (app_scenario_note_visible / _writable, note_select and
--     note_insert from 045 / 037, and the new note_select_scenario):
--
--         visibility            reads                          writes
--         team                  viewer+ who reads the scenario   the same
--         assessors             editor+ who reads it; author     editor+ who reads it; its parties
--         parties               editor+ who reads it; its        the same
--                               parties (owner, scenario_member)
--         public_participation  editor+ who reads it; its        any member contributor+ (the
--                               parties; any member contributor  assessors too) while it is open
--                               + while it is open for comment   for comment
--
--     "Open for comment": a live scenario share link, or decided once it was
--     ever shared (app_scenario_commentable). Farmers read and write none of them
--     (farm notes stay node notes). A deleted note stays readable to its
--     author and to editors, as 037's are.
--     note_revision: the text a note had before each edit, written by a
--     trigger on every body change of a scenario note (a participation record
--     must be complete), read by whoever reads the note, never written or
--     changed by water_app. Soft delete and moderation are 037's, unchanged.
--
--  4. app_subject_export (092): a note carries its scenario id and its
--     revisions (the person's own earlier text).

-- ---------------------------------------------------------------------------
-- 1. assert_same_project, from 112_evidence_pack.sql
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_same_project() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		col text;
		ref_id uuid;
		ref_project uuid;
	BEGIN
		FOREACH col IN ARRAY TG_ARGV LOOP
			ref_id := (to_jsonb(NEW) ->> col)::uuid;
			CONTINUE WHEN ref_id IS NULL;
			IF col LIKE '%crop_id' THEN
				SELECT project_id INTO ref_project FROM crop WHERE id = ref_id;
			ELSIF col LIKE '%run_id' THEN
				SELECT project_id INTO ref_project FROM model_run WHERE id = ref_id;
			ELSIF col LIKE '%publication_id' THEN
				SELECT project_id INTO ref_project FROM run_publication WHERE id = ref_id;
			ELSIF col LIKE '%pack_id' THEN
				SELECT project_id INTO ref_project FROM evidence_pack WHERE id = ref_id;
			ELSIF col LIKE '%scenario_id' THEN
				SELECT project_id INTO ref_project FROM scenario WHERE id = ref_id;
			ELSE
				SELECT project_id INTO ref_project FROM node WHERE id = ref_id;
			END IF;
			IF ref_project IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION '% % belongs to a different project', col, ref_id USING ERRCODE = 'foreign_key_violation';
			END IF;
		END LOOP;
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 2. share_link targets
-- ---------------------------------------------------------------------------
ALTER TABLE share_link
	ADD COLUMN target_kind text CHECK (target_kind IN ('scenario')),
	ADD COLUMN target_id uuid,
	ADD CONSTRAINT share_link_target_both CHECK ((target_kind IS NULL) = (target_id IS NULL));
COMMENT ON COLUMN share_link.target_kind IS
	'NULL: the project''s published baseline (025, WP-2.3). ''scenario'': one scenario, target_id (113, WP-3.15). Evidence packs add ''pack''. Fixed once made.';
COMMENT ON COLUMN share_link.target_id IS
	'The scenario a targeted link opens (113); no foreign key, since the kind picks the table: share_link_target_check checks it on insert. A deleted scenario leaves a dead link.';

-- The links to one scenario (its Share dialog).
CREATE INDEX share_link_target_idx ON share_link (target_id, created_at DESC) WHERE target_id IS NOT NULL;

-- The target is a scenario of the link's own project. SECURITY DEFINER: it
-- checks the row whether or not the caller reads it (the policies decide who
-- may link it). Insert only: the target can't change (no UPDATE grant), and
-- a revoke must still work once the scenario is gone.
CREATE FUNCTION share_link_target_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.target_kind = 'scenario' AND NEW.target_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM scenario s WHERE s.id = NEW.target_id AND s.project_id = NEW.project_id
		) THEN
			RAISE EXCEPTION 'scenario % belongs to a different project', NEW.target_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER share_link_target_check BEFORE INSERT ON share_link
	FOR EACH ROW EXECUTE FUNCTION share_link_target_check();

-- Who reads (and may revoke) a link: module comment, 2.
CREATE FUNCTION app_share_link_visible(p_project uuid, p_kind text, p_target uuid, p_created_by uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_has_role(p_project, 'owner') THEN
			RETURN true;
		END IF;
		IF p_kind = 'scenario' THEN
			RETURN (app_has_role(p_project, 'editor') AND app_scenario_readable(p_target))
				OR (p_created_by = app_current_user_id() AND app_has_role(p_project, 'contributor'));
		END IF;
		RETURN false;
	END
	$$;

-- Who may make a link: module comment, 2. A targeted link needs a submitted
-- or decided scenario of this project.
CREATE FUNCTION app_share_link_creatable(p_project uuid, p_kind text, p_target uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_owner uuid;
	BEGIN
		IF p_kind IS NULL THEN
			RETURN app_has_role(p_project, 'owner');
		END IF;
		IF p_kind = 'scenario' THEN
			SELECT s.owner_user_id INTO v_owner FROM scenario s
			WHERE s.id = p_target AND s.project_id = p_project AND s.status IN ('submitted', 'decided') AND s.origin = 'applicant';
			IF NOT FOUND THEN
				RETURN false;
			END IF;
			RETURN (app_has_role(p_project, 'editor') AND app_scenario_readable(p_target))
				OR (v_owner = app_current_user_id() AND app_has_role(p_project, 'contributor'));
		END IF;
		RETURN false;
	END
	$$;

-- From 025_share_links.sql.
DROP POLICY share_link_select ON share_link;
DROP POLICY share_link_insert ON share_link;
DROP POLICY share_link_update ON share_link;
CREATE POLICY share_link_select ON share_link FOR SELECT
	USING (app_share_link_visible(project_id, target_kind, target_id, created_by));
CREATE POLICY share_link_insert ON share_link FOR INSERT
	WITH CHECK (created_by = app_current_user_id() AND app_share_link_creatable(project_id, target_kind, target_id));
CREATE POLICY share_link_update ON share_link FOR UPDATE
	USING (app_share_link_visible(project_id, target_kind, target_id, created_by))
	WITH CHECK (app_share_link_visible(project_id, target_kind, target_id, created_by));

-- app_share_view, from 081_notice_languages.sql: an untargeted link only.
CREATE OR REPLACE FUNCTION app_share_view(p_hash bytea)
	RETURNS TABLE (
		project_name text,
		published_at timestamptz,
		published_by text,
		catchment_view jsonb,
		restriction_level text,
		restriction_pct numeric,
		notice jsonb,
		next_expected_on date
	)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_link uuid;
		v_project uuid;
	BEGIN
		SELECT s.id, s.project_id INTO v_link, v_project FROM share_link s
		WHERE s.token_hash = p_hash AND s.target_kind IS NULL AND s.revoked_at IS NULL AND s.expires_at > now();
		IF v_link IS NULL THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT pr.name::text, p.published_at, u.display_name::text,
				jsonb_build_object(
					'runStart', p.catchment_view->'runStart',
					'dataUntil', p.catchment_view->'dataUntil',
					'season', p.catchment_view->'season',
					'last30', p.catchment_view->'last30',
					'runDays', p.catchment_view->'runDays',
					'farmCount', p.catchment_view->'farmCount',
					'sites', coalesce((
						SELECT jsonb_agg(jsonb_build_object(
							'name', CASE WHEN (e.s->>'isOutlet')::boolean THEN NULL ELSE e.s->'name' END,
							'isOutlet', coalesce((e.s->>'isOutlet')::boolean, false),
							'daysNotMet', jsonb_build_object(
								'run', e.s->'daysNotMet'->'run',
								'season', e.s->'daysNotMet'->'season',
								'last30', e.s->'daysNotMet'->'last30'
							)
						) ORDER BY e.o)
						FROM jsonb_array_elements(p.catchment_view->'sites') WITH ORDINALITY e(s, o)
					), '[]'::jsonb)
				),
				p.restriction_level, p.restriction_pct, p.notice, p.next_expected_on
			FROM run_publication p
			JOIN project pr ON pr.id = p.project_id
			LEFT JOIN app_user u ON u.id = p.published_by
			WHERE p.project_id = v_project AND p.superseded_at IS NULL;
		IF FOUND THEN
			UPDATE share_link SET last_used_at = now()
			WHERE id = v_link AND (last_used_at IS NULL OR last_used_at <= now() - interval '1 hour');
		END IF;
	END
	$$;

-- app_share_series, from 025_share_links.sql: an untargeted link only.
CREATE OR REPLACE FUNCTION app_share_series(p_hash bytea, p_key text)
	RETURNS TABLE (
		label text,
		unit text,
		monthly_start date,
		monthly double precision[],
		recent_start date,
		recent double precision[]
	)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		WITH pub AS (
			SELECT p.project_id, p.run_id, r.start_date
			FROM share_link s
			JOIN run_publication p ON p.project_id = s.project_id AND p.superseded_at IS NULL
			JOIN model_run r ON r.id = p.run_id
			WHERE s.token_hash = p_hash AND s.target_kind IS NULL AND s.revoked_at IS NULL AND s.expires_at > now()
			  AND p_key IN ('natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall')
		), holders AS (
			SELECT count(DISTINCT coalesce(
				(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
				'node:' || n.id::text
			)) AS n
			FROM node n JOIN pub ON n.project_id = pub.project_id
			WHERE n.kind = 'farm'
		), series AS (
			SELECT rs.meta, rs."values" AS vals, pub.start_date
			FROM run_series rs JOIN pub ON rs.run_id = pub.run_id AND rs.project_id = pub.project_id
			WHERE rs.node_id IS NULL AND rs.key = p_key
			  AND (SELECT n FROM holders) >= 5
		), days AS (
			SELECT (series.start_date + (u.o - 1)::int) AS d, NULLIF(u.v, 'NaN'::double precision) AS v
			FROM series, unnest(series.vals) WITH ORDINALITY u(v, o)
		), months AS (
			SELECT date_trunc('month', d)::date AS m, avg(v) AS v FROM days GROUP BY 1
		)
		SELECT
			coalesce(series.meta->>'label', p_key),
			coalesce(series.meta->>'unit', ''),
			date_trunc('month', series.start_date)::date,
			coalesce((SELECT array_agg(months.v ORDER BY months.m) FROM months), '{}'),
			series.start_date + greatest(0, cardinality(series.vals) - 365),
			coalesce((SELECT array_agg(days.v ORDER BY days.d) FROM days WHERE days.d >= series.start_date + greatest(0, cardinality(series.vals) - 365)), '{}')
		FROM series
	$$;

-- app_run_digest, from 077_run_stamp.sql: the same check, the digest itself
-- in app_run_digest_body (unchanged expression), so app_share_scenario can
-- digest a run it may show without the caller reading it.
CREATE FUNCTION app_run_digest_body(p_run uuid) RETURNS bytea
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT sha256(convert_to(jsonb_build_array(
		'wm-run-digest:v1',
		r.id,
		r.project_id,
		r.engine_version,
		to_char(r.start_date, 'YYYY-MM-DD'),
		to_char(r.end_date, 'YYYY-MM-DD'),
		r."trigger",
		r.scenario_id IS NOT NULL AND r.scenario_id::text IS DISTINCT FROM r.inputs->'scenario'->>'id',
		encode(sha256(convert_to(r.inputs::text, 'UTF8')), 'hex'),
		encode(sha256(convert_to(r.summary::text, 'UTF8')), 'hex'),
		(SELECT COALESCE(jsonb_agg(jsonb_build_array(i.kind, to_char(i.start_date, 'YYYY-MM-DD'), i.sha256) ORDER BY i.kind COLLATE "C"), '[]'::jsonb)
		 FROM run_input_series i WHERE i.run_id = r.id),
		(SELECT COALESCE(jsonb_agg(jsonb_build_array(s.node_id, s.key, s.meta, encode(sha256(array_send(s."values")), 'hex'))
			ORDER BY s.node_id NULLS FIRST, s.key COLLATE "C"), '[]'::jsonb)
		 FROM run_series s WHERE s.run_id = r.id)
	)::text, 'UTF8'))
	FROM model_run r
	WHERE r.id = p_run
	$$;
REVOKE ALL ON FUNCTION app_run_digest_body(uuid) FROM PUBLIC, water_app;

CREATE OR REPLACE FUNCTION app_run_digest(p_run uuid) RETURNS bytea
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT app_run_digest_body(r.id)
	FROM model_run r
	WHERE r.id = p_run
	  AND (
		(app_has_role(r.project_id, 'viewer') AND (r.scenario_id IS NULL OR app_scenario_readable(r.scenario_id)))
		OR app_own_new_scenario_run(r.project_id, r.id)
	  )
	$$;

-- What a scenario link shows of one run (module comment, 2): an allowlist of
-- its summary. Volumes only when p_volumes (the k rule). Called only from
-- app_share_scenario; not callable by water_app.
CREATE FUNCTION app_share_run_projection(p_run uuid, p_volumes boolean) RETURNS jsonb
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT jsonb_build_object(
		'engineVersion', r.engine_version,
		'startDate', to_char(r.start_date, 'YYYY-MM-DD'),
		'endDate', to_char(r.end_date, 'YYYY-MM-DD'),
		'createdAt', r.created_at,
		'ewrDaysNotMet', r.summary->'catchment'->'ewrDaysNotMet',
		'ewrFractionDaysNotMet', r.summary->'catchment'->'ewrFractionDaysNotMet',
		'volumes', CASE WHEN p_volumes THEN jsonb_build_object(
			'meanNaturalFlowM3Day', r.summary->'catchment'->'meanNaturalFlowM3Day',
			'meanSimulatedOutflowM3Day', r.summary->'catchment'->'meanSimulatedOutflowM3Day',
			'farms', (SELECT jsonb_build_object(
					'count', count(*),
					'demandM3Day', coalesce(sum((f->>'avgDemandM3Day')::float8), 0),
					'suppliedM3Day', coalesce(sum((f->>'avgSuppliedM3Day')::float8), 0),
					-- engine compare.ts SUPPLY_TARGET
					'belowTarget', count(*) FILTER (WHERE (f->>'fractionSupplied')::float8 < 0.95)
				) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.summary->'farms') = 'array' THEN r.summary->'farms' ELSE '[]'::jsonb END) f)
		) END,
		'ewrSites', coalesce((
			SELECT jsonb_agg(jsonb_build_object(
				'name', CASE WHEN coalesce((e.s->>'isOutlet')::boolean, false) THEN NULL ELSE e.s->'name' END,
				'isOutlet', coalesce((e.s->>'isOutlet')::boolean, false),
				'months', e.s->'overall'->'months',
				'met', e.s->'overall'->'met',
				'rate', e.s->'overall'->'rate',
				'longestNotMetRun', e.s->'overall'->'longestNotMetRun',
				'deficitM3', CASE WHEN p_volumes THEN e.s->'overall'->'deficitM3' END,
				'byMonth', coalesce((
					SELECT jsonb_agg(jsonb_build_object('month', m.v->'month', 'years', m.v->'years', 'met', m.v->'met', 'rate', m.v->'rate') ORDER BY m.o)
					FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.s->'byMonth') = 'array' THEN e.s->'byMonth' ELSE '[]'::jsonb END) WITH ORDINALITY m(v, o)
				), '[]'::jsonb)
			) ORDER BY e.o)
			FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.summary->'ewrAssurance') = 'array' THEN r.summary->'ewrAssurance' ELSE '[]'::jsonb END) WITH ORDINALITY e(s, o)
		), '[]'::jsonb)
	)
	FROM model_run r
	WHERE r.id = p_run
	$$;
REVOKE ALL ON FUNCTION app_share_run_projection(uuid, boolean) FROM PUBLIC, water_app;

-- The public read of a scenario link (module comment, 2). No row for an
-- unknown, revoked, expired or untargeted token, a scenario gone or not
-- submitted or decided. Bumps last_used_at at most once an hour.
CREATE FUNCTION app_share_scenario(p_hash bytea)
	RETURNS TABLE (
		project_name text,
		scenario jsonb,
		base_run jsonb,
		base_stamp bytea,
		base_digest bytea,
		runs jsonb,
		comments jsonb
	)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_link uuid;
		v_project uuid;
		v_target uuid;
		s record;
		v_k boolean;
	BEGIN
		SELECT l.id, l.project_id, l.target_id INTO v_link, v_project, v_target FROM share_link l
		WHERE l.token_hash = p_hash AND l.target_kind = 'scenario' AND l.revoked_at IS NULL AND l.expires_at > now();
		IF v_link IS NULL THEN
			RETURN;
		END IF;
		SELECT sc.* INTO s FROM scenario sc
		WHERE sc.id = v_target AND sc.project_id = v_project AND sc.status IN ('submitted', 'decided') AND sc.origin = 'applicant';
		IF NOT FOUND THEN
			RETURN;
		END IF;
		-- app_share_series' k: at least 5 farm holders, counted from nobody's point of view.
		SELECT count(DISTINCT coalesce(
			(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
			'node:' || n.id::text
		)) >= 5 INTO v_k
		FROM node n WHERE n.project_id = v_project AND n.kind = 'farm';

		RETURN QUERY
			SELECT pr.name::text,
				jsonb_build_object(
					-- Ids only so a signed-in member can comment from the page (POST …/notes); they grant nothing.
					'id', s.id,
					'projectId', s.project_id,
					'name', s.name,
					'description', s.description,
					'origin', s.origin,
					'status', s.status,
					'submittedAt', s.submitted_at,
					'decidedAt', s.decided_at,
					'outcome', s.outcome,
					'decisionNote', s.decision_note,
					'ops', s.ops,
					'opsSha256', s.ops_sha256,
					'ownedNodeIds', to_jsonb(s.owned_node_ids),
					'opNames', coalesce((
						SELECT jsonb_agg(x.v ORDER BY x.o)
						FROM jsonb_array_elements(s.op_names) WITH ORDINALITY x(v, o)
						WHERE x.v->>'id' = ANY (s.owned_node_ids::text[])
					), '[]'::jsonb)
				),
				app_share_run_projection(s.base_run_id, v_k),
				(SELECT r.stamp FROM model_run r WHERE r.id = s.base_run_id),
				app_run_digest_body(s.base_run_id),
				-- Its newest runs of the ops and base it has now, newest first: the
				-- API shows the newest whose stamp verifies, so a row written past
				-- the API can't displace the run the backend stored. Volumes only
				-- past the k rule and when every op was a proposal (its own units):
				-- a baseline assumption on another unit (its demand set to 0, say)
				-- would make baseline minus application that unit's figures.
				coalesce((
					SELECT jsonb_agg(c.j ORDER BY c.created_at DESC, c.id DESC)
					FROM (
						SELECT r.id, r.created_at, jsonb_build_object(
							'projection', app_share_run_projection(r.id, v_k AND coalesce((
								SELECT bool_and(cl = '"proposal"'::jsonb)
								FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.inputs->'scenario'->'classified') = 'array' THEN r.inputs->'scenario'->'classified' ELSE '[]'::jsonb END) cl
							), true) AND jsonb_typeof(r.inputs->'scenario'->'classified') = 'array'
								AND jsonb_array_length(r.inputs->'scenario'->'classified') = jsonb_array_length(s.ops)),
							-- Each op's class as this run applied it (proposal | baseline).
							'classified', r.inputs->'scenario'->'classified',
							'stamp', encode(r.stamp, 'hex'),
							'digest', encode(app_run_digest_body(r.id), 'hex')
						) AS j
						FROM model_run r
						WHERE r.project_id = v_project AND r.scenario_id = s.id
						  AND r.inputs->'scenario'->>'opsSha256' = s.ops_sha256
						  AND r.inputs->'scenario'->>'baseRunId' = s.base_run_id::text
						ORDER BY r.created_at DESC, r.id DESC
						LIMIT 5
					) c
				), '[]'::jsonb),
				coalesce((
					SELECT jsonb_agg(c.j ORDER BY c.created_at, c.id)
					FROM (
						SELECT n.id, n.created_at, jsonb_build_object(
							'body', n.body,
							'author', u.display_name,
							'createdAt', n.created_at,
							'editedAt', n.edited_at
						) AS j
						FROM note n LEFT JOIN app_user u ON u.id = n.author_id
						WHERE n.scenario_id = s.id AND n.project_id = v_project
						  AND n.visibility = 'public_participation' AND n.deleted_at IS NULL
						-- The newest 500, shown oldest first.
						ORDER BY n.created_at DESC, n.id DESC
						LIMIT 500
					) c
				), '[]'::jsonb)
			FROM project pr WHERE pr.id = v_project;
		UPDATE share_link SET last_used_at = now()
		WHERE id = v_link AND (last_used_at IS NULL OR last_used_at <= now() - interval '1 hour');
	END
	$$;
REVOKE ALL ON FUNCTION app_share_scenario(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_share_scenario(bytea) TO water_app;

-- ---------------------------------------------------------------------------
-- 3. note: scenario targets, participation visibilities, revisions
-- ---------------------------------------------------------------------------
ALTER TABLE note ADD COLUMN scenario_id uuid REFERENCES scenario(id) ON DELETE CASCADE;
CREATE INDEX note_scenario_idx ON note (scenario_id);

-- note_one_target, from 037_notes.sql: one target at most, now four kinds.
ALTER TABLE note DROP CONSTRAINT note_one_target;
ALTER TABLE note ADD CONSTRAINT note_one_target CHECK (num_nonnulls(node_id, run_id, setting_key, scenario_id) <= 1);
-- The visibility column's CHECK and note_farm_on_node, from 037: `farm`
-- still needs a node; the three new values need a scenario.
ALTER TABLE note DROP CONSTRAINT note_visibility_check;
ALTER TABLE note ADD CONSTRAINT note_visibility_check
	CHECK (visibility IN ('team', 'farm', 'assessors', 'parties', 'public_participation'));
ALTER TABLE note DROP CONSTRAINT note_farm_on_node;
ALTER TABLE note ADD CONSTRAINT note_farm_on_node CHECK (visibility <> 'farm' OR node_id IS NOT NULL);
ALTER TABLE note ADD CONSTRAINT note_participation_on_scenario
	CHECK (visibility NOT IN ('assessors', 'parties', 'public_participation') OR scenario_id IS NOT NULL);
COMMENT ON COLUMN note.visibility IS
	'team: viewers and above. farm: also the farmers linked to its node (037). assessors | parties | public_participation: a scenario note''s audiences (113, WP-3.15; app_scenario_note_visible).';

-- note_same_project, from 037: the scenario too (assert_same_project above).
DROP TRIGGER note_same_project ON note;
CREATE TRIGGER note_same_project BEFORE INSERT OR UPDATE ON note
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id', 'run_id', 'scenario_id');

-- The current user is one of the application's parties: its owner or someone
-- they shared it with (scenario_member), as a contributor or above.
CREATE FUNCTION app_scenario_party(p_scenario uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v_project uuid;
		v_owner uuid;
	BEGIN
		SELECT s.project_id, s.owner_user_id INTO v_project, v_owner FROM scenario s WHERE s.id = p_scenario;
		IF NOT FOUND OR uid IS NULL THEN
			RETURN false;
		END IF;
		RETURN app_has_role(v_project, 'contributor')
			AND (v_owner = uid OR EXISTS (SELECT 1 FROM scenario_member m WHERE m.scenario_id = p_scenario AND m.user_id = uid));
	END
	$$;

-- Open for public comment: a scenario of this project with a live scenario
-- link, or decided after it was ever shared.
CREATE FUNCTION app_scenario_commentable(p_project uuid, p_scenario uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_status text;
	BEGIN
		-- Members only: it says whether a scenario is open, which no one else asks.
		IF app_project_role(p_project) IS NULL THEN
			RETURN false;
		END IF;
		SELECT s.status INTO v_status FROM scenario s WHERE s.id = p_scenario AND s.project_id = p_project;
		-- Submitted with a live link; or decided, once it was ever shared (an
		-- application never put out for comment stays with its parties).
		RETURN coalesce(
			(v_status IN ('submitted', 'decided') AND EXISTS (
				SELECT 1 FROM share_link l
				WHERE l.target_kind = 'scenario' AND l.target_id = p_scenario AND l.revoked_at IS NULL AND l.expires_at > now()
			))
			OR (v_status = 'decided' AND EXISTS (SELECT 1 FROM share_link l WHERE l.target_kind = 'scenario' AND l.target_id = p_scenario)),
			false);
	END
	$$;

-- Who reads a scenario note of the three participation visibilities (module
-- comment, 3). Its author always does.
CREATE FUNCTION app_scenario_note_visible(p_project uuid, p_scenario uuid, p_visibility text, p_author uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		assessor boolean;
	BEGIN
		IF app_project_role(p_project) IS NULL THEN
			RETURN false;
		END IF;
		IF p_author IS NOT NULL AND p_author = app_current_user_id() THEN
			RETURN true;
		END IF;
		assessor := app_has_role(p_project, 'editor') AND app_scenario_readable(p_scenario);
		IF p_visibility = 'assessors' THEN
			RETURN assessor;
		ELSIF p_visibility = 'parties' THEN
			RETURN assessor OR app_scenario_party(p_scenario);
		ELSIF p_visibility = 'public_participation' THEN
			RETURN assessor OR app_scenario_party(p_scenario)
				OR (app_has_role(p_project, 'contributor') AND app_scenario_commentable(p_project, p_scenario));
		END IF;
		RETURN false;
	END
	$$;

-- Who may post one (module comment, 3).
CREATE FUNCTION app_scenario_note_writable(p_project uuid, p_scenario uuid, p_visibility text) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		assessor boolean;
	BEGIN
		IF app_project_role(p_project) IS NULL THEN
			RETURN false;
		END IF;
		assessor := app_has_role(p_project, 'editor') AND app_scenario_readable(p_scenario);
		IF p_visibility IN ('assessors', 'parties') THEN
			RETURN assessor OR app_scenario_party(p_scenario);
		ELSIF p_visibility = 'public_participation' THEN
			-- Only while it is open, for the assessors too: a public comment is posted during the comment period.
			RETURN app_has_role(p_project, 'contributor') AND app_scenario_commentable(p_project, p_scenario);
		END IF;
		RETURN false;
	END
	$$;

-- note_select, from 045_contributor_scope.sql: `team` and `farm` notes only
-- (the new visibilities have their own policy), and a scenario note only
-- where the scenario is read.
DROP POLICY note_select ON note;
CREATE POLICY note_select ON note FOR SELECT
	USING (
		app_has_role(project_id, 'viewer')
		AND visibility IN ('team', 'farm')
		AND (deleted_at IS NULL OR author_id = app_current_user_id() OR app_has_role(project_id, 'editor'))
		AND (run_id IS NULL OR run_id NOT IN (SELECT app_hidden_scenario_runs()))
		AND (scenario_id IS NULL OR app_scenario_readable(scenario_id))
	);
-- ORed with the above and note_select_farmer (037, unchanged).
CREATE POLICY note_select_scenario ON note FOR SELECT
	USING (
		scenario_id IS NOT NULL
		AND visibility IN ('assessors', 'parties', 'public_participation')
		AND (deleted_at IS NULL OR author_id = app_current_user_id() OR app_has_role(project_id, 'editor'))
		AND app_scenario_note_visible(project_id, scenario_id, visibility, author_id)
	);

-- note_insert, from 037_notes.sql.
DROP POLICY note_insert ON note;
CREATE POLICY note_insert ON note FOR INSERT
	WITH CHECK (
		author_id = app_current_user_id() AND deleted_at IS NULL AND deleted_by IS NULL AND edited_at IS NULL
		AND (
			(app_has_role(project_id, 'viewer') AND visibility IN ('team', 'farm')
				AND (scenario_id IS NULL OR app_scenario_readable(scenario_id)))
			OR (visibility = 'farm' AND node_id IN (SELECT app_farm_nodes(project_id)))
			OR (scenario_id IS NOT NULL AND visibility IN ('assessors', 'parties', 'public_participation')
				AND app_scenario_note_writable(project_id, scenario_id, visibility))
		)
	);
-- note_update (037) is unchanged: the author or an editor, of a note they read.

CREATE TABLE note_revision (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	note_id    uuid NOT NULL REFERENCES note(id) ON DELETE CASCADE,
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The text the edit replaced, and when that text was written.
	body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
	written_at timestamptz NOT NULL,
	-- When it was replaced, and by whom (the author: only they edit, 037).
	edited_at  timestamptz NOT NULL DEFAULT now(),
	edited_by  uuid REFERENCES app_user(id) ON DELETE SET NULL
);
COMMENT ON TABLE note_revision IS
	'Each earlier text of a scenario note, written on every edit (113, WP-3.15): a participation record keeps its history. Read as the note is read; written only by note_write_revision.';
CREATE INDEX note_revision_note_idx ON note_revision (note_id, edited_at);
CREATE INDEX note_revision_project_idx ON note_revision (project_id);
CREATE INDEX note_revision_edited_by_idx ON note_revision (edited_by);

CREATE FUNCTION note_write_revision() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		INSERT INTO note_revision (note_id, project_id, body, written_at, edited_at, edited_by)
		VALUES (OLD.id, OLD.project_id, OLD.body, coalesce(OLD.edited_at, OLD.created_at), coalesce(NEW.edited_at, now()), app_current_user_id());
		RETURN NULL;
	END
	$$;
CREATE TRIGGER note_write_revision AFTER UPDATE OF body ON note
	FOR EACH ROW WHEN (OLD.body IS DISTINCT FROM NEW.body AND NEW.scenario_id IS NOT NULL)
	EXECUTE FUNCTION note_write_revision();

ALTER TABLE note_revision ENABLE ROW LEVEL SECURITY;
-- Readable exactly as its note is: the subquery runs under the caller's note policies.
CREATE POLICY note_revision_select ON note_revision FOR SELECT
	USING (EXISTS (SELECT 1 FROM note n WHERE n.id = note_revision.note_id));
GRANT SELECT ON note_revision TO water_app;

-- A scenario with public comments is kept: deleting it would cascade to the
-- participation record (its notes and their revisions). Only a draft or a
-- withdrawn application can be deleted at all (scenario_guard); this refuses
-- one that drew public comments while it was open. Deleting the whole
-- project still cascades (the project row is gone by then), as for
-- scenario_signed_run_guard (072).
CREATE FUNCTION scenario_comments_kept() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
		   AND EXISTS (SELECT 1 FROM note n WHERE n.scenario_id = OLD.id AND n.visibility = 'public_participation') THEN
			RAISE EXCEPTION 'scenario % has public comments, so it is kept', OLD.id
				USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN OLD;
	END
	$$;
CREATE TRIGGER scenario_comments_kept BEFORE DELETE ON scenario
	FOR EACH ROW EXECUTE FUNCTION scenario_comments_kept();
REVOKE ALL ON FUNCTION scenario_comments_kept() FROM PUBLIC, water_app;

-- Whether a scenario of this project drew public comments (the delete route's
-- clear 409; its owner may not read every comment on it). Members only.
CREATE FUNCTION app_scenario_has_public_comments(p_project uuid, p_scenario uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_project_role(p_project) IS NULL THEN
			RETURN false;
		END IF;
		RETURN EXISTS (SELECT 1 FROM note n WHERE n.project_id = p_project AND n.scenario_id = p_scenario AND n.visibility = 'public_participation');
	END
	$$;

-- ---------------------------------------------------------------------------
-- 4. app_subject_export, from 092_signoff_registration.sql: a note carries
-- its scenario and its earlier texts (same signature, SECURITY DEFINER and
-- search_path; 054's REVOKE / GRANT stand, CREATE OR REPLACE keeps them).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_subject_export() RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		me uuid := app_current_user_id();
		my_email citext;
		verified boolean;
		max_events constant integer := 50000;
		events jsonb;
		n_events integer;
	BEGIN
		IF me IS NULL THEN
			RETURN NULL;
		END IF;
		SELECT u.email, u.email_verified_at IS NOT NULL INTO my_email, verified FROM app_user u WHERE u.id = me;
		IF NOT FOUND THEN
			RETURN NULL;
		END IF;

		SELECT coalesce(jsonb_agg(x.ev ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb), count(*)
		INTO events, n_events
		FROM (
			SELECT jsonb_build_object(
				'id', e.id,
				'projectId', e.project_id,
				'projectName', p.name,
				'kind', e.kind,
				'at', e.created_at,
				'actor', e.actor_label,
				'byYou', e.actor_user_id IS NOT DISTINCT FROM me,
				'subject', e.subject
			) AS ev, e.created_at, e.id
			FROM audit_event e
			JOIN project p ON p.id = e.project_id
			WHERE e.actor_user_id = me
			   OR (e.subject ? 'userId' AND e.subject->>'userId' = me::text)
			   OR (e.kind = 'note.deleted' AND e.subject->>'authorId' = me::text)
			ORDER BY e.created_at DESC, e.id DESC
			LIMIT max_events + 1
		) x;
		IF n_events > max_events THEN
			events := events - max_events;
		END IF;

		RETURN jsonb_build_object(
			'auditEvents', events,
			'auditEventsTruncated', n_events > max_events,
			'invites', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', i.id,
					'projectId', i.project_id,
					'projectName', p.name,
					'projectRole', i.project_role,
					'teamId', i.team_id,
					'teamName', t.name,
					'teamRole', i.team_role,
					'invitedBy', u.display_name,
					'language', i.locale,
					'createdAt', i.created_at,
					'lastSentAt', i.last_sent_at,
					'expiresAt', i.expires_at,
					'farms', (
						SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId', n.id, 'name', n.name) ORDER BY n.name), '[]'::jsonb)
						FROM invite_node inn JOIN node n ON n.id = inn.node_id WHERE inn.invite_id = i.id
					)
				) ORDER BY i.created_at DESC), '[]'::jsonb)
				FROM invite i
				LEFT JOIN project p ON p.id = i.project_id
				LEFT JOIN team t ON t.id = i.team_id
				LEFT JOIN app_user u ON u.id = i.invited_by
				WHERE verified AND i.email = my_email
			),
			'notes', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', nt.id,
					'projectId', nt.project_id,
					'projectName', p.name,
					'body', nt.body,
					'visibility', nt.visibility,
					'nodeId', nt.node_id,
					'nodeName', n.name,
					'runId', nt.run_id,
					'settingKey', nt.setting_key,
					'scenarioId', nt.scenario_id,
					'createdAt', nt.created_at,
					'editedAt', nt.edited_at,
					'deletedAt', nt.deleted_at,
					'revisions', (
						SELECT coalesce(jsonb_agg(jsonb_build_object(
							'body', rv.body,
							'writtenAt', rv.written_at,
							'editedAt', rv.edited_at
						) ORDER BY rv.edited_at, rv.id), '[]'::jsonb)
						FROM note_revision rv WHERE rv.note_id = nt.id
					)
				) ORDER BY nt.created_at DESC), '[]'::jsonb)
				FROM note nt
				JOIN project p ON p.id = nt.project_id
				LEFT JOIN node n ON n.id = nt.node_id
				WHERE nt.author_id = me
			),
			'signoffs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', s.id,
					'projectId', s.project_id,
					'projectName', p.name,
					'runId', s.run_id,
					'fullName', s.full_name,
					'registrationBody', s.registration_body,
					'registrationCategory', s.registration_category,
					'registrationField', s.registration_field,
					'registrationNo', s.registration_no,
					'scope', s.scope,
					'statementVersion', s.statement_version,
					'statementSha256', s.statement_sha256,
					'disclaimerVersion', s.disclaimer_version,
					'signedAt', s.signed_at
				) ORDER BY s.signed_at DESC), '[]'::jsonb)
				FROM signoff s JOIN project p ON p.id = s.project_id
				WHERE s.user_id = me
			),
			'alertSubscriptions', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'projectId', a.project_id,
					'projectName', p.name,
					'kind', a.kind,
					'nodeId', a.node_id,
					'nodeName', n.name,
					'channel', a.channel,
					'mode', a.mode,
					'createdAt', a.created_at,
					'updatedAt', a.updated_at
				) ORDER BY p.name, a.kind), '[]'::jsonb)
				FROM alert_subscription a
				JOIN project p ON p.id = a.project_id
				LEFT JOIN node n ON n.id = a.node_id
				WHERE a.user_id = me
			),
			'reportSubscriptions', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'projectId', rs.project_id,
					'projectName', p.name,
					'frequency', rs.frequency,
					'weekday', rs.weekday,
					'monthDay', rs.month_day,
					'hour', rs.hour,
					'timezone', rs.timezone,
					'enabled', rs.enabled
				) ORDER BY p.name), '[]'::jsonb)
				FROM report_schedule_recipient r
				JOIN report_schedule rs ON rs.id = r.schedule_id
				JOIN project p ON p.id = rs.project_id
				WHERE r.user_id = me
			)
		);
	END
	$$;
