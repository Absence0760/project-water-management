-- 094_role_check_no_user — app_project_role returns at once when the session
-- has no user. Latest definition: 026_rls_role_plpgsql (body otherwise
-- unchanged: same signature, result, volatility, SECURITY DEFINER and pinned
-- search_path).
--
-- Why: a session with no user (an API key, withAPIKey; the job queue and
-- pre-sign-in auth, withoutUser) passes uid = NULL into the role query.
-- PL/pgSQL plans that query through the plan cache, which builds a custom
-- plan for the first five calls and then keeps the generic plan only if it
-- costs no more than the custom ones did on average. With uid NULL each
-- custom plan folds `user_id = NULL` to a constant false and costs nothing,
-- so the generic plan always looks dearer and the query is planned again on
-- every call: ~150 us a row, against ~5 us once a user is set. Every policy
-- calls app_has_role once per row, so a key's statement over a table paid
-- that per row it scanned (the ingest key sweep, ingest.security.db.test.ts,
-- spent a second on each statement over a 6,500-row run_series and timed out
-- in CI). A session with no user holds no role, so the query can't find one:
-- NULL straight away is the same answer (app_has_role still turns it into
-- false).

CREATE OR REPLACE FUNCTION app_project_role(p_project uuid) RETURNS project_role
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RETURN NULL;
		END IF;
		RETURN (
			SELECT max(r) FROM (
				SELECT role AS r FROM project_member
				WHERE project_id = p_project AND user_id = uid
				UNION ALL
				SELECT CASE tm.role::text
						WHEN 'admin' THEN 'owner'::project_role
						WHEN 'member' THEN 'editor'::project_role
						WHEN 'viewer' THEN 'viewer'::project_role
					END
				FROM project p JOIN team_member tm ON tm.team_id = p.team_id
				WHERE p.id = p_project AND tm.user_id = uid
			) roles
		);
	END
	$$;
