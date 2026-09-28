-- 084_gauge_records — an observed flow record attached to a gauge node
-- inside the network (engine 1.4.0, issue #64; docs/model.md §2.10d,
-- docs/data-model.md § Gauge records).
--
-- Until now every flow_observed_m3s / flow_logger_m3s series was the
-- outlet's: a run read the first of each kind by name. site_node_id says a
-- series was measured at a gauge node instead. A run then gives it to the
-- engine under `<kind>@<node id>` (runs/execute.ts loadLiveInput), where
-- only the plausibility checks read it (natural flow ≥ observed + net
-- abstraction, and the dry-season low-flow curves, at that gauge). The
-- outlet's records stay the series with no site, so a project that never
-- sets one runs exactly as before.
--
-- * Only a flow record has a site (CHECK): rain and evaporation are the
--   catchment's.
-- * A plain uuid, not a foreign key to node, on purpose: deleting the gauge
--   from the model (saveModel deletes the node rows a save leaves out) must
--   neither delete the record (ON DELETE CASCADE would lose the data) nor
--   quietly make it the outlet's (ON DELETE SET NULL would change which
--   record the outlet calibrates against). The record keeps its site; the run
--   warns that its node is gone and leaves it out, and an editor moves it on
--   the Data page. Run snapshots and scenario runs name nodes by id the same
--   way (run_series.node_id since 024).
-- * Same project on write: assert_same_project (001) refuses a site that is
--   not a node of the row's project when the column is set. The API also
--   refuses a node that isn't a gauge, or is the outlet.
-- * Existing rows get NULL (the outlet), which is what they were. A new
--   column on an existing table: the table-level grants to water_app (001)
--   and time_series' policies (001, 039) already cover it; no foreign key,
--   so no covering index. Farmers never read time_series (020), so the
--   farmer-scope guard lists it as never read.

ALTER TABLE time_series
	ADD COLUMN site_node_id uuid
		CONSTRAINT time_series_site_flow_only CHECK (site_node_id IS NULL OR kind IN ('flow_observed_m3s', 'flow_logger_m3s'));

COMMENT ON COLUMN time_series.site_node_id IS
	'The gauge node a flow record was measured at (084_gauge_records, engine >= 1.4.0); NULL = the outlet. Read only by the plausibility checks. A plain uuid: the record outlives the node, and the run warns.';

CREATE TRIGGER time_series_site_same_project BEFORE INSERT OR UPDATE OF site_node_id ON time_series
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('site_node_id');

-- A run stores a gauge's record under its key, `<kind>@<node id>`
-- (run_input_series.kind is text; 021), with series_id the series it read
-- (056). run_input_series_series_kind, from its only definition (056), now
-- checks such a key's kind, the part before the @, against the series'. Not
-- its site: an editor may move the record between the run reading its
-- inputs and storing them, and the stored values are what the run used
-- either way. Every other kind is checked exactly as before.
CREATE OR REPLACE FUNCTION run_input_series_series_kind() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.series_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM time_series t
			WHERE t.project_id = NEW.project_id AND t.id = NEW.series_id
			  AND t.kind = split_part(NEW.kind, '@', 1)
		) THEN
			RAISE EXCEPTION 'a run input of kind % names a series of another kind', NEW.kind USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
