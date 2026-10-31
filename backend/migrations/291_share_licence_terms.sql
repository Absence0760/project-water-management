-- 291_share_licence_terms — a decided application's share link prints the
-- licence's granted terms and what followed the decision (issue #523 G3/G4;
-- docs/followups.md § Licence terms and appeals; docs/security.md § Scenario
-- links; docs/data-model.md § Share links; docs/api.md § Share).
--
-- Until now app_share_scenario (115) gave a decided application's outcome and
-- the assessor's note, but not the terms a licence was issued on (227) nor
-- the appeals lodged against the decision and their outcomes (228), so a
-- reader couldn't tell what was granted or whether it still stands; nor the
-- water-use licence application (WULA) it models (294), so a reader couldn't
-- match it to the authority's notice.
--
-- Expand only. app_share_scenario keeps its signature and its columns; the
-- `scenario` object gains four keys, each from an allowlist as before:
--
--   grantedTerms   with a licence issued (227): the granted ops and their
--                  hash, the names of the application's own nodes among
--                  granted_op_names only (every other node stays an id, as
--                  opNames), the conditions in words (the licence's, a public
--                  record as the decision note is) and whether they are the
--                  ops applied for. NULL with any other outcome.
--   decisionEvents what followed the decision (228), oldest first (the newest
--                  100): position, kind, forum, date, reference and note, and
--                  a variation's terms in grantedTerms' shape. Never who
--                  recorded it or when (a member's identity; the link names
--                  no member but a public comment's author).
--   licence        app_scenario_licence's standing (228): in force or not,
--                  from the decision or an event (by its position, not its
--                  id), and whether an appeal is open. Its terms are not
--                  repeated: they are grantedTerms or the event's.
--   wula           the WULA reference (294: scenario.wula_number and
--                  wula_works), submitted or decided: its number and the
--                  works as applied for ({ ref, text }), frozen once
--                  submitted (scenario_wula_frozen). NULL when neither was
--                  given. The works' text is the applicant's own words, as
--                  the scenario's name and description the link already
--                  shows. Each op's `works` tag (a ref of that list) reaches
--                  the link inside the ops, and goes with a withheld op.
--                  The columns are 294's: this body is PL/pgSQL, bound when
--                  it runs (`s` is a record), and nothing calls it between
--                  291 and 294 in a migration run.
--
-- A registered volume on another unit (an `allocation.set` op whose unit
-- isn't the application's own) is left out of every list of ops here, in the
-- function, as for a viewer kept from each farm's volume (#523 G1): the
-- application's ops, the granted terms' and each variation's, and each
-- candidate run's `classified` at the same positions. Each list says how many
-- it left out (`withheldOps`). The API (share/links.ts, withheldAllocationOps)
-- filters again as a second line; no caller has to. Each opsSha256 stays the
-- stored hash of the full list (the run's and the decision's identity), so it
-- doesn't verify the ops the link shows when any were left out.
--
-- Changes (each from its latest definition):
--   app_share_scenario   from 115_scenario_share_notes.sql (unchanged since):
--                        the four keys above, `withheldOps`, and its ops and
--                        each run's `classified` without the withheld ones;
--                        everything else as it was.
--   app_share_kept       new helper, not callable by water_app.
--   app_share_terms      new helper, not callable by water_app.

-- `p_list`'s elements at the positions where `p_ops` holds no withheld op
-- (an `allocation.set` whose unit isn't among `p_owned`), in order: a list of
-- ops filtered by itself, or a run's per-op classes by the ops. A `p_list`
-- that isn't an array comes back as it is. Called only from the share
-- functions here; not callable by water_app.
CREATE FUNCTION app_share_kept(p_list jsonb, p_ops jsonb, p_owned text[]) RETURNS jsonb
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
	SELECT CASE WHEN jsonb_typeof(p_list) IS DISTINCT FROM 'array' THEN p_list ELSE coalesce((
		SELECT jsonb_agg(x.v ORDER BY x.o)
		FROM jsonb_array_elements(p_list) WITH ORDINALITY x(v, o)
		LEFT JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(p_ops) = 'array' THEN p_ops ELSE '[]'::jsonb END) WITH ORDINALITY op(v, o) ON op.o = x.o
		WHERE NOT (op.v->>'op' = 'allocation.set' AND (op.v->'allocation'->>'nodeId' = ANY (coalesce(p_owned, '{}'))) IS NOT TRUE)
			OR op.v IS NULL
	), '[]'::jsonb) END
	$$;
REVOKE ALL ON FUNCTION app_share_kept(jsonb, jsonb, text[]) FROM PUBLIC, water_app;

-- One set of licence terms as a link shows it (module comment). Called only
-- from app_share_scenario; not callable by water_app.
CREATE FUNCTION app_share_terms(p_ops jsonb, p_sha text, p_names jsonb, p_conditions text, p_applied_sha text, p_owned text[]) RETURNS jsonb
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
	SELECT CASE WHEN p_ops IS NULL THEN NULL ELSE jsonb_build_object(
		-- Another unit's registered volume left out (module comment); the hash is the full list's.
		'ops', app_share_kept(p_ops, p_ops, p_owned),
		'withheldOps', jsonb_array_length(CASE WHEN jsonb_typeof(p_ops) = 'array' THEN p_ops ELSE '[]'::jsonb END)
			- jsonb_array_length(CASE WHEN jsonb_typeof(p_ops) = 'array' THEN app_share_kept(p_ops, p_ops, p_owned) ELSE '[]'::jsonb END),
		'opsSha256', p_sha,
		'opNames', coalesce((
			SELECT jsonb_agg(x.v ORDER BY x.o)
			FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_names) = 'array' THEN p_names ELSE '[]'::jsonb END) WITH ORDINALITY x(v, o)
			WHERE x.v->>'id' = ANY (p_owned)
		), '[]'::jsonb),
		'conditions', coalesce(p_conditions, ''),
		'asApplied', p_sha IS NOT DISTINCT FROM p_applied_sha
	) END
	$$;
