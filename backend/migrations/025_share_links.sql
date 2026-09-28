-- 025_share_links — read-only share links to a project's published baseline
-- (roadmap WP-2.3 phase 2; docs/data-model.md § Share links, docs/security.md
-- § Share links, docs/api.md § Share).
--
-- An owner creates a link for someone outside the project (a municipality, a
-- catchment forum, a journalist). The link's URL carries a 32-byte random
-- token in its fragment (/share#t=…); only the token's SHA-256 is stored, as
-- for the emailed tokens (004_email.sql). Whoever holds a live link reads,
-- through two SECURITY DEFINER functions and nothing else:
--
--   app_share_view    the current publication's catchment-level view: the
--                     project name, who published it and when, the WUA's
--                     notice, and catchment_view's counts and dates (EWR
--                     days not met at the outlet and gauges). Never the
--                     modeller's note, never a farm row, name or id.
--   app_share_series  the published run's catchment flow series (the five
--                     keys below) as monthly means plus the last 365 days,
--                     and only when the catchment has at least FARMER_K (5)
--                     farm holders. Below that, flow volumes would reveal a
--                     small catchment's farms (natural flow minus outflow is
--                     their use: docs/design/farmer-view.md §10.3).
--
-- Both answer nothing (no row) for an unknown, revoked or expired token, or a
-- project with no current publication, and the API turns that into one 404,
-- so a caller can't tell those apart.
--
-- Rows are never deleted by the app (they go with their project): a revoked
-- link is the record of who made it and who withdrew it until the audit log
-- (WP-2.4, issue #28) records both as events.

CREATE TABLE share_link (
	id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The owner's own reminder of who it was for ("Catchment forum, March").
	label        text NOT NULL DEFAULT '' CHECK (length(label) <= 100),
	-- SHA-256 of the token. Never the token itself.
	token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
	created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at   timestamptz NOT NULL DEFAULT now(),
	-- 1–365 days (the API's expiresInDays).
	expires_at   timestamptz NOT NULL,
	revoked_at   timestamptz,
	revoked_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
	-- Bumped by app_share_view at most once an hour.
	last_used_at timestamptz,
	CHECK (expires_at > created_at AND expires_at <= created_at + interval '365 days'),
	-- Whoever revoked it may since have been deleted (SET NULL), never the reverse.
	CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);
COMMENT ON TABLE share_link IS
	'Read-only links to a project''s current publication (025, WP-2.3 phase 2). Owner only; the public reads only through app_share_view / app_share_series. Token stored as SHA-256.';

-- The owner's list (newest first); also covers the project_id foreign key.
CREATE INDEX share_link_project_idx ON share_link (project_id, created_at DESC);
CREATE INDEX share_link_created_by_idx ON share_link (created_by);
CREATE INDEX share_link_revoked_by_idx ON share_link (revoked_by);

-- A link is made by the signed-in owner, now; the rest is the caller's.
CREATE FUNCTION share_link_issue() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		NEW.created_by := app_current_user_id();
		NEW.created_at := now();
		NEW.revoked_at := NULL;
		NEW.revoked_by := NULL;
		NEW.last_used_at := NULL;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER share_link_issue BEFORE INSERT ON share_link
	FOR EACH ROW EXECUTE FUNCTION share_link_issue();

-- ---------------------------------------------------------------------------
-- Row-level security: owners only, for every operation water_app has. No
-- DELETE (see above): a link is withdrawn by setting revoked_at.
-- ---------------------------------------------------------------------------
ALTER TABLE share_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY share_link_select ON share_link FOR SELECT USING (app_has_role(project_id, 'owner'));
CREATE POLICY share_link_insert ON share_link FOR INSERT
	WITH CHECK (app_has_role(project_id, 'owner') AND created_by = app_current_user_id());
CREATE POLICY share_link_update ON share_link FOR UPDATE
	USING (app_has_role(project_id, 'owner')) WITH CHECK (app_has_role(project_id, 'owner'));

GRANT SELECT, INSERT ON share_link TO water_app;
GRANT UPDATE (revoked_at, revoked_by) ON share_link TO water_app;

-- ---------------------------------------------------------------------------
-- The public reads
-- ---------------------------------------------------------------------------

-- What a live link shows: the current publication of its project, catchment
-- level only. catchment_view is rebuilt from an allowlist of its keys rather
-- than passed through, so a field a later migration adds to it (a total of
-- farm quantities, D2) doesn't reach the public without a decision here. The
-- outlet's name is dropped: the outflow node may be a farm (a gauge site is
-- a gauge, public infrastructure, design §10.1). Bumps last_used_at at most
-- once an hour, and only when it answers.
CREATE FUNCTION app_share_view(p_hash bytea)
	RETURNS TABLE (
		project_name text,
		published_at timestamptz,
		published_by text,
		catchment_view jsonb,
		restriction_level text,
		restriction_pct numeric,
		notice_en text,
		notice_af text,
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
		WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now();
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
				p.restriction_level, p.restriction_pct, p.notice_en, p.notice_af, p.next_expected_on
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

-- One catchment series of the current publication's run: the monthly means
-- (NULL for a month with no value; NaN, the engine's "no reading", counts as
-- none) and the last 365 days. Only the catchment allowlist, never a node's
-- series, and only with at least 5 farm holders (FARMER_K in
-- packages/engine/src/views/farmView.ts; share.db.test.ts pins the two
-- together). Holders are counted from nobody's point of view, as
-- app_other_farm_holders (020) counts them: the farms linked to one user
-- count once, an unlinked farm counts on its own.
CREATE FUNCTION app_share_series(p_hash bytea, p_key text)
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
			WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now()
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
