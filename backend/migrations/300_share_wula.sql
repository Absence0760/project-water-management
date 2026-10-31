-- 300_share_wula — an application's share link prints the water-use licence
-- application (WULA) it models (294_wula_reference; docs/followups.md "The
-- WULA reference on the share link"; docs/scenarios.md § The WULA reference,
-- docs/security.md § Scenario links, docs/data-model.md § Share links,
-- docs/api.md § Share).
--
-- 294 added scenario.wula_number and wula_works and left the share link's
-- projection alone (its header says the link doesn't show the reference);
-- this migration is where the link starts showing it, so a public reader can
-- match the application to the authority's notice.
--
-- Expand only. app_share_scenario keeps its signature and its columns; the
-- `scenario` object gains one key, from an allowlist as before:
--
--   wula   submitted or decided: { number, works: [{ ref, text }] }, the
--          WULA's number and the works as applied for, frozen once
--          submitted (scenario_wula_frozen, 294); NULL when neither was
--          given. The works' text is the applicant's own words, as the
--          scenario's name and description the link already shows. Each
--          op's `works` tag (a ref of that list) reaches the link inside the
--          ops, and goes with an op app_share_kept leaves out.
--
-- Changes (from its latest definition):
--   app_share_scenario   from 291_share_licence_terms.sql: the `wula` key;
--                        everything else as it was.
-- No table, policy or grant changes. No personal data beyond what the
-- applicant wrote about their own application.

-- app_share_scenario, from 291: and the WULA reference (module comment).
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
					-- 300: the WULA reference (294), when one was given: its number and the works as applied for.
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
