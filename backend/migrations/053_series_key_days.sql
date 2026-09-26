-- 053_series_key_days — which days of a series each API key wrote, so the
-- ingest hold judges a key's push without any of that key's own days
-- (followups.md "The ingest hold's outlier limit still counts a key's earlier
-- pushes"; series/hold.ts; docs/security.md § API keys; docs/data-model.md
-- § API keys).
--
-- The hold (WP-2.16) takes the engine's outlier limit from the series
-- without the pushed days. Days the same key pushed before still counted,
-- so a leaked key that poisons slowly (batches just under the limit) could
-- lift the 99th percentile it is later judged by. Now each series remembers
-- the days each key changed, and the limit leaves all of them out.
--
-- * A side table keyed by (series, key), not a column on time_series like
--   031's feed_days: a series has at most one feed (data_feed's UNIQUE
--   target), but any number of keys may write it (allowed_series NULL means
--   every series), so the days are per key. A datemultirange per row, as
--   feed_days: a key writes runs of days, and dates don't move when the
--   series is extended backwards.
-- * Composite foreign keys keep the series and the key in the row's project;
--   both cascade (a deleted series or project takes its rows; keys are never
--   deleted by the app, 039, but go with their project).
-- * Written by series/merge.ts mergeSeries in the same transaction as the
--   series row, which it already locks:
--     - a key's merge adds the days whose value it changed (not the ones it
--       re-sent unchanged: a value a person put there stays theirs);
--     - anyone else's write releases the days it covers from every key: a
--       person's or a feed's merge the days it writes, a whole replace or a
--       restore (series/routes.ts replaceSeries) all of them. Those values
--       are no longer the key's.
-- * RLS, both contexts:
--     - a key (withApiKey) reads, adds and grows its own rows, for series of
--       its project it may write (app_api_key_project, app_api_key_allows,
--       as 039's time_series policies);
--     - an editor reads, shrinks and deletes the project's rows (every write
--       to a series is an editor's).
--   series_key_days_guard holds each context to its direction: a key only
--   adds days, a person only releases them, and no one moves a row to
--   another series, key or project. So an editor can't mark a person's days
--   as a key's (which would drop them from the limit), and a key can't clear
--   its own record.
-- * No backfill: days keys pushed before this migration are nobody's
--   (nothing is deployed yet), so they count, as before.

ALTER TABLE time_series ADD CONSTRAINT time_series_project_id_id_key UNIQUE (project_id, id);
ALTER TABLE api_key ADD CONSTRAINT api_key_project_id_id_key UNIQUE (project_id, id);

CREATE TABLE series_key_days (
	project_id uuid NOT NULL,
	series_id  uuid NOT NULL,
	api_key_id uuid NOT NULL,
	-- The days whose value this key wrote and nobody has written since.
	days       datemultirange NOT NULL CHECK (NOT isempty(days)),
	PRIMARY KEY (project_id, series_id, api_key_id),
	FOREIGN KEY (project_id, series_id) REFERENCES time_series (project_id, id) ON DELETE CASCADE,
	FOREIGN KEY (project_id, api_key_id) REFERENCES api_key (project_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE series_key_days IS
	'The days of a series each API key wrote and nobody has written since (053). The ingest hold leaves them out of the outlier limit it judges that key''s pushes by (series/hold.ts).';
-- Covers the key's foreign key (the primary key covers the series').
CREATE INDEX series_key_days_key_idx ON series_key_days (project_id, api_key_id);

-- A key only adds days to its own rows; a person only releases them.
CREATE FUNCTION series_key_days_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		v_key uuid := app_current_api_key_id();
	BEGIN
		IF TG_OP = 'UPDATE' AND (NEW.project_id, NEW.series_id, NEW.api_key_id) IS DISTINCT FROM (OLD.project_id, OLD.series_id, OLD.api_key_id) THEN
			RAISE EXCEPTION 'a key''s days stay with their series and key' USING ERRCODE = 'check_violation';
		END IF;
		IF v_key IS NOT NULL AND app_current_user_id() IS NULL THEN
			IF NEW.api_key_id IS DISTINCT FROM v_key THEN
				RAISE EXCEPTION 'a key records only its own days' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF TG_OP = 'UPDATE' AND NOT NEW.days @> OLD.days THEN
				RAISE EXCEPTION 'a key adds days, it never releases them' USING ERRCODE = 'check_violation';
			END IF;
		ELSIF TG_OP = 'INSERT' OR NOT NEW.days <@ OLD.days THEN
			RAISE EXCEPTION 'only a key''s own writes record its days; anyone else''s release them' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER series_key_days_guard BEFORE INSERT OR UPDATE ON series_key_days
	FOR EACH ROW EXECUTE FUNCTION series_key_days_guard();

ALTER TABLE series_key_days ENABLE ROW LEVEL SECURITY;

-- The key's own rows, on series it may write.
CREATE POLICY series_key_days_api_key_select ON series_key_days FOR SELECT
	USING (api_key_id = app_current_api_key_id() AND project_id = app_api_key_project('series:write'));
CREATE POLICY series_key_days_api_key_insert ON series_key_days FOR INSERT
	WITH CHECK (
		api_key_id = app_current_api_key_id() AND project_id = app_api_key_project('series:write')
		AND EXISTS (SELECT 1 FROM time_series t WHERE t.project_id = series_key_days.project_id AND t.id = series_key_days.series_id AND app_api_key_allows(t.kind, t.name))
	);
CREATE POLICY series_key_days_api_key_update ON series_key_days FOR UPDATE
	USING (api_key_id = app_current_api_key_id() AND project_id = app_api_key_project('series:write'))
	WITH CHECK (
		api_key_id = app_current_api_key_id() AND project_id = app_api_key_project('series:write')
		AND EXISTS (SELECT 1 FROM time_series t WHERE t.project_id = series_key_days.project_id AND t.id = series_key_days.series_id AND app_api_key_allows(t.kind, t.name))
	);

-- An editor's writes release them.
CREATE POLICY series_key_days_select ON series_key_days FOR SELECT USING (app_has_role(project_id, 'editor'));
CREATE POLICY series_key_days_update ON series_key_days FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY series_key_days_delete ON series_key_days FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON series_key_days TO water_app;
GRANT UPDATE (days) ON series_key_days TO water_app;
