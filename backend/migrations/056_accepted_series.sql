-- 056_accepted_series — the ingest hold's reference for a series one API key
-- fills: what a person last accepted (followups.md "The ingest hold has no
-- reference for a series one key fills"; series/hold.ts; docs/security.md
-- § API keys; docs/data-model.md § Stored run inputs, § API keys).
--
-- Since 053 the hold judges a key's push by the series without that key's
-- own days. When those leave too few days for the engine's outlier rule (a
-- logger series nothing else writes), it fell back to the series without the
-- push, which the key itself shaped, so a key could still lift that limit
-- batch by batch. Now the reference for such a series is the values the
-- project's latest person-made run read from it: a key can't make a run, so
-- it can't write that. A person running the model is already what ends a
-- hold ("they have looked at the data, fixed it or accepted it"), so it is
-- the same act of acceptance.
--
-- * run_input_series gains series_id: which series each kind's input came
--   from (the first of the kind by name, runs/execute.ts loadModelInput).
--   Until now a stored input said only its kind, so "this series' accepted
--   values" had no exact answer once a series was renamed or another of the
--   kind was added. Set by storeRun for a run of the live model; NULL for a
--   scenario run (its input is its base run's, rebuilt, not a series read)
--   and for runs before this migration (no backfill: which series a past run
--   read can't be known for certain). A composite foreign key keeps it in
--   the run's project, with ON DELETE SET NULL (series_id): deleting a
--   series leaves the runs that read it their inputs, just no longer tied to
--   a series. run_input_series stays append-only for water_app (the foreign
--   key's SET NULL runs as the table's owner).
-- * run_input_series_series_kind: a reference names a series of its own kind.
-- * app_api_key_accepted_series(p_series) (SECURITY DEFINER: a key reads no
--   run, 039): in a key's transaction, for a series of its project it may
--   write, the start date and values the latest manual (person-made, not a
--   scenario's) run that read this series used; no row otherwise.

ALTER TABLE run_input_series
	ADD COLUMN series_id uuid,
	ADD CONSTRAINT run_input_series_series_fkey FOREIGN KEY (project_id, series_id)
		REFERENCES time_series (project_id, id) ON DELETE SET NULL (series_id);
-- Covers the foreign key, and is how the hold finds a series' accepted input.
CREATE INDEX run_input_series_series_idx ON run_input_series (project_id, series_id);

COMMENT ON COLUMN run_input_series.series_id IS
	'The series this input was read from (056_accepted_series); NULL for a scenario run, a run before 056, or a series since deleted.';

-- Not SECURITY DEFINER: whoever stores a run reads the project's series.
CREATE FUNCTION run_input_series_series_kind() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.series_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM time_series t WHERE t.project_id = NEW.project_id AND t.id = NEW.series_id AND t.kind = NEW.kind
		) THEN
			RAISE EXCEPTION 'a run input of kind % names a series of another kind', NEW.kind USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER run_input_series_series_kind BEFORE INSERT ON run_input_series
	FOR EACH ROW EXECUTE FUNCTION run_input_series_series_kind();

CREATE FUNCTION app_api_key_accepted_series(p_series uuid) RETURNS TABLE (start_date date, "values" double precision[])
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT i.start_date, b."values"
		FROM time_series t
		JOIN run_input_series i ON i.project_id = t.project_id AND i.series_id = t.id
		JOIN model_run r ON r.id = i.run_id
		JOIN series_blob b ON b.project_id = i.project_id AND b.sha256 = i.sha256
		WHERE t.id = p_series
		  AND t.project_id = app_api_key_project('series:write')
		  AND app_api_key_allows(t.kind, t.name)
		  AND r.trigger = 'manual' AND r.scenario_id IS NULL
		ORDER BY r.created_at DESC, r.id DESC
		LIMIT 1
	$$;

REVOKE ALL ON FUNCTION app_api_key_accepted_series(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_api_key_accepted_series(uuid) TO water_app;
