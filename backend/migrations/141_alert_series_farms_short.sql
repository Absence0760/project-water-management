-- 141_alert_series_farms_short — two alert follow-ups (issue #120; docs/data-model.md
-- § Alerts, alerts/rules.ts, alerts/evaluate.ts):
--
-- 1. data_stale per ingest-key series. 057 gave data_stale one rule per data
--    feed, measured from data_feed.last_data_date, so a logger pushing through
--    an API key (039) could go silent with no alert. A data_stale rule may now
--    name a series instead of a feed (alert_rule.series_id): its value is the
--    days since the series' last non-blank day (series/lastDay.ts), past one
--    day for today's reading. Only series an API key wrote get a rule (a
--    series_key_days row, 053, when the rule is first made): a hand-uploaded
--    series is stale by nature, and a rule on it would only be noise. Once
--    made, the rule stays with its series (a person's later edit releases the
--    key's days, 053, but the logger is still expected), and goes with it
--    (ON DELETE CASCADE). Same audience, choices and mail as a feed's rule.
--
-- 2. farms_short: farms short of water on the current publication's last 7
--    days of data (catchment_view.recent.farmsShort7, WP-2.14), for the WUA's
--    staff (editors and owners immediately, viewers may opt in; never a
--    farmer: the counts are the staff-only part of the publication). Only
--    while the current publication was published automatically (an auto run,
--    publish/autoPublish.ts): a person's publication is the WUA's own act, and
--    they saw its figures when they made it. run_publication.auto records
--    which, set on insert only (no UPDATE grant), and is backfilled from the
--    audit log's publication.published events, which have carried `auto`
--    since WP-2.11.
--
-- RLS is unchanged: alert_rule's policies cover the new column, and
-- run_publication's the new flag. The grants at the end restate the tables'
-- existing ones (INSERT covers the new columns): run_publication.auto is in
-- no UPDATE grant, and alert_rule_check refuses a change of series_id.

-- ---------------------------------------------------------------------------
-- run_publication.auto
-- ---------------------------------------------------------------------------
ALTER TABLE run_publication ADD COLUMN auto boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN run_publication.auto IS
	'Published by an auto run on its own (settings.autoRun.publish, publish/autoPublish.ts), not by a person (141). Set on insert, never changed.';

-- The backfill: the trigger is off so a superseded publication (history,
-- which run_publication_final keeps unchanged) gets its flag too, as 081 did.
ALTER TABLE run_publication DISABLE TRIGGER run_publication_final;
UPDATE run_publication p SET auto = true
FROM audit_event e
WHERE e.project_id = p.project_id AND e.kind = 'publication.published'
  AND e.subject->>'auto' = 'true' AND e.subject->>'publicationId' = p.id::text;
ALTER TABLE run_publication ENABLE TRIGGER run_publication_final;

-- ---------------------------------------------------------------------------
-- alert_rule: the farms_short kind, and a series on a data_stale rule
-- ---------------------------------------------------------------------------
ALTER TABLE alert_rule DROP CONSTRAINT alert_rule_kind_check;
ALTER TABLE alert_rule ADD CONSTRAINT alert_rule_kind_check
	CHECK (kind IN ('dam_below', 'ewr_forecast_fail', 'data_stale', 'restriction_published', 'job_dead', 'feed_failing', 'farms_short'));

-- The threshold per kind, from its definition in 051 (alert_rule_check1), plus
-- farms_short: a whole number of farms.
ALTER TABLE alert_rule DROP CONSTRAINT alert_rule_check1;
ALTER TABLE alert_rule ADD CONSTRAINT alert_rule_threshold CHECK (CASE kind
	WHEN 'dam_below' THEN threshold > 0 AND threshold < 1
	WHEN 'ewr_forecast_fail' THEN threshold BETWEEN 1 AND 60 AND threshold = trunc(threshold)
	WHEN 'data_stale' THEN threshold BETWEEN 1 AND 60 AND threshold = trunc(threshold)
	WHEN 'feed_failing' THEN threshold BETWEEN 1 AND 20 AND threshold = trunc(threshold)
	WHEN 'job_dead' THEN threshold BETWEEN 1 AND 100 AND threshold = trunc(threshold)
	WHEN 'farms_short' THEN threshold BETWEEN 1 AND 1000 AND threshold = trunc(threshold)
	ELSE threshold = 0
END);

-- The series a data_stale rule watches. A composite key, so the series is
-- always one of the rule's own project's (time_series_project_id_id_key, 053).
ALTER TABLE alert_rule ADD COLUMN series_id uuid;
ALTER TABLE alert_rule ADD CONSTRAINT alert_rule_series_fkey
	FOREIGN KEY (project_id, series_id) REFERENCES time_series (project_id, id) ON DELETE CASCADE;
CREATE INDEX alert_rule_series_idx ON alert_rule (project_id, series_id);
COMMENT ON COLUMN alert_rule.series_id IS
	'The ingest-key series a data_stale rule watches (141); NULL for a feed''s rule and every other kind.';
ALTER TABLE alert_rule ADD CONSTRAINT alert_rule_series_kind CHECK (series_id IS NULL OR kind = 'data_stale');
ALTER TABLE alert_rule ADD CONSTRAINT alert_rule_feed_or_series CHECK (feed_id IS NULL OR series_id IS NULL);

-- One rule per kind, farm, feed and series per project; also covers project_id.
DROP INDEX alert_rule_key_idx;
CREATE UNIQUE INDEX alert_rule_key_idx ON alert_rule (project_id, kind, node_id, feed_id, series_id) NULLS NOT DISTINCT;

-- alert_rule_check, from its latest definition (066): a rule's series never
-- changes either (the pending feed-less rule adopts a feed, never a series).
CREATE OR REPLACE FUNCTION alert_rule_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node WHERE id = NEW.node_id AND kind = 'farm') THEN
			RAISE EXCEPTION 'node % is not a farm', NEW.node_id USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.feed_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM data_feed WHERE id = NEW.feed_id AND project_id = NEW.project_id) THEN
			RAISE EXCEPTION 'feed % belongs to a different project', NEW.feed_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' THEN
			NEW.created_by := app_current_user_id();
			NEW.created_at := now();
		ELSE
			-- The creator stays, except that an account going (created_by's ON
			-- DELETE SET NULL, run after its app_user row is gone) clears who.
			NEW.created_by := CASE
				WHEN NEW.created_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = OLD.created_by) THEN NULL
				ELSE OLD.created_by
			END;
			NEW.created_at := OLD.created_at;
			-- A feed-less data_stale rule (057's conversion) may be given its feed once.
			IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
				OR (NEW.feed_id IS DISTINCT FROM OLD.feed_id AND OLD.feed_id IS NOT NULL)
				OR NEW.series_id IS DISTINCT FROM OLD.series_id THEN
				RAISE EXCEPTION 'a rule''s kind, farm, feed and series never change' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- alert_subscription: a choice for farms_short
-- ---------------------------------------------------------------------------
ALTER TABLE alert_subscription DROP CONSTRAINT alert_subscription_kind_check;
ALTER TABLE alert_subscription ADD CONSTRAINT alert_subscription_kind_check
	CHECK (kind IN ('dam_below', 'ewr_forecast_fail', 'data_stale', 'restriction_published', 'job_dead', 'feed_failing', 'farms_short', 'all'));

-- ---------------------------------------------------------------------------
-- alert_audience, from its latest definition (051), with farms_short:
--
--   kind                   default immediate          may opt in
--   farms_short            editors, owners            viewers
--
-- A farmer never gets it (neighbours' shortfalls are staff-only figures).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION alert_audience(p_project uuid, p_kind text, p_node uuid)
	RETURNS TABLE (user_id uuid, role project_role, mode text)
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		WITH roles AS (
			SELECT x.user_id, max(x.r) AS role FROM (
				SELECT m.user_id, m.role AS r FROM project_member m WHERE m.project_id = p_project
				UNION ALL
				SELECT tm.user_id, CASE tm.role::text
						WHEN 'admin' THEN 'owner'::project_role
						WHEN 'member' THEN 'editor'::project_role
						WHEN 'viewer' THEN 'viewer'::project_role
					END
				FROM project p JOIN team_member tm ON tm.team_id = p.team_id
				WHERE p.id = p_project
			) x WHERE x.r IS NOT NULL
			GROUP BY x.user_id
		), eligible AS (
			SELECT r.user_id, r.role,
				CASE
					WHEN r.role = 'contributor' THEN NULL
					WHEN p_kind = 'dam_below' THEN CASE
						WHEN r.role = 'farmer' THEN CASE WHEN EXISTS (
							SELECT 1 FROM farm_link fl WHERE fl.project_id = p_project AND fl.node_id = p_node AND fl.user_id = r.user_id
						) THEN 'immediate' END
						WHEN r.role >= 'editor' THEN 'immediate'
						ELSE 'off' END
					WHEN p_kind IN ('ewr_forecast_fail', 'farms_short') THEN CASE WHEN r.role >= 'editor' THEN 'immediate' WHEN r.role = 'viewer' THEN 'off' END
					WHEN p_kind = 'data_stale' THEN CASE WHEN r.role >= 'editor' THEN 'immediate' END
					WHEN p_kind = 'restriction_published' THEN 'immediate'
					WHEN p_kind IN ('job_dead', 'feed_failing') THEN CASE WHEN r.role = 'owner' THEN 'immediate' WHEN r.role = 'editor' THEN 'off' END
				END AS default_mode
			FROM roles r
		)
		SELECT e.user_id, e.role, COALESCE(sn.mode, sk.mode, e.default_mode)
		FROM eligible e
		LEFT JOIN alert_subscription sn ON p_node IS NOT NULL AND sn.user_id = e.user_id AND sn.project_id = p_project
			AND sn.kind = p_kind AND sn.node_id = p_node
		LEFT JOIN alert_subscription sk ON sk.user_id = e.user_id AND sk.project_id = p_project AND sk.kind = p_kind AND sk.node_id IS NULL
		WHERE e.default_mode IS NOT NULL
		  AND NOT EXISTS (
			SELECT 1 FROM alert_subscription sa
			WHERE sa.user_id = e.user_id AND sa.project_id = p_project AND sa.kind = 'all' AND sa.mode = 'off'
		  )
	$$;
REVOKE ALL ON FUNCTION alert_audience(uuid, text, uuid) FROM PUBLIC, water_app;

-- The grants these tables already have (051, 022), restated so this file
-- says what water_app may do with the new columns (see the header).
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_rule TO water_app;
GRANT SELECT, INSERT, DELETE ON run_publication TO water_app;