REVOKE ALL ON FUNCTION app_share_terms(jsonb, text, jsonb, text, text, text[]) FROM PUBLIC, water_app;

-- app_share_scenario, from 115: the licence's terms, the events after the
-- decision and its standing (module comment). No row for an unknown,
-- revoked, expired or untargeted token, a scenario gone or not submitted or
-- decided. Bumps last_used_at at most once an hour.
CREATE OR REPLACE FUNCTION app_share_scenario(p_hash bytea)
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
		v_licence jsonb;
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
		-- 291: the licence's standing (228), its event named by position, never by id.
		v_licence := app_scenario_licence(s.id);

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
					-- 291: another unit's registered volume left out, and how many (module comment);
					-- the hash stays the full list's.
					'ops', app_share_kept(s.ops, s.ops, s.owned_node_ids::text[]),
					'withheldOps', jsonb_array_length(s.ops) - jsonb_array_length(app_share_kept(s.ops, s.ops, s.owned_node_ids::text[])),
					'opsSha256', s.ops_sha256,
					'ownedNodeIds', to_jsonb(s.owned_node_ids),
					'opNames', coalesce((
						SELECT jsonb_agg(x.v ORDER BY x.o)
						FROM jsonb_array_elements(s.op_names) WITH ORDINALITY x(v, o)
						WHERE x.v->>'id' = ANY (s.owned_node_ids::text[])
					), '[]'::jsonb),
					-- 291: the granted terms (227), with a licence issued only.
					'grantedTerms', CASE WHEN s.status = 'decided' AND s.outcome = 'licence_issued' THEN
						app_share_terms(s.granted_ops, s.granted_ops_sha256, s.granted_op_names, s.granted_conditions, s.ops_sha256, s.owned_node_ids::text[]) END,
					-- 291: what followed the decision (228), the newest 100, oldest first; never who recorded it.
					'decisionEvents', coalesce((
						SELECT jsonb_agg(e.j ORDER BY e.position)
						FROM (
							SELECT de.position, jsonb_build_object(
								'position', de.position,
								'kind', de.kind,
								'forum', de.forum,
								'eventDate', to_char(de.event_date, 'YYYY-MM-DD'),
								'reference', de.reference,
								'note', de.note,
								'terms', app_share_terms(de.ops, de.ops_sha256, de.op_names, de.conditions, s.ops_sha256, s.owned_node_ids::text[])
							) AS j
							FROM decision_event de
							WHERE de.scenario_id = s.id AND de.project_id = v_project AND s.status = 'decided'
							ORDER BY de.position DESC
							LIMIT 100
						) e
					), '[]'::jsonb),
					-- 291: the WULA reference (294), when one was given: its number and the works as applied for.
					'wula', CASE WHEN s.wula_number IS NULL AND jsonb_array_length(s.wula_works) = 0 THEN NULL ELSE jsonb_build_object(
						'number', s.wula_number,
						'works', coalesce((
							SELECT jsonb_agg(jsonb_build_object('ref', w.v->>'ref', 'text', w.v->>'text') ORDER BY w.o)
							FROM jsonb_array_elements(s.wula_works) WITH ORDINALITY w(v, o)
						), '[]'::jsonb)
					) END,
					-- 291: whether the licence stands now, and from what (app_scenario_licence, 228).
					'licence', CASE WHEN v_licence IS NULL THEN NULL ELSE jsonb_build_object(
						'inForce', coalesce((v_licence->>'inForce')::boolean, false),
						'from', v_licence->>'from',
						'eventPosition', (SELECT de.position FROM decision_event de WHERE de.id = (v_licence->>'eventId')::uuid AND de.scenario_id = s.id),
						'appealPending', coalesce((v_licence->>'appealPending')::boolean, false)
					) END
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
							-- Each op's class as this run applied it (proposal | baseline), at the
							-- positions of the ops the link shows (291).
							'classified', app_share_kept(r.inputs->'scenario'->'classified', s.ops, s.owned_node_ids::text[]),
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
